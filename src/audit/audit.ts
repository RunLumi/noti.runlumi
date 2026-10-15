/**
 * Append-only audit events (docs/specs/02-identity-tenancy.md F28).
 *
 * Callers pass structured metadata built from values we control (ids, enum names, counts,
 * hostnames). Free text, URLs with paths and credentials never belong here; the type below
 * only admits primitives and string arrays, and the serialised size is capped.
 */
export { AUDIT_ACTIONS, AUDIT_SUBJECT_TYPES, type AuditAction } from './actions';
import type { AUDIT_SUBJECT_TYPES, AuditAction } from './actions';
import { currentCorrelationId } from '../platform/correlation';
import { sanitiseCorrelationId } from '../platform/correlation-id';
import { log } from '../platform/log';
import { scrubSecrets } from '../platform/redact';

export type AuditMetadata = Readonly<Record<string, string | number | boolean | null | readonly string[]>>;

export interface AuditEntry {
  readonly organizationId: string | null;
  readonly actorId: string | null;
  readonly action: AuditAction;
  readonly subjectType: (typeof AUDIT_SUBJECT_TYPES)[number];
  readonly subjectId: string | null;
  readonly outcome: 'success' | 'denied';
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly metadata?: AuditMetadata;
}

const MAX_METADATA_BYTES = 4096;
const MAX_USER_AGENT = 256;

/**
 * Serialise metadata, dropping it (not truncating JSON into garbage) if it is too large.
 *
 * Every string value passes through the secret scrubber first (F12, ADR 0039): a URL keeps only its host, a
 * token-shaped value or a `key=value` pair with a denied key is replaced. Keys are fixed identifiers in the
 * code and are not scrubbed.
 */
export function serialiseMetadata(metadata: AuditMetadata | undefined): string {
  const scrubbed = Object.fromEntries(
    Object.entries(metadata ?? {}).map(([key, value]) => [
      key,
      typeof value === 'string'
        ? scrubSecrets(value)
        : Array.isArray(value)
          ? value.map((item: string) => scrubSecrets(item))
          : value,
    ]),
  );
  const json = JSON.stringify(scrubbed);
  return new TextEncoder().encode(json).length <= MAX_METADATA_BYTES ? json : '{"truncated":true}';
}

/**
 * Metadata columns that add one count, read in the same batch as the change (`countAs` below). Each is a
 * fixed expression with three parameters: the serialised metadata, the key, and the workspace id that
 * scopes the count. Only literals live here, so nothing a request sends can reach the SQL text.
 */
const AUDIT_COUNTS = {
  /** The integrations a workspace deletion request switched off: the size of the snapshot it stored. */
  deletionSnapshot:
    'json_patch(?, json_object(?, (SELECT json_array_length(disabled_integration_ids) FROM workspace_deletions WHERE organization_id = ?)))',
} as const;
export type AuditCount = keyof typeof AUDIT_COUNTS;

/**
 * A statement for `db.batch`, so an audit row commits with the change it describes.
 *
 * With `ifIntegrationExists`, the row is written only if that integration exists in that
 * workspace when the statement runs. Put it *before* the mutation in the batch, so a row
 * deleted concurrently produces neither a change nor a false "success" audit entry.
 */
