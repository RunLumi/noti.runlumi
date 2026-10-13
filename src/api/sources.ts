import { Hono, type Context } from 'hono';
import { auditStatement, requestOrigin, type AuditMetadata } from '../audit/audit';
import { authorize, isFailure, type Resolved } from '../auth/workspace';
import type { Capability } from '../auth/permissions';
import {
  generateEndpointId,
  generateSigningSecret,
  sealSourceSecret,
} from '../connectors/sources/generic/secret';
import { toBytes } from '../crypto/envelope';
import { keyringFromEnv } from '../crypto/keyring-env';
import type { Bindings } from '../env';
import { asRecord } from '../lib/json';
import { blob } from '../pipeline/credentials';
import { hit } from '../security/rate-limit';
import { isDeletionPending } from './workspace-lifecycle';

/**
 * Tenant-scoped generic sources API (ADR 0012). Every query carries `organization_id =
 * <resolved workspace>`; another workspace's source is indistinguishable from a missing one
 * (404). The signing secret is returned exactly twice in the lifetime of a secret — in the
 * 201 of create and in the 200 of rotate — and never by any read, list or export.
 */
type Ctx = Context<{ Bindings: Bindings }>;

const MAX_BODY_BYTES = 4 * 1024;
const LIST_LIMIT = 100;
/** Per-workspace ceiling. A product limit, not a security control. */
export const MAX_SOURCES_PER_WORKSPACE = 25;
/** Abuse limit on mutations, per user, per minute. */
export const SOURCE_MUTATIONS_PER_MINUTE = 20;
const NAME_MAX = 80;
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

interface SourceRow {
  id: string;
  name: string;
  kind: 'generic';
  endpoint_id: string;
  enabled: number;
  created_at: string;
  updated_at: string;
  last_received_at: string | null;
  secret_rotated_at: string | null;
  reused_id_rejections: number;
  last_reuse_rejected_at: string | null;
  integration_count: number;
}

const SELECT = `s.id,s.name,s.kind,s.endpoint_id,s.enabled,s.created_at,s.updated_at,s.last_received_at,
  s.secret_rotated_at,s.reused_id_rejections,s.last_reuse_rejected_at,
  (SELECT COUNT(*) FROM integrations i WHERE i.source_id=s.id AND i.organization_id=s.organization_id) AS integration_count`;

export interface SourceView {
  readonly id: string;
  readonly name: string;
  readonly kind: 'generic';
  readonly endpointId: string;
  /** Absolute ingest URL. The endpoint id is public by design; the signature authorizes. */
  readonly endpointUrl: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastReceivedAt: string | null;
  readonly secretRotatedAt: string | null;
  /** Events refused because their webhook-id was already used with a different body. */
  readonly reusedIdRejections: number;
  readonly lastReuseRejectedAt: string | null;
  readonly integrationCount: number;
}

export function endpointUrl(appOrigin: string, endpointId: string): string {
  return new URL(`/webhooks/generic/${endpointId}`, appOrigin).href;
}

function toView(row: SourceRow, appOrigin: string): SourceView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    endpointId: row.endpoint_id,
    endpointUrl: endpointUrl(appOrigin, row.endpoint_id),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastReceivedAt: row.last_received_at,
    secretRotatedAt: row.secret_rotated_at,
    reusedIdRejections: row.reused_id_rejections,
    lastReuseRejectedAt: row.last_reuse_rejected_at,
    integrationCount: row.integration_count,
  };
}

/** Defence in depth beside the central middleware; also the shape the static guard looks for. */
function originRejected(c: Ctx): Response | null {
  const origin = c.req.header('origin');
  return !origin || origin !== new URL(c.env.APP_ORIGIN).origin ? c.json({ error: 'Forbidden' }, 403) : null;
}

async function gate(c: Ctx, capability: Capability): Promise<Resolved | Response> {
  const resolved = await authorize(c, capability);
  return isFailure(resolved) ? c.json({ error: resolved.error }, resolved.status) : resolved;
}

async function mutationGate(c: Ctx, capability: Capability): Promise<Resolved | Response> {
  const rejected = originRejected(c);
  if (rejected) return rejected;
  const who = await gate(c, capability);
  if (who instanceof Response) return who;
  if (await isDeletionPending(c.env.DB, who.orgId))
    return c.json(
      { error: 'This workspace is scheduled for deletion. Cancel the deletion to make changes.' },
      409,
    );
  const limited = await hit(c.env.DB, `sources:${who.userId}`, SOURCE_MUTATIONS_PER_MINUTE, 60_000);
  return limited.limited
    ? c.json({ error: 'Too many changes; try again shortly' }, 429, {
        'retry-after': String(limited.retryAfterSeconds),
      })
    : who;
}

async function readJson(c: Ctx): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json'))
    return { ok: false, response: c.json({ error: 'Expected application/json' }, 415) };
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

