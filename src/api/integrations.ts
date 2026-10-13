import { Hono, type Context } from 'hono';
import { auditStatement, requestOrigin, type AuditMetadata } from '../audit/audit';
import { authorize, isFailure, type Resolved } from '../auth/workspace';
import type { Capability } from '../auth/permissions';
import { eventCatalogFor } from '../connectors/sources/registry';
import { keyringFromEnv } from '../crypto/keyring-env';
import type { Bindings } from '../env';
import { sealCredentials, blob, type DestinationCredentials } from '../pipeline/credentials';
import type { DestinationKind } from '../pipeline/allowlist';
import { parseCreateIntegration, parseUpdateIntegration, type FieldError } from './integration-input';
import { canonicalRepository, REPO_NOT_CONNECTED } from './repo-scope';
import { isDeletionPending } from './workspace-lifecycle';
import {
  activeFilterIds,
  changedFilterIds,
  coverageIssue,
  coverageWarnings,
  readStoredFilters,
  serializeFilters,
} from '../routing/filter-input';
import type { FilterConfig } from '../routing/filters';

/**
 * Tenant-scoped integrations API (F26). Every query carries `organization_id = <resolved
 * workspace>`; a row in another workspace is indistinguishable from a missing one (404).
 * Responses never include a URL or a secret — only the destination hostname.
 */
export type Ctx = Context<{ Bindings: Bindings }>;

const MAX_BODY_BYTES = 16 * 1024;
const LIST_LIMIT = 200;
/** Per-workspace ceiling. A product limit, not a security control; raise it deliberately. */
export const MAX_INTEGRATIONS_PER_WORKSPACE = 100;
/** Abuse limit on mutations, per user, per minute. */
export const MUTATIONS_PER_MINUTE = 30;

/**
 * A source integration may select event types only from the catalogue of its source's kind.
 * The generic kind has no catalogue (its types are free-form labels), so selecting any is an
 * error; an empty selection always means "every event the source sends".
 */
function sourceEventTypeError(kind: string, selected: readonly string[]): FieldError | null {
  if (selected.length === 0) return null;
  const catalog = eventCatalogFor(kind);
  if (!catalog)
    return {
      field: 'eventTypes',
      message: 'This source sends free-form events and cannot be filtered by type.',
    };
  return selected.every((t) => catalog.includes(t))
    ? null
    : { field: 'eventTypes', message: 'Contains an event type this source does not offer.' };
}

interface IntegrationRow {
  id: string;
  name: string | null;
  repo: string;
  source_id: string | null;
  event_types: string;
  destination: DestinationKind;
  destination_host: string | null;
  enabled: number;
  created_at: string | null;
  updated_at: string | null;
  credentials_quarantined_at: string | null;
  credentials_quarantine_reason: string | null;
  filters_json: string | null;
  sealed: number;
}

const SELECT_COLUMNS = `id,name,repo,source_id,event_types,destination,destination_host,enabled,created_at,updated_at,
  credentials_quarantined_at,credentials_quarantine_reason,filters_json,(webhook_envelope IS NOT NULL) AS sealed`;

