import { Hono, type Context } from 'hono';
import { recordAudit, requestOrigin } from '../audit/audit';
import { authorize, isFailure, type Resolved } from '../auth/workspace';
import { can, type Capability } from '../auth/permissions';
import { listAttempts } from '../delivery/attempts';
import {
  BULK_REPLAY_MAX,
  BULK_TYPED_CONFIRMATION_THRESHOLD,
  planBulkReplay,
  runBulkReplay,
  type BulkFilter,
} from '../delivery/bulk-replay';
import { redeliver } from '../delivery/redeliver';
import { normalizeDeliveryState, type DeliveryState } from '../delivery/state';
import type { Bindings } from '../env';
import { hit } from '../security/rate-limit';
import { FROM_VIEW, SELECT_VIEW, SUMMARY_SQL, buildListQuery } from './delivery-queries';
import {
  deriveTimeline,
  encodeCursor,
  parseBound,
  parseListFilters,
  sqlTimeToIso,
  toAttemptView,
  toDeliveryView,
  type DeliveryRowRecord,
} from './delivery-view';
import { MUTATIONS_PER_MINUTE } from './integrations';
import { isDeletionPending } from './workspace-lifecycle';

/**
 * Delivery log and manual redelivery (F181/F182, docs/specs/14-dashboard-and-ux.md).
 *
 * Every query is `organization_id = <resolved workspace>`; a delivery in another workspace
 * is indistinguishable from a missing one (404). Responses carry ids, states, counts,
 * timestamps and a taxonomy code — never a payload, a webhook URL or a secret. The
 * `integrations` join repeats the tenant check, so a stale `integration_id` can never pull
 * another workspace's name into the log.
 */
type Ctx = Context<{ Bindings: Bindings }>;

const SUMMARY_WINDOW_MS = 24 * 60 * 60 * 1000;

async function gate(c: Ctx, capability: Capability): Promise<Resolved | Response> {
  const resolved = await authorize(c, capability);
  return isFailure(resolved) ? c.json({ error: resolved.error }, resolved.status) : resolved;
}

/** Cookie-authenticated mutation: our Origin and a JSON content type (F23), as in the integrations API. */
function mutationRejected(c: Ctx): Response | null {
  const origin = c.req.header('origin');
  if (!origin || origin !== new URL(c.env.APP_ORIGIN).origin) return c.json({ error: 'Forbidden' }, 403);
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json'))
    return c.json({ error: 'Expected application/json' }, 415);
  return null;
}

const WINDOW_MS = 60_000;
/** Reads are cheap but unbounded callers are not; the ceiling is far above what a person clicks. */
const READS_PER_MINUTE = 300;

async function rateLimited(c: Ctx, userId: string, scope: 'read' | 'write'): Promise<Response | null> {
  const result =
    scope === 'write'
      ? await hit(c.env.DB, `deliveries:${userId}`, MUTATIONS_PER_MINUTE, WINDOW_MS)
      : await hit(c.env.DB, `deliveries:read:${userId}`, READS_PER_MINUTE, WINDOW_MS);
  if (!result.limited) return null;
  return c.json({ error: 'Too many requests; try again shortly' }, 429, {
    'retry-after': String(result.retryAfterSeconds),
  });
}

const deliveries = new Hono<{ Bindings: Bindings }>();

deliveries.get('/', async (c) => {
  const who = await gate(c, 'delivery.read');
  if (who instanceof Response) return who;
  const limitedRead = await rateLimited(c, who.userId, 'read');
  if (limitedRead) return limitedRead;
  const parsed = parseListFilters((name) => c.req.query(name));
  if (!parsed.ok) return c.json({ error: 'Validation failed', fields: parsed.fields }, 422);
  const f = parsed.value;

  const query = buildListQuery(who.orgId, f);
  const rows = await c.env.DB.prepare(query.sql)
    .bind(...query.values)
    .all<DeliveryRowRecord>();

  const page = rows.results.slice(0, f.limit);
  const last = page.at(-1);
  const mayReplay = can(who.role, 'delivery.replay');
  return c.json({
    organizationId: who.orgId,
    deliveries: page.map((row) => toDeliveryView(row, mayReplay)),
    nextCursor: rows.results.length > f.limit && last ? encodeCursor(last.updated_at, last.id) : null,
    // At-least-once: the log never claims exactly-once. The dashboard shows this wording.
    guarantee: 'at_least_once',
  });
});