function parseName(value: unknown): string | null {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= NAME_MAX &&
    !CONTROL.test(value)
    ? value.trim()
    : null;
}

const invalidName = (c: Ctx): Response =>
  c.json(
    { error: 'Validation failed', fields: [{ field: 'name', message: `Use 1–${NAME_MAX} characters.` }] },
    422,
  );

async function load(c: Ctx, orgId: string, id: string): Promise<SourceRow | null> {
  return c.env.DB.prepare(`SELECT ${SELECT} FROM sources s WHERE s.id=? AND s.organization_id=?`)
    .bind(id, orgId)
    .first<SourceRow>();
}

/** Audit right after the statement it describes: it exists only if that statement changed a row. */
function audit(
  c: Ctx,
  who: Resolved,
  action: 'source.create' | 'source.update' | 'source.delete' | 'source.secret.rotate',
  id: string,
  metadata: AuditMetadata,
) {
  return auditStatement(
    c.env.DB,
    {
      organizationId: who.orgId,
      actorId: who.userId,
      action,
      subjectType: 'source',
      subjectId: id,
      outcome: 'success',
      ...requestOrigin(c.req.raw.headers),
      metadata,
    },
    undefined,
    { onlyIfPreviousStatementChangedRows: true },
  );
}

/** A secret must never be cached by a browser, proxy or service worker. */
const NO_STORE = { 'cache-control': 'no-store' } as const;

const sources = new Hono<{ Bindings: Bindings }>();

sources.get('/', async (c) => {
  const who = await gate(c, 'source.read');
  if (who instanceof Response) return who;
  const rows = await c.env.DB.prepare(
    `SELECT ${SELECT} FROM sources s WHERE s.organization_id=? ORDER BY s.created_at DESC, s.id LIMIT ?`,
  )
    .bind(who.orgId, LIST_LIMIT)
    .all<SourceRow>();
  return c.json({ sources: rows.results.map((r) => toView(r, c.env.APP_ORIGIN)) });
});

sources.get('/:id', async (c) => {
  const who = await gate(c, 'source.read');
  if (who instanceof Response) return who;
  const row = await load(c, who.orgId, c.req.param('id'));
  return row ? c.json({ source: toView(row, c.env.APP_ORIGIN) }) : c.json({ error: 'Not found' }, 404);
});

sources.post('/', async (c) => {
  const who = await mutationGate(c, 'source.create');
  if (who instanceof Response) return who;
  const read = await readJson(c);
  if (!read.ok) return read.response;
  const body = asRecord(read.body);
  const name = parseName(body?.name);
  if (!body || !name) return invalidName(c);
  const id = crypto.randomUUID();
  const endpointId = generateEndpointId();
  const secret = generateSigningSecret();
  const sealed = await sealSourceSecret(
    { organizationId: who.orgId, sourceId: id },
    secret,
    keyringFromEnv(c.env),
  );
  // The quota is part of the INSERT, so two concurrent creates cannot both pass a stale count.
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO sources(id,organization_id,kind,name,endpoint_id,secret_envelope,key_salt,dek_wrapped,
         kek_version,enabled,created_by)
       SELECT ?,?,'generic',?,?,?,?,?,?,1,?
       WHERE (SELECT COUNT(*) FROM sources WHERE organization_id=?) < ?`,
    ).bind(
      id,
      who.orgId,
      name,
      endpointId,
      sealed.secretEnvelope,
      sealed.keySalt,
      sealed.dekWrapped,
      sealed.kekVersion,
      who.userId,
      who.orgId,
      MAX_SOURCES_PER_WORKSPACE,
    ),
    audit(c, who, 'source.create', id, { kind: 'generic' }),
  ]);
  if (results[0]?.meta.changes !== 1)
    return c.json({ error: `A workspace can have at most ${MAX_SOURCES_PER_WORKSPACE} sources.` }, 409);
  const row = await load(c, who.orgId, id);
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ source: toView(row, c.env.APP_ORIGIN), secret }, 201, NO_STORE);
});

sources.patch('/:id', async (c) => {
  const who = await mutationGate(c, 'source.update');
  if (who instanceof Response) return who;
  const id = c.req.param('id');
  if (!(await load(c, who.orgId, id))) return c.json({ error: 'Not found' }, 404);
  const read = await readJson(c);
  if (!read.ok) return read.response;
  const body = asRecord(read.body);
  if (!body) return c.json({ error: 'Expected a JSON object.' }, 422);
  const unknownField = Object.keys(body).find((k) => k !== 'name' && k !== 'enabled');
  if (unknownField)
    return c.json(
      {
        error: 'Validation failed',
        fields: [{ field: unknownField, message: 'This field cannot be changed.' }],
      },
      422,
    );
  const sets: string[] = ['updated_at=CURRENT_TIMESTAMP'];
  const values: (string | number)[] = [];
  const changed: string[] = [];
  if ('name' in body) {
    const name = parseName(body.name);
    if (!name) return invalidName(c);
    sets.push('name=?');
    values.push(name);
    changed.push('name');
  }
  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean')
      return c.json(
        { error: 'Validation failed', fields: [{ field: 'enabled', message: 'Must be true or false.' }] },
        422,
      );
    sets.push('enabled=?');
    values.push(body.enabled ? 1 : 0);
    changed.push('enabled');
  }
  if (changed.length === 0)
    return c.json(
      { error: 'Validation failed', fields: [{ field: 'body', message: 'Nothing to change.' }] },
      422,
    );

  const results = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE sources SET ${sets.join(',')} WHERE id=? AND organization_id=?`).bind(
      ...values,
      id,
      who.orgId,
    ),
    audit(c, who, 'source.update', id, {
      fields: changed,
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
    }),
  ]);
  if (results[0]?.meta.changes !== 1) return c.json({ error: 'Not found' }, 404);
  const row = await load(c, who.orgId, id);
  return row ? c.json({ source: toView(row, c.env.APP_ORIGIN) }) : c.json({ error: 'Not found' }, 404);
});