export function auditStatement(
  db: D1Database,
  entry: AuditEntry,
  ifIntegrationExists?: { id: string; organizationId: string },
  options: {
    readonly onlyIfPreviousStatementChangedRows?: boolean;
    /**
     * Record the previous statement's row count as `{ <key>: n }` in the metadata, computed by SQLite in the
     * same batch so it is exact. Implies the changed-rows guard. `key` is a fixed identifier, never input.
     */
    readonly changesAs?: string;
    /**
     * Add `{ <key>: n }` to the metadata, where `n` is one of the fixed counts in {@link AUDIT_COUNTS}, read by
     * SQLite in the same batch, so it describes exactly the state the change produced. `key` is a fixed
     * identifier, never input; `organizationId` scopes the count.
     */
    readonly countAs?: {
      readonly key: string;
      readonly count: AuditCount;
      readonly organizationId: string;
    };
  } = {},
): D1PreparedStatement {
  const identifier = /^[a-z][A-Za-z]{0,31}$/;
  if (options.changesAs !== undefined && !identifier.test(options.changesAs))
    throw new Error('changesAs must be a plain identifier');
  if (options.countAs !== undefined && !identifier.test(options.countAs.key))
    throw new Error('countAs.key must be a plain identifier');
  if (options.countAs !== undefined && options.changesAs !== undefined)
    throw new Error('changesAs and countAs cannot be combined');
  const metadataColumn =
    options.changesAs !== undefined
      ? 'json_object(?, changes())'
      : options.countAs !== undefined
        ? AUDIT_COUNTS[options.countAs.count]
        : '?';
  const metadataValues =
    options.changesAs !== undefined
      ? [options.changesAs]
      : options.countAs !== undefined
        ? [serialiseMetadata(entry.metadata), options.countAs.key, options.countAs.organizationId]
        : [serialiseMetadata(entry.metadata)];
  const guardRows = options.onlyIfPreviousStatementChangedRows || options.changesAs !== undefined;
  // `changes()` is the row count of the statement just before this one in the batch: put the
  // audit row right after the INSERT it describes and it exists only if that insert did.
  const guard = guardRows
    ? ' WHERE changes() > 0'
    : ifIntegrationExists
      ? ' WHERE EXISTS (SELECT 1 FROM integrations WHERE id=? AND organization_id=?)'
      : '';
  const guardValues =
    ifIntegrationExists && !guardRows ? [ifIntegrationExists.id, ifIntegrationExists.organizationId] : [];
  return db
    .prepare(
      `INSERT INTO audit_events(id,organization_id,actor_id,action,subject_type,subject_id,outcome,ip,user_agent,metadata_json,correlation_id)
       SELECT ?,?,?,?,?,?,?,?,?,${metadataColumn},?${guard}`,
    )
    .bind(
      crypto.randomUUID(),
      entry.organizationId,
      entry.actorId,
      entry.action,
      entry.subjectType,
      entry.subjectId,
      entry.outcome,
      entry.ip ?? null,
      entry.userAgent ? scrubSecrets(entry.userAgent).slice(0, MAX_USER_AGENT) : null,
      ...metadataValues,
      // The request this change was made in (F222), so a support quote of the id finds it. Null in a
      // cron job or queue consumer with no request; never a sender-supplied value.
      sanitiseCorrelationId(currentCorrelationId()),
      ...guardValues,
    );
}

/** Rows per statement in `enabledIntegrationAudits`: 2 bound values each plus 8 shared, under D1's 100. */
const AUDIT_ROWS_PER_STATEMENT = 40;

/**
 * One audit row per listed integration that is STILL ENABLED when the statement runs, written by a few
 * multi-row statements instead of one per integration (a workspace may have 100 integrations and a Worker
 * invocation has a small D1 query budget). Put it right BEFORE the UPDATE that pauses them in the same
 * batch: both see the same rows, so an integration someone else paused first gets no false entry.
 * Metadata is scrubbed exactly as in `auditStatement`.
 */
export function enabledIntegrationAudits(
  db: D1Database,
  entry: Omit<AuditEntry, 'subjectType' | 'subjectId' | 'organizationId'> & {
    readonly organizationId: string;
  },
  integrationIds: readonly string[],
): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < integrationIds.length; i += AUDIT_ROWS_PER_STATEMENT)
    out.push(enabledIntegrationAuditChunk(db, entry, integrationIds.slice(i, i + AUDIT_ROWS_PER_STATEMENT)));
  return out;
}

