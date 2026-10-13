import { Hono, type Context } from 'hono';
import { recordAudit, requestOrigin } from '../audit/audit';
import { authorize, isFailure, type Resolved } from '../auth/workspace';
import { can, type Capability } from '../auth/permissions';
import { redeliver } from '../delivery/redeliver';
import { normalizeDeliveryState, type DeliveryState } from '../delivery/state';
import type { Bindings } from '../env';
import { log } from '../platform/log';
import {
  deriveTimeline,
  encodeCursor,
  parseListFilters,
  sqlTimeToIso,
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

const SELECT_VIEW = `
  d.id, d.integration_id, d.state, d.attempts, d.last_error_code, d.replay_of,
  d.created_at, d.updated_at, d.first_attempt_at, d.last_attempt_at, d.next_attempt_at,
  d.dead_lettered_at,
  i.name AS integration_name, i.repo AS integration_repo,
  i.destination AS integration_destination, i.destination_host AS integration_destination_host,
  (SELECT r.state FROM deliveries r
     WHERE r.replay_of = d.id AND r.organization_id = d.organization_id
     ORDER BY r.rowid DESC LIMIT 1) AS latest_replay_state`;

const FROM_VIEW = `FROM deliveries d
  LEFT JOIN integrations i ON i.id = d.integration_id AND i.organization_id = d.organization_id`;

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

async function rateLimited(c: Ctx, userId: string): Promise<Response | null> {
  const windowStart = Math.floor(Date.now() / 60_000) * 60_000;
  const row = await c.env.DB.prepare(
    `INSERT INTO api_rate_limits(key,window_start,count) VALUES(?,?,1)
     ON CONFLICT(key,window_start) DO UPDATE SET count=count+1
     RETURNING count`,
  )
    .bind(`deliveries:${userId}`, windowStart)
    .first<{ count: number }>();
  if ((row?.count ?? 0) <= MUTATIONS_PER_MINUTE) return null;
  const retryAfter = Math.ceil((windowStart + 60_000 - Date.now()) / 1000);
  return c.json({ error: 'Too many changes; try again shortly' }, 429, { 'retry-after': String(retryAfter) });
}

const deliveries = new Hono<{ Bindings: Bindings }>();

deliveries.get('/', async (c) => {
  const who = await gate(c, 'delivery.read');
  if (who instanceof Response) return who;
  const parsed = parseListFilters((name) => c.req.query(name));
  if (!parsed.ok) return c.json({ error: 'Validation failed', fields: parsed.fields }, 422);
  const f = parsed.value;

  const where = ['d.organization_id = ?'];
  const values: (string | number)[] = [who.orgId];
  if (f.state === 'dead_lettered') where.push("d.state IN ('dead_lettered','failed')");
  else if (f.state) {
    where.push('d.state = ?');
    values.push(f.state);
  }
  if (f.integrationId) {
    where.push('d.integration_id = ?');
    values.push(f.integrationId);
  }
  if (f.from) {
    where.push('d.updated_at >= ?');
    values.push(f.from);
  }
  if (f.to) {
    where.push('d.updated_at <= ?');
    values.push(f.to);
  }
  if (f.cursor) {
    where.push('(d.updated_at < ? OR (d.updated_at = ? AND d.id < ?))');
    values.push(f.cursor.updatedAt, f.cursor.updatedAt, f.cursor.id);
  }

  const rows = await c.env.DB.prepare(
    `SELECT ${SELECT_VIEW} ${FROM_VIEW} WHERE ${where.join(' AND ')}
     ORDER BY d.updated_at DESC, d.id DESC LIMIT ?`,
  )
    .bind(...values, f.limit + 1)
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
  const since = new Date(Date.now() - SUMMARY_WINDOW_MS).toISOString().slice(0, 19).replace('T', ' ');
  const rows = await c.env.DB.prepare(
    `SELECT state, COUNT(*) AS n FROM deliveries
     WHERE organization_id = ? AND COALESCE(created_at, updated_at) >= ?
     GROUP BY state`,
  )
    .bind(who.orgId, since)
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
  return c.json({
    delivery: toDeliveryView(row, can(who.role, 'delivery.replay')),
    // F184 (a per-attempt table) is not built: this is what the row itself records, no more.
    timeline: deriveTimeline(row),
    attemptDetail: 'summary',
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
} as const;

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
  const limited = await rateLimited(c, who.userId);
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

  const result = await redeliver(c.env.DB, { organizationId: who.orgId, deliveryId: id });
  if (!result.ok) {
    const refusal = REFUSALS[result.error];
    return c.json({ error: refusal.error, reason: result.error }, refusal.status);
  }
  if (result.created) {
    try {
      await recordAudit(c.env.DB, {
        organizationId: who.orgId,
        actorId: who.userId,
        action: 'delivery.replay',
        subjectType: 'delivery',
        subjectId: id,
        outcome: 'success',
        ...requestOrigin(c.req.raw.headers),
        metadata: { replayDeliveryId: result.deliveryId },
      });
    } catch {
      // The replay is already durable and cannot be undone; say so loudly instead of
      // pretending it did not happen. The log carries ids only.
      log('error', 'delivery_replay_audit_failed', { organization_id: who.orgId, delivery_id: id });
    }
  }
  return c.json(
    { replay: { deliveryId: result.deliveryId, replayOf: result.replayOf, created: result.created } },
    result.created ? 202 : 200,
  );
});

export default deliveries;
