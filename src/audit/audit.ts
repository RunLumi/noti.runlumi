/**
 * Append-only audit events (docs/specs/02-identity-tenancy.md F28).
 *
 * Callers pass structured metadata built from values we control (ids, enum names, counts,
 * hostnames). Free text, URLs with paths and credentials never belong here; the type below
 * only admits primitives and string arrays, and the serialised size is capped.
 */
export type AuditAction =
  | 'integration.create'
  | 'integration.update'
  | 'integration.delete'
  | 'integration.credentials.rotate'
  | 'source.create'
  | 'source.update'
  | 'source.delete'
  | 'source.secret.rotate'
  | 'delivery.replay'
  | 'access.denied'
  | 'github.installation.bind'
  | 'github.installation.bind_refused'
  | 'github.installation.lifecycle'
  | 'github.repository.out_of_scope'
  | 'workspace.export'
  | 'workspace.deletion.request'
  | 'workspace.deletion.cancel'
  | 'workspace.purged';

export type AuditMetadata = Readonly<Record<string, string | number | boolean | null | readonly string[]>>;

export interface AuditEntry {
  readonly organizationId: string | null;
  readonly actorId: string | null;
  readonly action: AuditAction;
  readonly subjectType:
    | 'integration'
    | 'source'
    | 'delivery'
    | 'organization'
    | 'capability'
    | 'github_installation'
    | 'repository';
  readonly subjectId: string | null;
  readonly outcome: 'success' | 'denied';
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly metadata?: AuditMetadata;
}

const MAX_METADATA_BYTES = 4096;
const MAX_USER_AGENT = 256;

/** Serialise metadata, dropping it (not truncating JSON into garbage) if it is too large. */
export function serialiseMetadata(metadata: AuditMetadata | undefined): string {
  const json = JSON.stringify(metadata ?? {});
  return new TextEncoder().encode(json).length <= MAX_METADATA_BYTES ? json : '{"truncated":true}';
}

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
  options: { readonly onlyIfPreviousStatementChangedRows?: boolean } = {},
): D1PreparedStatement {
  // `changes()` is the row count of the statement just before this one in the batch: put the
  // audit row right after the INSERT it describes and it exists only if that insert did.
  const guard = options.onlyIfPreviousStatementChangedRows
    ? ' WHERE changes() > 0'
    : ifIntegrationExists
      ? ' WHERE EXISTS (SELECT 1 FROM integrations WHERE id=? AND organization_id=?)'
      : '';
  const guardValues =
    ifIntegrationExists && !options.onlyIfPreviousStatementChangedRows
      ? [ifIntegrationExists.id, ifIntegrationExists.organizationId]
      : [];
  return db
    .prepare(
      `INSERT INTO audit_events(id,organization_id,actor_id,action,subject_type,subject_id,outcome,ip,user_agent,metadata_json)
       SELECT ?,?,?,?,?,?,?,?,?,?${guard}`,
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
      entry.userAgent ? entry.userAgent.slice(0, MAX_USER_AGENT) : null,
      serialiseMetadata(entry.metadata),
      ...guardValues,
    );
}

export async function recordAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  await auditStatement(db, entry).run();
}

const DENIAL_DEDUPE_SECONDS = 60;

/**
 * Record a denial without letting it become a weapon: identical denials by the same actor
 * within a minute collapse into one row, and a failed write never changes the response
 * (a 500 where a 404 was due would itself leak that the target exists).
 */
export async function recordDenial(db: D1Database, entry: AuditEntry): Promise<void> {
  try {
    const recent = await db
      .prepare(
        `SELECT 1 AS x FROM audit_events
         WHERE action='access.denied' AND actor_id IS ? AND organization_id IS ? AND subject_id IS ?
           AND created_at >= datetime('now', ?) LIMIT 1`,
      )
      .bind(entry.actorId, entry.organizationId, entry.subjectId, `-${DENIAL_DEDUPE_SECONDS} seconds`)
      .first();
    if (!recent) await recordAudit(db, entry);
  } catch {
    console.error(JSON.stringify({ event: 'audit_write_failed', action: entry.action }));
  }
}

/** Request attribution. `cf-connecting-ip` is set by Cloudflare's edge, not the client. */
export function requestOrigin(headers: Headers): { ip: string | null; userAgent: string | null } {
  return { ip: headers.get('cf-connecting-ip'), userAgent: headers.get('user-agent') };
}
