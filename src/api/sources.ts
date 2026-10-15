import { Hono, type Context } from 'hono';
import { auditStatement, requestOrigin, type AuditMetadata } from '../audit/audit';
import { diffMetadata } from '../audit/diff';
import { authorize, isFailure, type Resolved } from '../auth/workspace';
import type { Capability } from '../auth/permissions';
import { connectorFor, isProviderKind } from '../connectors/sources/registry';
import type { AuthMode } from '../connectors/sources/types';
import {
  generateEndpointId,
  generateSigningSecret,
  openSourceSecretText,
  sealSourceSecret,
  SOURCE_CREDENTIAL_COLUMNS,
  type SourceCredentialRow,
} from '../connectors/sources/generic/secret';
import { toBytes } from '../crypto/envelope';
import { keyringFromEnv } from '../crypto/keyring-env';
import type { Bindings } from '../env';
import { asRecord } from '../lib/json';
import { blob } from '../pipeline/credentials';
import { hit } from '../security/rate-limit';
import { sameSecret } from '../lib/digest';
import { readRevokeReason } from './revoke';
import { destroySettings, destroySourceKey } from '../pipeline/credential-destroy';
import { backfillSourceFingerprint } from '../pipeline/fingerprint-backfill';
import { credentialFingerprint } from '../crypto/fingerprint';
import { log } from '../platform/log';
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

export type SourceKind = 'generic' | 'gitlab' | 'stripe';

interface SourceRow {
  id: string;
  name: string;
  kind: SourceKind;
  endpoint_id: string;
  enabled: number;
  created_at: string;
  updated_at: string;
  last_received_at: string | null;
  secret_rotated_at: string | null;
  reused_id_rejections: number;
  last_reuse_rejected_at: string | null;
  auth_mode: AuthMode | null;
  livemode: number | null;
  dropped_events: number;
  last_dropped_at: string | null;
  credential_fingerprint: string | null;
  credentials_revoked_at: string | null;
  key_destroyed: number;
  integration_count: number;
}

const SELECT = `s.id,s.name,s.kind,s.endpoint_id,s.enabled,s.created_at,s.updated_at,s.last_received_at,
  s.secret_rotated_at,s.reused_id_rejections,s.last_reuse_rejected_at,s.auth_mode,s.livemode,s.dropped_events,s.last_dropped_at,
  s.credential_fingerprint,s.credentials_revoked_at,(length(s.dek_wrapped) = 0) AS key_destroyed,
  (SELECT COUNT(*) FROM integrations i WHERE i.source_id=s.id AND i.organization_id=s.organization_id) AS integration_count`;

export interface SourceView {
  readonly id: string;
  readonly name: string;
  readonly kind: SourceKind;
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
  /** GitLab only: which credential the source verifies (never the credential itself). */
  readonly authMode: AuthMode | null;
  /** Stripe only: true for live events, false for test events. */
  readonly livemode: boolean | null;
  /** Events dropped because the source exceeded its rate limit (GitLab flood policy, ADR 0015). */
  readonly droppedEvents: number;
  readonly lastDroppedAt: string | null;
  /** Keyed, tenant-scoped base32 HMAC of the secret, 8 characters, to match it in the sender's console; null without a fingerprint key or when sealed before F39. Kept after a revoke. */
  readonly credentialFingerprint: string | null;
  /** The credential was revoked (F40): the source stays off until a new secret is entered. */
  readonly revoked: boolean;
  /** Revoked and the wrapped key destroyed (F40): the sealed secret can no longer be opened by anyone. */
  readonly keyDestroyed: boolean;
  readonly integrationCount: number;
}

export function endpointUrl(appOrigin: string, endpointId: string, kind: SourceKind = 'generic'): string {
  return new URL(`/webhooks/${kind}/${endpointId}`, appOrigin).href;
}

function toView(row: SourceRow, appOrigin: string): SourceView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    endpointId: row.endpoint_id,
    endpointUrl: endpointUrl(appOrigin, row.endpoint_id, row.kind),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastReceivedAt: row.last_received_at,
    secretRotatedAt: row.secret_rotated_at,
    reusedIdRejections: row.reused_id_rejections,
    lastReuseRejectedAt: row.last_reuse_rejected_at,
    authMode: row.auth_mode,
    livemode: row.livemode === null ? null : row.livemode === 1,
    droppedEvents: row.dropped_events,
    lastDroppedAt: row.last_dropped_at,
    credentialFingerprint: row.credential_fingerprint,
    revoked: row.credentials_revoked_at !== null,
    keyDestroyed: row.credentials_revoked_at !== null && row.key_destroyed === 1,
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
  action:
    | 'source.create'
    | 'source.update'
    | 'source.delete'
    | 'source.secret.rotate'
    | 'source.credentials.revoke',
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