/** Counts by state for the last 24 hours, for the Overview. Nothing here is estimated. */
deliveries.get('/summary', async (c) => {
  const who = await gate(c, 'delivery.read');
  if (who instanceof Response) return who;
  const limitedRead = await rateLimited(c, who.userId, 'read');
  if (limitedRead) return limitedRead;
  const since = new Date(Date.now() - SUMMARY_WINDOW_MS).toISOString().slice(0, 19).replace('T', ' ');
  const rows = await c.env.DB.prepare(SUMMARY_SQL)
    .bind(who.orgId, since, since)
    .all<{ state: string; n: number }>();
  const counts: Record<DeliveryState, number> = {
    pending: 0,
    claimed: 0,
    sent: 0,
    accepted: 0,
    retrying: 0,
    dead_lettered: 0,
    suppressed: 0,
  };
  for (const row of rows.results) counts[normalizeDeliveryState(row.state)] += row.n;
  return c.json({ organizationId: who.orgId, windowHours: 24, counts });
});

deliveries.get('/:id', async (c) => {
  const who = await gate(c, 'delivery.read');
  if (who instanceof Response) return who;
  const limitedRead = await rateLimited(c, who.userId, 'read');
  if (limitedRead) return limitedRead;
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT ${SELECT_VIEW} ${FROM_VIEW} WHERE d.id = ? AND d.organization_id = ?`,
  )
    .bind(id, who.orgId)
    .first<DeliveryRowRecord>();
  if (!row) return c.json({ error: 'Not found' }, 404);
  const replays = await c.env.DB.prepare(
    `SELECT id, state, created_at, updated_at FROM deliveries
     WHERE replay_of = ? AND organization_id = ? ORDER BY rowid DESC LIMIT 20`,
  )
    .bind(id, who.orgId)
    .all<{ id: string; state: string; created_at: string | null; updated_at: string }>();
  // F184: one row per attempt (and per deferral), oldest first. Rows older than migration 0025 have
  // none, which `attemptDetail: 'summary'` says: the coarse timeline is all there is for them.
  const attempts = await listAttempts(c.env.DB, who.orgId, id);
  const hideProviderDetail = row.is_test === 1 && row.integration_destination === 'generic_webhook';
  return c.json({
    delivery: toDeliveryView(row, can(who.role, 'delivery.replay')),
    timeline: deriveTimeline(row),
    attempts: attempts.map((a) => toAttemptView(a, hideProviderDetail)),
    attemptDetail: attempts.length > 0 ? 'full' : 'summary',
    replays: replays.results.map((r) => ({
      id: r.id,
      state: normalizeDeliveryState(r.state),
      createdAt: sqlTimeToIso(r.created_at ?? r.updated_at),
    })),
    guarantee: 'at_least_once',
  });
});

const REFUSALS = {
  not_found: { status: 404, error: 'Not found' },
  already_delivered: { status: 409, error: 'This delivery already reached its destination.' },
  not_replayable: { status: 409, error: 'Only a failed delivery can be redelivered.' },
  payload_unavailable: { status: 409, error: 'The original message is no longer available to redeliver.' },
  integration_unavailable: {
    status: 409,
    error:
      'The integration for this delivery is deleted, paused or needs its credentials fixed. Fix it first, then redeliver.',
  },
  deletion_pending: {
    status: 409,
    error: 'This workspace is scheduled for deletion. Cancel the deletion to make changes.',
  },
} as const;

/** Bulk replay is rare and expensive (up to 200 replays): far below the single-replay rate. */
const BULK_PER_MINUTE = 6;

interface BulkBody {
  readonly filter: BulkFilter;
  readonly token: string | null;
  readonly expectedCount: number | null;
}

/** The body is untrusted JSON; every field is optional and bounded. */
async function parseBulkBody(c: Ctx): Promise<BulkBody | Response> {
  const raw: unknown = await c.req.json().catch(() => null);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return c.json(
      { error: 'Validation failed', fields: [{ field: 'body', message: 'Expected an object.' }] },
      422,
    );
  const body = raw as Record<string, unknown>;
  const fields: { field: string; message: string }[] = [];
  const text = (name: string, max: number): string | null => {
    const v = body[name];
    if (v === undefined || v === null || v === '') return null;
    if (typeof v === 'string' && v.length <= max) return v;
    fields.push({ field: name, message: 'Invalid value.' });
    return null;
  };
  const integrationId = text('integrationId', 64);
  const from = text('from', 40);
  const to = text('to', 40);
  const token = text('token', 64);
  const lower = from ? parseBound(from, 'start') : null;
  if (from && lower === null) fields.push({ field: 'from', message: 'Use a date like 2026-10-13.' });
  const upper = to ? parseBound(to, 'end') : null;
  if (to && upper === null) fields.push({ field: 'to', message: 'Use a date like 2026-10-13.' });
  const count = body.expectedCount;
  const expectedCount =
    typeof count === 'number' && Number.isInteger(count) && count >= 0 && count <= BULK_REPLAY_MAX
      ? count
      : null;
  if (count !== undefined && expectedCount === null)
    fields.push({ field: 'expectedCount', message: 'Invalid value.' });
  if (fields.length > 0) return c.json({ error: 'Validation failed', fields }, 422);
  return { filter: { integrationId, from: lower, to: upper }, token, expectedCount };
}

async function rateLimitedBulk(c: Ctx, userId: string): Promise<Response | null> {
  const result = await hit(c.env.DB, `deliveries:bulk:${userId}`, BULK_PER_MINUTE, WINDOW_MS);
  if (!result.limited) return null;
  return c.json({ error: 'Too many requests; try again shortly' }, 429, {
    'retry-after': String(result.retryAfterSeconds),
  });
}

/**
 * Step 1 of a bulk replay (F182): how many dead-lettered deliveries a replay would send, for a
 * workspace, optionally one integration and a time window. Reads only; returns a token that binds
 * the exact set shown.
 */
deliveries.post('/replay-plan', async (c) => {
  const rejected = mutationRejected(c);
  if (rejected) return rejected;
  const who = await gate(c, 'delivery.replay');
  if (who instanceof Response) return who;
  const limited = await rateLimitedBulk(c, who.userId);
  if (limited) return limited;
  const body = await parseBulkBody(c);
  if (body instanceof Response) return body;
  const plan = await planBulkReplay(c.env.DB, who.orgId, body.filter);
  return c.json({
    plan: {
      eligible: plan.ids.length,
      total: plan.total,
      totalCapped: plan.totalCapped,
      remaining: Math.max(0, plan.total - plan.ids.length),
      bound: BULK_REPLAY_MAX,
      token: plan.token,
      typedConfirmationAbove: BULK_TYPED_CONFIRMATION_THRESHOLD,
    },
  });
});

const BULK_REFUSALS = {
  plan_stale: {
    status: 409,
    error: 'The list of failed deliveries changed since you looked. Review the new count and try again.',
  },
  nothing_to_replay: {
    status: 409,
    error: 'There are no failed deliveries to send again for this selection.',
  },
  count_mismatch: { status: 422, error: 'The number you confirmed does not match. Nothing was sent.' },
} as const;

/**
 * Step 2: replay the planned set. Needs the plan's token and the confirmed count; refuses (and writes
 * nothing) if the eligible set is no longer exactly the one shown, so a double submit or a changed
 * backlog cannot replay more than was previewed.
 */
deliveries.post('/replay', async (c) => {
  const rejected = mutationRejected(c);
  if (rejected) return rejected;
  const who = await gate(c, 'delivery.replay');
  if (who instanceof Response) return who;
  if (await isDeletionPending(c.env.DB, who.orgId))
    return c.json(
      { error: 'This workspace is scheduled for deletion. Cancel the deletion to make changes.' },
      409,
    );
  const limited = await rateLimitedBulk(c, who.userId);
  if (limited) return limited;
  const body = await parseBulkBody(c);
  if (body instanceof Response) return body;
  if (body.token === null || body.expectedCount === null)
    return c.json(
      {
        error: 'Validation failed',
        fields: [{ field: body.token === null ? 'token' : 'expectedCount', message: 'Required.' }],
      },
      422,
    );
  const outcome = await runBulkReplay(c.env.DB, {
    organizationId: who.orgId,
    filter: body.filter,
    token: body.token,
    expectedCount: body.expectedCount,
  });
  if (!outcome.ok) {
    const refusal = BULK_REFUSALS[outcome.error];
    return c.json(
      { error: refusal.error, reason: outcome.error, eligible: outcome.eligible },
      refusal.status,
    );
  }
  const r = outcome.result;
  // One audit row with the counts and the filter; each new delivery carries `replay_of`.
  await recordAudit(c.env.DB, {
    organizationId: who.orgId,
    actorId: who.userId,
    action: 'delivery.bulk_replay',
    subjectType: 'delivery',
    subjectId: null,
    outcome: 'success',
    ...requestOrigin(c.req.raw.headers),
    metadata: {
      requested: r.requested,
      replayed: r.replayed,
      alreadyInFlight: r.alreadyInFlight,
      refused: r.refused,
      remaining: r.remaining,
      ...(body.filter.integrationId ? { integrationId: body.filter.integrationId } : {}),
      ...(body.filter.from ? { from: body.filter.from } : {}),
      ...(body.filter.to ? { to: body.filter.to } : {}),
    },
  });
  if (r.deletionPending)
    return c.json(
      { error: 'This workspace is scheduled for deletion. Cancel the deletion to make changes.', result: r },
      409,
    );
  return c.json({ result: r }, 202);
});

deliveries.post('/:id/replay', async (c) => {
  const rejected = mutationRejected(c);
  if (rejected) return rejected;
  const who = await gate(c, 'delivery.replay');
  if (who instanceof Response) return who;
  if (await isDeletionPending(c.env.DB, who.orgId))
    return c.json(
      { error: 'This workspace is scheduled for deletion. Cancel the deletion to make changes.' },
      409,
    );
  const limited = await rateLimited(c, who.userId, 'write');
  if (limited) return limited;

  const id = c.req.param('id');
  // Idempotent by outcome: while a replay of this delivery is in flight or has succeeded, a
  // second request returns it instead of sending the message a second time.
  const latest = await c.env.DB.prepare(
    `SELECT r.id, r.state FROM deliveries r
     WHERE r.replay_of = ? AND r.organization_id = ? ORDER BY r.rowid DESC LIMIT 1`,
  )
    .bind(id, who.orgId)
    .first<{ id: string; state: string }>();
  if (latest && normalizeDeliveryState(latest.state) !== 'dead_lettered')
    return c.json({ replay: { deliveryId: latest.id, replayOf: id, created: false } }, 200);

  const result = await redeliver(c.env.DB, {
    organizationId: who.orgId,
    deliveryId: id,
    // The audit row commits in the same batch as the replay, and only if the replay was made.
    audit: { actorId: who.userId, ...requestOrigin(c.req.raw.headers) },
  });
  if (!result.ok) {
    const refusal = REFUSALS[result.error];
    return c.json({ error: refusal.error, reason: result.error }, refusal.status);
  }
  return c.json(
    { replay: { deliveryId: result.deliveryId, replayOf: result.replayOf, created: result.created } },
    result.created ? 202 : 200,
  );
});

export default deliveries;