/**
 * Rotation re-seals under FRESH key material and replaces the row's credential columns in
 * one UPDATE: the previous secret is invalid the moment this commits. There is deliberately
 * no overlap window (ADR 0012): the sender must be updated first or immediately after.
 */
sources.post('/:id/rotate', async (c) => {
  const who = await mutationGate(c, 'source.rotate');
  if (who instanceof Response) return who;
  const id = c.req.param('id');
  if (!(await load(c, who.orgId, id))) return c.json({ error: 'Not found' }, 404);
  // The wrapped key we saw. The UPDATE below applies only if it is still current, so a
  // concurrent rotation or the KEK rewrap job makes this a 409 instead of a lost update.
  const seen = await c.env.DB.prepare('SELECT dek_wrapped FROM sources WHERE id=? AND organization_id=?')
    .bind(id, who.orgId)
    .first<{ dek_wrapped: unknown }>();
  const seenWrap = seen ? blob(toBytes(seen.dek_wrapped)) : null;
  if (!seenWrap) return c.json({ error: 'Not found' }, 404);
  const secret = generateSigningSecret();
  const sealed = await sealSourceSecret(
    { organizationId: who.orgId, sourceId: id },
    secret,
    keyringFromEnv(c.env),
  );
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE sources SET secret_envelope=?,key_salt=?,dek_wrapped=?,kek_version=?,
         secret_rotated_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND organization_id=? AND dek_wrapped=?`,
    ).bind(
      sealed.secretEnvelope,
      sealed.keySalt,
      sealed.dekWrapped,
      sealed.kekVersion,
      id,
      who.orgId,
      seenWrap,
    ),
    audit(c, who, 'source.secret.rotate', id, {}),
  ]);
  if (results[0]?.meta.changes !== 1) {
    return (await load(c, who.orgId, id))
      ? c.json({ error: 'The source changed while rotating. Nothing was changed; try again.' }, 409)
      : c.json({ error: 'Not found' }, 404);
  }
  const row = await load(c, who.orgId, id);
  return row
    ? c.json({ source: toView(row, c.env.APP_ORIGIN), secret }, 200, NO_STORE)
    : c.json({ error: 'Not found' }, 404);
});

/**
 * Deleting a source deletes the integrations bound to it (they have nothing left to route),
 * only with `?cascade=true`,
 * and, with the row, its wrapped DEK: the sealed secret becomes unrecoverable.
 */
sources.delete('/:id', async (c) => {
  const who = await mutationGate(c, 'source.delete');
  if (who instanceof Response) return who;
  const id = c.req.param('id');
  const existing = await load(c, who.orgId, id);
  if (!existing) return c.json({ error: 'Not found' }, 404);
  // Deleting also deletes the bound integrations and their saved webhook URLs, so it must be
  // asked for explicitly; otherwise nothing is touched and the count is reported.
  if (existing.integration_count > 0 && c.req.query('cascade') !== 'true')
    return c.json(
      {
        error: `This source has ${existing.integration_count} connected chat(s). Delete them with it by passing cascade=true.`,
        integrations: existing.integration_count,
      },
      409,
    );
  const results = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM integrations WHERE source_id=? AND organization_id=?').bind(id, who.orgId),
    c.env.DB.prepare('DELETE FROM sources WHERE id=? AND organization_id=?').bind(id, who.orgId),
    audit(c, who, 'source.delete', id, { integrationsDeleted: existing.integration_count }),
  ]);
  if (results[1]?.meta.changes !== 1) return c.json({ error: 'Not found' }, 404);
  return c.body(null, 204);
});

export default sources;