/** Why Sentry is not offered as a source (spec 06 F89, ADR 0015). */
const SENTRY_REFUSAL =
  'Sentry is not available as a source. Its webhook signature is documented over a re-serialised body with no replay window, which Noti does not implement without a verified capture. Use Sentry\u2019s alert integration with a chat app, or the generic source with a signed sender.';

type ProviderSecret = { secret: string; authMode: AuthMode | null; livemode: boolean | null };

/** Parse the pasted credential of a provider source, or answer 422 with field messages. */
function providerSecret(
  c: Ctx,
  kind: SourceKind,
  body: Record<string, unknown>,
  mode: 'create' | 'rotate',
): ProviderSecret | Response {
  if (!isProviderKind(kind)) return c.json({ error: 'Not a provider source.' }, 422);
  const parsed = connectorFor(kind).parseSecret(body, mode);
  return parsed.ok
    ? { secret: parsed.secret, authMode: parsed.authMode, livemode: parsed.livemode }
    : c.json({ error: 'Validation failed', fields: parsed.errors }, 422);
}

sources.post('/', async (c) => {
  const who = await mutationGate(c, 'source.create');
  if (who instanceof Response) return who;
  const read = await readJson(c);
  if (!read.ok) return read.response;
  const body = asRecord(read.body);
  const name = parseName(body?.name);
  if (!body || !name) return invalidName(c);
  const requested = body.kind ?? 'generic';
  if (requested === 'sentry')
    return c.json({ error: 'Validation failed', fields: [{ field: 'kind', message: SENTRY_REFUSAL }] }, 422);
  if (requested !== 'generic' && !isProviderKind(requested))
    return c.json(
      {
        error: 'Validation failed',
        fields: [{ field: 'kind', message: 'Choose generic, gitlab or stripe.' }],
      },
      422,
    );
  const kind: SourceKind = requested;
  const id = crypto.randomUUID();
  const endpointId = generateEndpointId();
  // Generic: we generate the secret and show it once. Providers generate their own (a GitLab
  // token, a Stripe endpoint secret): it is pasted, sealed on write and never shown again.
  let secret: string;
  let authMode: AuthMode | null = null;
  let livemode: boolean | null = null;
  if (kind === 'generic') {
    secret = generateSigningSecret();
  } else {
    const pasted = providerSecret(c, kind, body, 'create');
    if (pasted instanceof Response) return pasted;
    ({ secret, authMode, livemode } = pasted);
  }
  const sealed = await sealSourceSecret(
    { organizationId: who.orgId, sourceId: id },
    secret,
    keyringFromEnv(c.env),
    c.env.FINGERPRINT_KEY,
  );
  // The quota is part of the INSERT, so two concurrent creates cannot both pass a stale count.
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO sources(id,organization_id,kind,name,endpoint_id,secret_envelope,key_salt,dek_wrapped,
         kek_version,credential_fingerprint,enabled,created_by,auth_mode,livemode)
       SELECT ?,?,?,?,?,?,?,?,?,?,1,?,?,?
       WHERE (SELECT COUNT(*) FROM sources WHERE organization_id=?) < ?`,
    ).bind(
      id,
      who.orgId,
      kind,
      name,
      endpointId,
      sealed.secretEnvelope,
      sealed.keySalt,
      sealed.dekWrapped,
      sealed.kekVersion,
      sealed.fingerprint,
      who.userId,
      authMode,
      livemode === null ? null : livemode ? 1 : 0,
      who.orgId,
      MAX_SOURCES_PER_WORKSPACE,
    ),
    audit(c, who, 'source.create', id, {
      kind,
      ...(authMode ? { authMode } : {}),
      ...(livemode !== null ? { livemode } : {}),
    }),
  ]);
  if (results[0]?.meta.changes !== 1)
    return c.json({ error: `A workspace can have at most ${MAX_SOURCES_PER_WORKSPACE} sources.` }, 409);
  const row = await load(c, who.orgId, id);
  if (!row) return c.json({ error: 'Not found' }, 404);
  // Only a generated secret is returned. A pasted one is never echoed.
  return kind === 'generic'
    ? c.json({ source: toView(row, c.env.APP_ORIGIN), secret }, 201, NO_STORE)
    : c.json({ source: toView(row, c.env.APP_ORIGIN) }, 201, NO_STORE);
});

sources.patch('/:id', async (c) => {
  const who = await mutationGate(c, 'source.update');
  if (who instanceof Response) return who;
  const id = c.req.param('id');
  const current = await load(c, who.orgId, id);
  if (!current) return c.json({ error: 'Not found' }, 404);
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
    // A revoked source stays off until a new secret has been entered (rotate), whatever the flag says.
    if (body.enabled && current.credentials_revoked_at !== null)
      return c.json(
        {
          error: 'Validation failed',
          fields: [
            { field: 'enabled', message: 'This source was revoked. Replace its secret to turn it back on.' },
          ],
        },
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

  // Turning a source on is guarded in the statement: a revoke (or its destroy) that landed after this request
  // read the row must not be undone by an "enabled" written from the stale read. A revoked, wiped source that
  // were enabled would answer 5xx to every webhook (its secret cannot be opened).
  const turningOn = 'enabled' in body && body.enabled === true ? 1 : 0;
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE sources SET ${sets.join(',')} WHERE id=? AND organization_id=?
         AND (? = 0 OR credentials_revoked_at IS NULL)`,
    ).bind(...values, id, who.orgId, turningOn),
    audit(c, who, 'source.update', id, {
      fields: changed,
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      ...(typeof body.enabled === 'boolean'
        ? diffMetadata({ enabled: current.enabled === 1 }, { enabled: body.enabled })
        : {}),
    }),
  ]);
  if (results[0]?.meta.changes !== 1) {
    const now = await load(c, who.orgId, id);
    return now
      ? c.json({ error: 'The source changed while saving. Nothing was changed; reload and try again.' }, 409)
      : c.json({ error: 'Not found' }, 404);
  }
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
  const existing = await load(c, who.orgId, id);
  if (!existing) return c.json({ error: 'Not found' }, 404);
  // Generic: Noti generates the new secret. Providers: the new credential is pasted, because
  // GitLab and Stripe generate it. Neither is ever read back.
  let secret: string;
  let authMode: AuthMode | null = existing.auth_mode;
  let downgrade = false;
  if (existing.kind === 'generic') {
    secret = generateSigningSecret();
  } else {
    const read = await readJson(c);
    if (!read.ok) return read.response;
    const body = asRecord(read.body);
    if (!body) return c.json({ error: 'Expected a JSON object.' }, 422);
    const pasted = providerSecret(c, existing.kind, body, 'rotate');
    if (pasted instanceof Response) return pasted;
    // Moving GitLab from a signing token to the weaker plain token is a downgrade: it must be
    // asked for explicitly, not happen because a field was left on its default.
    downgrade = existing.auth_mode === 'signing_token' && pasted.authMode === 'secret_token';
    if (downgrade && body.confirmDowngrade !== true)
      return c.json(
        {
          error: 'Validation failed',
          fields: [
            {
              field: 'confirmDowngrade',
              message:
                'This replaces a signing token with a plain secret token, which cannot detect a changed message. Send confirmDowngrade: true to proceed.',
            },
          ],
        },
        422,
      );
    secret = pasted.secret;
    authMode = pasted.authMode;
  }
  // The wrapped key we saw. The UPDATE below applies only if it is still current, so a
  // concurrent rotation or the KEK rewrap job makes this a 409 instead of a lost update.
  const seen = await c.env.DB.prepare('SELECT dek_wrapped FROM sources WHERE id=? AND organization_id=?')
    .bind(id, who.orgId)
    .first<{ dek_wrapped: unknown }>();
  const seenWrap = seen ? blob(toBytes(seen.dek_wrapped)) : null;
  if (!seenWrap) return c.json({ error: 'Not found' }, 404);
  // A destroyed key is an empty blob: the guard then matches "still empty" instead of binding an empty value.
  const guardWrap = seenWrap.byteLength === 0 ? null : seenWrap;
  if (existing.credentials_revoked_at !== null && existing.kind !== 'generic') {
    // The pasted credential of a revoked provider source must be a NEW one, not the burned value again.
    const stored = await c.env.DB.prepare(
      `SELECT ${SOURCE_CREDENTIAL_COLUMNS} FROM sources WHERE id=? AND organization_id=?`,
    )
      .bind(id, who.orgId)
      .first<SourceCredentialRow>();
    const burned = stored
      ? await openSourceSecretText(stored, keyringFromEnv(c.env)).catch(() => null)
      : null;
    // Once the key is destroyed the burned value cannot be opened to compare, so the fingerprint that
    // outlives the wipe stands in for it (keyed, tenant-scoped; without FINGERPRINT_KEY there is none).
    const sameAsBurned =
      burned !== null
        ? await sameSecret(burned, secret)
        : existing.credential_fingerprint !== null &&
          existing.credential_fingerprint ===
            (await credentialFingerprint(secret, who.orgId, c.env.FINGERPRINT_KEY));
    if (sameAsBurned)
      return c.json(
        {
          error: 'Validation failed',
          fields: [
            { field: 'secret', message: 'This credential was revoked. Enter a new one, not the same value.' },
          ],
        },
        422,
      );
  }
  const sealed = await sealSourceSecret(
    { organizationId: who.orgId, sourceId: id },
    secret,
    keyringFromEnv(c.env),
    c.env.FINGERPRINT_KEY,
  );
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE sources SET secret_envelope=?,key_salt=?,dek_wrapped=?,kek_version=?,auth_mode=?,
         credential_fingerprint=?,
         enabled=CASE WHEN credentials_revoked_at IS NOT NULL THEN 1 ELSE enabled END,
         credentials_revoked_at=NULL,
         secret_rotated_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND organization_id=? AND (dek_wrapped=? OR (length(dek_wrapped)=0 AND ? IS NULL))`,
    ).bind(
      sealed.secretEnvelope,
      sealed.keySalt,
      sealed.dekWrapped,
      sealed.kekVersion,
      authMode,
      sealed.fingerprint,
      id,
      who.orgId,
      guardWrap,
      guardWrap,
    ),
    audit(c, who, 'source.secret.rotate', id, {
      kind: existing.kind,
      ...(authMode ? { authMode } : {}),
      ...(downgrade ? { downgrade: true } : {}),
    }),
  ]);
  if (results[0]?.meta.changes !== 1) {
    return (await load(c, who.orgId, id))
      ? c.json({ error: 'The source changed while rotating. Nothing was changed; try again.' }, 409)
      : c.json({ error: 'Not found' }, 404);
  }
  const row = await load(c, who.orgId, id);
  if (!row) return c.json({ error: 'Not found' }, 404);
  return existing.kind === 'generic'
    ? c.json({ source: toView(row, c.env.APP_ORIGIN), secret }, 200, NO_STORE)
    : c.json({ source: toView(row, c.env.APP_ORIGIN) }, 200, NO_STORE);
});

/**
 * Revoke a source's credentials (F40): the signing secret must be treated as burned. Admin-only.
 * The source is switched off (ingress already answers 404 for a disabled endpoint, so a sender
 * holding the burned secret gets nothing) and marked revoked, which keeps it off until a NEW secret
 * is entered with `rotate` (which seals under fresh key material and turns it back on). Repeating
 * the call is a no-op and writes no second audit entry.
 */
sources.post('/:id/revoke-credentials', async (c) => {
  const who = await mutationGate(c, 'source.revoke');
  if (who instanceof Response) return who;
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare(
    'SELECT kind,credentials_revoked_at FROM sources WHERE id=? AND organization_id=?',
  )
    .bind(id, who.orgId)
    .first<{ kind: SourceKind; credentials_revoked_at: string | null }>();
  if (!existing) return c.json({ error: 'Not found' }, 404);
  const reason = await readRevokeReason(c);
  if (reason instanceof Response) return reason;
  if (existing.credentials_revoked_at === null) {
    // `audit()` writes its row only if the UPDATE just before it changed one, so two concurrent
    // revokes leave exactly one audit entry.
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE sources SET enabled=0,credentials_revoked_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
         WHERE id=? AND organization_id=? AND credentials_revoked_at IS NULL`,
      ).bind(id, who.orgId),
      audit(c, who, 'source.credentials.revoke', id, { kind: existing.kind, reason }),
    ]);
  }
  // Finish the order revoke -> drain -> destroy when the drain window has already passed (a repeated
  // revoke); otherwise the scheduled sweep wipes the key once it has. Idempotent either way.
  try {
    // A source with no fingerprint gets one now, while its secret can still be opened (see destroyKey in integrations).
    await backfillSourceFingerprint(c.env, who.orgId, id).catch((error: unknown) =>
      log('warn', 'fingerprint_backfill_failed', { source_id: id, error }),
    );
    await destroySourceKey(
      c.env.DB,
      who.orgId,
      id,
      Date.now(),
      { actorId: who.userId, trigger: 'revoke' },
      await destroySettings(c.env),
    );
  } catch (error) {
    log('error', 'source_key_destroy_failed', { source_id: id, error });
  }
  const row = await load(c, who.orgId, id);
  return row ? c.json({ source: toView(row, c.env.APP_ORIGIN) }) : c.json({ error: 'Not found' }, 404);
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
    // Updates held for these integrations go with them (ADR 0016); the subquery must run first.
    c.env.DB.prepare(
      `DELETE FROM held_events WHERE organization_id=? AND integration_id IN
         (SELECT id FROM integrations WHERE source_id=? AND organization_id=?)`,
    ).bind(who.orgId, id, who.orgId),
    c.env.DB.prepare('DELETE FROM integrations WHERE source_id=? AND organization_id=?').bind(id, who.orgId),
    c.env.DB.prepare('DELETE FROM sources WHERE id=? AND organization_id=?').bind(id, who.orgId),
    audit(c, who, 'source.delete', id, { integrationsDeleted: existing.integration_count }),
  ]);
  if (results[2]?.meta.changes !== 1) return c.json({ error: 'Not found' }, 404);
  return c.body(null, 204);
});

export default sources;