export interface IntegrationView {
  readonly id: string;
  readonly name: string;
  /** Empty for a source integration, which has no repository. */
  readonly repo: string;
  /** The generic source this integration routes from, or null for a GitHub integration. */
  readonly sourceId: string | null;
  readonly eventTypes: readonly string[];
  readonly destination: DestinationKind;
  readonly destinationHost: string | null;
  readonly enabled: boolean;
  readonly credentials: 'ok' | 'legacy' | 'quarantined';
  /** Routing filters; `{}` when none. A stored document that no longer validates reads as `{}`. */
  readonly filters: FilterConfig;
  /**
   * True when the stored filters are corrupt or no longer valid. Events for this integration
   * are HELD BACK (fail closed) until the filters are replaced.
   */
  readonly filtersInvalid: boolean;
  /** True when the stored filters were written by a newer release (rollback): sent unfiltered. */
  readonly filtersNewer: boolean;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

function eventTypesOf(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

export function toView(row: IntegrationRow): IntegrationView {
  const stored = readStoredFilters(row.filters_json);
  return {
    id: row.id,
    name: row.name ?? row.repo,
    repo: row.source_id ? '' : row.repo,
    sourceId: row.source_id,
    eventTypes: eventTypesOf(row.event_types),
    destination: row.destination,
    destinationHost: row.destination_host,
    enabled: row.enabled === 1,
    credentials: row.credentials_quarantined_at ? 'quarantined' : row.sealed ? 'ok' : 'legacy',
    filters: stored.kind === 'ok' ? stored.config : {},
    filtersInvalid: stored.kind === 'invalid',
    filtersNewer: stored.kind === 'newer',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * CSRF defence for cookie-authenticated mutations (F23): the browser's Origin must be ours
 * and the body must be JSON, which a cross-site form cannot send without a preflight.
 */
export function mutationRejected(c: Ctx): Response | null {
  const origin = c.req.header('origin');
  if (!origin || origin !== new URL(c.env.APP_ORIGIN).origin) return c.json({ error: 'Forbidden' }, 403);
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json'))
    return c.json({ error: 'Expected application/json' }, 415);
  return null;
}

export async function readJson(
  c: Ctx,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  // Refuse on the declared length before buffering; re-check the bytes actually read.
  if (Number(c.req.header('content-length') ?? 0) > MAX_BODY_BYTES)
    return { ok: false, response: c.json({ error: 'Too large' }, 413) };
  const text = await c.req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES)
    return { ok: false, response: c.json({ error: 'Too large' }, 413) };
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: c.json({ error: 'Invalid JSON' }, 400) };
  }
}

export function invalid(c: Ctx, errors: FieldError[]): Response {
  return c.json({ error: 'Validation failed', fields: errors }, 422);
}

export async function gate(c: Ctx, capability: Capability): Promise<Resolved | Response> {
  const resolved = await authorize(c, capability);
  return isFailure(resolved) ? c.json({ error: resolved.error }, resolved.status) : resolved;
}

/**
 * Fixed-window mutation limit per user. One UPSERT both counts and reads, so concurrent
 * requests cannot all observe a stale count.
 */
export async function rateLimited(
  c: Ctx,
  userId: string,
  scope = 'integrations',
  limit = MUTATIONS_PER_MINUTE,
): Promise<Response | null> {
  const windowStart = Math.floor(Date.now() / 60_000) * 60_000;
  const row = await c.env.DB.prepare(
    `INSERT INTO api_rate_limits(key,window_start,count) VALUES(?,?,1)
     ON CONFLICT(key,window_start) DO UPDATE SET count=count+1
     RETURNING count`,
  )
    .bind(`${scope}:${userId}`, windowStart)
    .first<{ count: number }>();
  if ((row?.count ?? 0) <= limit) return null;
  const retryAfter = Math.ceil((windowStart + 60_000 - Date.now()) / 1000);
  return c.json({ error: 'Too many changes; try again shortly' }, 429, { 'retry-after': String(retryAfter) });
}

async function mutationGate(c: Ctx, capability: Capability): Promise<Resolved | Response> {
  const rejected = mutationRejected(c);
  if (rejected) return rejected;
  const who = await gate(c, capability);
  if (who instanceof Response) return who;
  if (await isDeletionPending(c.env.DB, who.orgId))
    return c.json(
      { error: 'This workspace is scheduled for deletion. Cancel the deletion to make changes.' },
      409,
    );
  return (await rateLimited(c, who.userId)) ?? who;
}

export async function loadRow(c: Ctx, orgId: string, id: string): Promise<IntegrationRow | null> {
  return c.env.DB.prepare(`SELECT ${SELECT_COLUMNS} FROM integrations WHERE id=? AND organization_id=?`)
    .bind(id, orgId)
    .first<IntegrationRow>();
}

function audit(
  c: Ctx,
  who: Resolved,
  action: Parameters<typeof auditStatement>[1]['action'],
  id: string,
  metadata: AuditMetadata,
  guarded = true,
) {
  return auditStatement(
    c.env.DB,
    {
      organizationId: who.orgId,
      actorId: who.userId,
      action,
      subjectType: 'integration',
      subjectId: id,
      outcome: 'success',
      ...requestOrigin(c.req.raw.headers),
      metadata,
    },
    // Create has nothing to guard on: the row and its audit entry are inserted together.
    guarded ? { id, organizationId: who.orgId } : undefined,
  );
}

async function seal(c: Ctx, orgId: string, id: string, credentials: DestinationCredentials) {
  return sealCredentials({ organizationId: orgId, connectionId: id }, credentials, keyringFromEnv(c.env));
}

/** The filters currently stored, or `{}` when none or unreadable. */
function currentFilters(row: IntegrationRow): FilterConfig {
  const stored = readStoredFilters(row.filters_json);
  return stored.kind === 'ok' ? stored.config : {};
}

const integrations = new Hono<{ Bindings: Bindings }>();

integrations.get('/', async (c) => {
  const who = await gate(c, 'integration.read');
  if (who instanceof Response) return who;
  const rows = await c.env.DB.prepare(
    `SELECT ${SELECT_COLUMNS} FROM integrations WHERE organization_id=? ORDER BY created_at DESC, id LIMIT ?`,
  )
    .bind(who.orgId, LIST_LIMIT + 1)
    .all<IntegrationRow>();
  const truncated = rows.results.length > LIST_LIMIT;
  return c.json({
    organizationId: who.orgId,
    integrations: rows.results.slice(0, LIST_LIMIT).map(toView),
    truncated,
  });
});

integrations.get('/:id', async (c) => {
  const who = await gate(c, 'integration.read');
  if (who instanceof Response) return who;
  const row = await loadRow(c, who.orgId, c.req.param('id'));
  return row ? c.json({ integration: toView(row) }) : c.json({ error: 'Not found' }, 404);
});

integrations.post('/', async (c) => {
  const who = await mutationGate(c, 'integration.create');
  if (who instanceof Response) return who;
  const read = await readJson(c);
  if (!read.ok) return read.response;
  const parsed = parseCreateIntegration(read.body);
  if (!parsed.ok) return invalid(c, parsed.errors);

  let repo: string | null;
  let storedEventTypes: readonly string[] = parsed.value.eventTypes;
  if (parsed.value.sourceId) {
    // The source must belong to this workspace; another workspace's source is "not found".
    const owned = await c.env.DB.prepare('SELECT id,kind FROM sources WHERE id=? AND organization_id=?')
      .bind(parsed.value.sourceId, who.orgId)
      .first<{ id: string; kind: string }>();
    if (!owned) return invalid(c, [{ field: 'sourceId', message: 'Choose one of your sources.' }]);
    const selected = parsed.value.sourceEventTypes ?? [];
    const typeError = sourceEventTypeError(owned.kind, selected);
    if (typeError) return invalid(c, [typeError]);
    storedEventTypes = selected;
    // A value no GitHub owner/name can equal, so repository routing can never select it.
    repo = `source:${parsed.value.sourceId}`;
  } else {
    repo = await canonicalRepository(c.env.DB, who.orgId, parsed.value.repo);
    if (!repo) return invalid(c, [{ field: 'repo', message: REPO_NOT_CONNECTED }]);
  }
  const input = { ...parsed.value, repo };
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM integrations WHERE organization_id=?')
    .bind(who.orgId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_INTEGRATIONS_PER_WORKSPACE)
    return c.json(
      { error: `A workspace can have at most ${MAX_INTEGRATIONS_PER_WORKSPACE} integrations.` },
      409,
    );
  const id = crypto.randomUUID();
  const sealed = await seal(c, who.orgId, id, {
    webhookUrl: input.webhookUrl,
    signingSecret: input.signingSecret,
  });
  const host = new URL(input.webhookUrl).hostname;

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO integrations(id,organization_id,name,repo,source_id,event_types,destination,destination_host,
         webhook_ciphertext,key_salt,dek_wrapped,kek_version,webhook_envelope,lark_secret_envelope,
         enabled,created_by,created_at,updated_at,filters_json)
       VALUES(?,?,?,?,?,?,?,?,'',?,?,?,?,?,1,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?)`,
    ).bind(
      id,
      who.orgId,
      input.name,
      input.repo,
      input.sourceId ?? null,
      JSON.stringify(storedEventTypes),
      input.destination,
      host,
      blob(sealed.keySalt),
      blob(sealed.dekWrapped),
      sealed.kekVersion,
      blob(sealed.webhookEnvelope),
      blob(sealed.signingSecretEnvelope),
      who.userId,
      serializeFilters(input.filters),
    ),
    audit(
      c,
      who,
      'integration.create',
      id,
      {
        ...(input.sourceId ? { sourceId: input.sourceId } : { repo: input.repo }),
        destination: input.destination,
        destinationHost: host,
        eventTypes: storedEventTypes,
        signed: input.signingSecret !== null,
        // Ids only: filter values (branch names, logins, labels) never enter the audit log.
        filters: activeFilterIds(input.filters),
      },
      false,
    ),
  ]);

  const row = await loadRow(c, who.orgId, id);
  return c.json(
    { integration: row ? toView(row) : null, warnings: coverageWarnings(input.filters, input.eventTypes) },
    201,
  );
});

integrations.patch('/:id', async (c) => {
  const who = await mutationGate(c, 'integration.update');
  if (who instanceof Response) return who;
  const id = c.req.param('id');
  const existing = await loadRow(c, who.orgId, id);
  if (!existing) return c.json({ error: 'Not found' }, 404);
  const read = await readJson(c);
  if (!read.ok) return read.response;
  const parsed = parseUpdateIntegration(read.body, existing.destination, existing.source_id !== null);
  if (!parsed.ok) return invalid(c, parsed.errors);
  if (existing.source_id && (parsed.value.repo !== undefined || parsed.value.filters !== undefined))
    return invalid(c, [
      {
        field: parsed.value.repo !== undefined ? 'repo' : 'filters',
        message: 'This integration receives events from its source; this cannot be changed.',
      },
    ]);
  if (existing.source_id && parsed.value.sourceEventTypes !== undefined) {
    const owner = await c.env.DB.prepare('SELECT kind FROM sources WHERE id=? AND organization_id=?')
      .bind(existing.source_id, who.orgId)
      .first<{ kind: string }>();
    const typeError = owner ? sourceEventTypeError(owner.kind, parsed.value.sourceEventTypes) : null;
    if (!owner || typeError)
      return invalid(c, [typeError ?? { field: 'eventTypes', message: 'This source no longer exists.' }]);
  }
  let input = parsed.value;
  if (input.repo !== undefined) {
    const repo = await canonicalRepository(c.env.DB, who.orgId, input.repo);
    if (!repo) return invalid(c, [{ field: 'repo', message: REPO_NOT_CONNECTED }]);
    input = { ...input, repo };
  }

  // The filters and subscribed events that will be in force after this change must fit together.
  const effectiveEvents = input.eventTypes ?? eventTypesOf(existing.event_types);
  const effectiveFilters = input.filters ?? currentFilters(existing);
  if (input.filters !== undefined || input.eventTypes !== undefined) {
    const issue = coverageIssue(effectiveFilters, effectiveEvents);
    if (issue) return invalid(c, [issue]);
  }

  type SqlValue = string | number | ArrayBuffer | null;
  const assignments: [column: string, value: SqlValue][] = [];
  if (input.name !== undefined) assignments.push(['name', input.name]);
  if (input.repo !== undefined) assignments.push(['repo', input.repo]);
  if (input.eventTypes !== undefined) assignments.push(['event_types', JSON.stringify(input.eventTypes)]);
  if (input.sourceEventTypes !== undefined)
    assignments.push(['event_types', JSON.stringify(input.sourceEventTypes)]);
  if (input.enabled !== undefined) assignments.push(['enabled', input.enabled ? 1 : 0]);
  if (input.filters !== undefined) assignments.push(['filters_json', serializeFilters(input.filters)]);
  const sets: string[] = ['updated_at=CURRENT_TIMESTAMP'];
  const values: SqlValue[] = [];
  for (const [column, value] of assignments) {
    sets.push(`${column}=?`);
    values.push(value);
  }

  const statements = [];
  if (input.credentials) {
    // Fresh key material on every rotation: the old DEK is discarded with the old ciphertext,
    // so nothing sealed before can be opened with what is stored after (F40-style shredding).
    const sealed = await seal(c, who.orgId, id, input.credentials);
    sets.push(
      "webhook_ciphertext=''",
      'lark_secret_ciphertext=NULL',
      'key_salt=?',
      'dek_wrapped=?',
      'kek_version=?',
      'webhook_envelope=?',
      'lark_secret_envelope=?',
      'destination_host=?',
      'credentials_quarantined_at=NULL',
      'credentials_quarantine_reason=NULL',
    );
    values.push(
      blob(sealed.keySalt),
      blob(sealed.dekWrapped),
      sealed.kekVersion,
      blob(sealed.webhookEnvelope),
      blob(sealed.signingSecretEnvelope),
      new URL(input.credentials.webhookUrl).hostname,
    );
    statements.push(
      audit(c, who, 'integration.credentials.rotate', id, {
        destinationHost: new URL(input.credentials.webhookUrl).hostname,
        signed: input.credentials.signingSecret !== null,
        clearedQuarantine: existing.credentials_quarantined_at !== null,
      }),
    );
  }

  const changed = Object.keys(input)
    .filter((k) => k !== 'credentials')
    .map((k) => (k === 'sourceEventTypes' ? 'eventTypes' : k));
  if (changed.length) {
    statements.push(
      audit(c, who, 'integration.update', id, {
        fields: changed,
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.eventTypes ? { eventTypes: input.eventTypes } : {}),
        ...(input.sourceEventTypes ? { eventTypes: input.sourceEventTypes } : {}),
        ...(input.repo ? { repo: input.repo } : {}),
        ...(input.filters ? { filters: changedFilterIds(currentFilters(existing), input.filters) } : {}),
      }),
    );
  }

  // Audits run first and only if the row still exists, so a concurrent delete yields 404
  // and no false "success" entry.
  const results = await c.env.DB.batch([
    ...statements,
    c.env.DB.prepare(`UPDATE integrations SET ${sets.join(',')} WHERE id=? AND organization_id=?`).bind(
      ...values,
      id,
      who.orgId,
    ),
  ]);
  if (results.at(-1)?.meta.changes !== 1) return c.json({ error: 'Not found' }, 404);
  const row = await loadRow(c, who.orgId, id);
  return row
    ? c.json({ integration: toView(row), warnings: coverageWarnings(effectiveFilters, effectiveEvents) })
    : c.json({ error: 'Not found' }, 404);
});

integrations.delete('/:id', async (c) => {
  // A DELETE has no body, so only the Origin half of the CSRF check applies.
  const origin = c.req.header('origin');
  if (!origin || origin !== new URL(c.env.APP_ORIGIN).origin) return c.json({ error: 'Forbidden' }, 403);
  const gated = await gate(c, 'integration.delete');
  if (gated instanceof Response) return gated;
  if (await isDeletionPending(c.env.DB, gated.orgId))
    return c.json(
      { error: 'This workspace is scheduled for deletion. Cancel the deletion to make changes.' },
      409,
    );
  const limited = await rateLimited(c, gated.userId);
  if (limited) return limited;
  const who = gated;
  const id = c.req.param('id');
  const existing = await loadRow(c, who.orgId, id);
  if (!existing) return c.json({ error: 'Not found' }, 404);
  // Deleting the row deletes its wrapped DEK, so every ciphertext it sealed becomes
  // unrecoverable (crypto-shredding). Delivery history keeps ids and states only.
  const results = await c.env.DB.batch([
    audit(c, who, 'integration.delete', id, { repo: existing.repo, destination: existing.destination }),
    // Routing provenance for this integration goes with it, in the same transaction.
    c.env.DB.prepare('DELETE FROM routing_decisions WHERE integration_id=? AND organization_id=?').bind(
      id,
      who.orgId,
    ),
    c.env.DB.prepare('DELETE FROM integrations WHERE id=? AND organization_id=?').bind(id, who.orgId),
  ]);
  if (results.at(-1)?.meta.changes !== 1) return c.json({ error: 'Not found' }, 404);
  return c.body(null, 204);
});

export default integrations;