function enabledIntegrationAuditChunk(
  db: D1Database,
  entry: Omit<AuditEntry, 'subjectType' | 'subjectId' | 'organizationId'> & {
    readonly organizationId: string;
  },
  chunk: readonly string[],
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events(id,organization_id,actor_id,action,subject_type,subject_id,outcome,ip,user_agent,metadata_json,correlation_id)
       SELECT v.column1,i.organization_id,?,?,'integration',i.id,?,?,?,?,?
       FROM (VALUES ${chunk.map(() => '(?,?)').join(',')}) AS v
       JOIN integrations i ON i.id=v.column2
       WHERE i.organization_id=? AND i.enabled=1`,
    )
    .bind(
      entry.actorId,
      entry.action,
      entry.outcome,
      entry.ip ?? null,
      entry.userAgent ? scrubSecrets(entry.userAgent).slice(0, MAX_USER_AGENT) : null,
      serialiseMetadata(entry.metadata),
      sanitiseCorrelationId(currentCorrelationId()),
      ...chunk.flatMap((id) => [crypto.randomUUID(), id]),
      entry.organizationId,
    );
}

export async function recordAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  await auditStatement(db, entry).run();
}

/** `ops_state` key counting audit rows that could not be written; surfaced as a readiness warning. */
export const AUDIT_FAILURE_KEY = 'audit_write_failures';
/** A failure this recent makes `/health/ready` warn. */
export const AUDIT_FAILURE_WINDOW_MS = 60 * 60 * 1000;

/** Count a failed audit write. Best effort: a failure to count is itself swallowed. */
export async function noteAuditFailure(
  db: Pick<D1Database, 'prepare'>,
  nowMs: number = Date.now(),
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO ops_state(key,value,updated_at) VALUES(?1,'1',?2)
         ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT), updated_at=excluded.updated_at`,
      )
      .bind(AUDIT_FAILURE_KEY, nowMs)
      .run();
  } catch {
    // Nothing more can be done; the log line is the signal of last resort.
  }
}

/** The number of failed audit writes if one happened within the window, else 0. */
export async function recentAuditFailures(
  db: Pick<D1Database, 'prepare'>,
  nowMs: number = Date.now(),
): Promise<number> {
  const row = await db
    .prepare('SELECT value, updated_at FROM ops_state WHERE key=?1')
    .bind(AUDIT_FAILURE_KEY)
    .first<{ value: string; updated_at: number }>();
  return row && nowMs - Number(row.updated_at) < AUDIT_FAILURE_WINDOW_MS ? Number(row.value) || 0 : 0;
}

const DENIAL_DEDUPE_SECONDS = 60;

export interface DenialOptions {
  /** How long an identical denial (same action, actor, workspace and subject) collapses into one row. */
  readonly dedupeSeconds?: number;
  /**
   * Asked only when no identical denial exists yet, so a repeat never spends a budget. Return false to
   * skip the write (a cap). A throwing gate skips it too; the response is never affected.
   */
  readonly gate?: () => Promise<boolean>;
}

/**
 * Record a denial without letting it become a weapon: identical denials by the same actor
 * within a minute collapse into one row, and a failed write never changes the response
 * (a 500 where a 404 was due would itself leak that the target exists).
 */
export async function recordDenial(
  db: D1Database,
  entry: AuditEntry,
  options: DenialOptions = {},
): Promise<void> {
  try {
    const recent = await db
      .prepare(
        `SELECT 1 AS x FROM audit_events
         WHERE action=? AND actor_id IS ? AND organization_id IS ? AND subject_id IS ?
           AND created_at >= datetime('now', ?) LIMIT 1`,
      )
      .bind(
        entry.action,
        entry.actorId,
        entry.organizationId,
        entry.subjectId,
        `-${options.dedupeSeconds ?? DENIAL_DEDUPE_SECONDS} seconds`,
      )
      .first();
    if (!recent && (options.gate ? await options.gate() : true)) await recordAudit(db, entry);
  } catch {
    log('error', 'audit_write_failed', { action: entry.action });
    await noteAuditFailure(db);
  }
}

/** Request attribution. `cf-connecting-ip` is set by Cloudflare's edge, not the client. */
export function requestOrigin(headers: Headers): { ip: string | null; userAgent: string | null } {
  return { ip: headers.get('cf-connecting-ip'), userAgent: headers.get('user-agent') };
}
