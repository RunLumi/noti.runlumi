import { dedupKey, deliveryId as deriveDeliveryId } from '../delivery/ids';
import { COMBINED_COUNT_MAX, type Bindings, type DeliveryMessage } from '../env';
import { log } from '../platform/log';
import { HELD_CAPACITY } from '../routing/noise';
import { renderDigest, renderGroup, type HeldItem } from '../routing/noise-render';
import { purgeNoise } from '../routing/noise-store';

/**
 * Release held events (docs/adr/0016-noise-control.md). Runs from the every-minute cron.
 *
 * Safety properties, each covered by a test:
 *  - BOUNDED: at most {@link UNITS_PER_TICK} integrations per tick and {@link HELD_CAPACITY}
 *    rows per integration (the per-integration cap at ingress makes that the whole backlog).
 *  - LEASED: due rows are claimed with a token and an expiry; a crashed run's claim expires and
 *    the rows are claimable again, so nothing is stranded.
 *  - ATOMIC: for one notification, the delivery row, its outbox row and the "released" marks of
 *    the rows it covers commit in ONE D1 batch, and the delivery insert is itself guarded on the claim still being
 *    ours. A row is therefore never released without a delivery, and a run that lost its lease
 *    creates nothing.
 *  - IDEMPOTENT: a second run finds nothing due; a single held event is released under its own
 *    deterministic delivery id, so even a provider redelivery cannot duplicate it.
 *  - NORMAL DELIVERIES: the result is an ordinary delivery plus outbox row, so retries,
 *    dead-lettering, replay and audit all apply unchanged.
 */

/** Integrations released per tick; the rest are due next minute. */
export const UNITS_PER_TICK = 20;
/** Long enough for one batch, shorter than the 5-minute stall the observability job reports. */
export const RELEASE_LEASE_MS = 120_000;
const EXPIRED_RECLAIM_LIMIT = 500;

export interface ReleaseReport {
  /** Integrations released this tick. */
  readonly units: number;
  /** Notifications created (groups, singles and digests). */
  readonly notifications: number;
  /** Held events marked released. */
  readonly events: number;
  /** Expired claims returned to `held`. */
  readonly reclaimed: number;
}

export interface ReleaseDeps {
  readonly now: () => number;
  readonly token: () => string;
}

const DEFAULT_DEPS: ReleaseDeps = { now: () => Date.now(), token: () => crypto.randomUUID() };

interface ClaimedRow {
  id: string;
  hold_reason: HeldItem['holdReason'];
  group_key: string;
  held_at: number;
  event_type: string;
  title: string;
  url: string;
  repo: string;
  actor: string;
  status: HeldItem['status'];
  summary: string;
  resolved: number;
}

function toItem(r: ClaimedRow): HeldItem {
  return {
    id: r.id,
    holdReason: r.hold_reason,
    groupKey: r.group_key,
    heldAt: r.held_at,
    eventType: r.event_type,
    title: r.title,
    url: r.url,
    repo: r.repo,
    actor: r.actor,
    status: r.status,
    summary: r.summary,
    resolved: r.resolved === 1,
  };
}

/** A single held event goes out as itself; resolved ones keep their "resolved" wording. */
export function singleMessage(
  base: Pick<DeliveryMessage, 'id' | 'integrationId' | 'organizationId'>,
  item: HeldItem,
): DeliveryMessage {
  const summary = item.resolved
    ? `Back to passing after an earlier failure.${item.summary ? ` ${item.summary}` : ''}`.slice(0, 280)
    : item.summary;
  return {
    ...base,
    title: item.resolved ? `Resolved: ${item.title}`.slice(0, 300) : item.title,
    url: item.url,
    status: item.status,
    eventType: item.eventType,
    ...(item.repo ? { repo: item.repo } : {}),
    ...(item.actor ? { actor: item.actor } : {}),
    ...(summary ? { summary } : {}),
  };
}

const CLAIM_SQL = `UPDATE held_events SET state='claimed', claim_token=?1, claim_expires_at=?2
  WHERE organization_id=?3 AND integration_id=?4 AND state='held' AND release_at<=?5
    AND rowid IN (SELECT rowid FROM held_events
                  WHERE organization_id=?3 AND integration_id=?4 AND state='held' AND release_at<=?5
                  ORDER BY release_at, held_at LIMIT ?6)
  RETURNING id,hold_reason,group_key,held_at,event_type,title,url,repo,actor,status,summary,resolved`;

const RECLAIM_SQL = `UPDATE held_events SET state='held', claim_token=NULL, claim_expires_at=NULL
  WHERE rowid IN (SELECT rowid FROM held_events WHERE state='claimed' AND claim_expires_at<=?1 LIMIT ?2)`;

const DUE_UNITS_SQL = `SELECT organization_id, integration_id FROM held_events
  WHERE state='held' AND release_at<=?1
  GROUP BY organization_id, integration_id ORDER BY MIN(release_at) LIMIT ?2`;

interface Planned {
  readonly message: DeliveryMessage;
  /** Which claimed rows this notification stands for. */
  readonly scope: { readonly groupKey: string } | { readonly digest: true };
  /** Rows covered, for the report and the single-event dedup case. */
  readonly rows: number;
}

async function newId(orgId: string, integrationId: string, token: string, scope: string): Promise<string> {
  const dedup = await dedupKey({
    orgId,
    connectionId: integrationId,
    source: 'noise',
    eventId: `${token}:${scope}`,
  });
  return (await deriveDeliveryId(dedup.hex, integrationId)).hex;
}

async function plan(
  orgId: string,
  integrationId: string,
  token: string,
  items: readonly HeldItem[],
): Promise<Planned[]> {
  const base = { organizationId: orgId, integrationId };
  const out: Planned[] = [];
  const grouped = new Map<string, HeldItem[]>();
  const digest: HeldItem[] = [];
  for (const item of items) {
    if (item.holdReason === 'grouped') {
      const bucket = grouped.get(item.groupKey);
      if (bucket) bucket.push(item);
      else grouped.set(item.groupKey, [item]);
    } else digest.push(item);
  }
  for (const [groupKey, bucket] of grouped) {
    const only = bucket[0];
    if (bucket.length === 1 && only) {
      // Released under its own deterministic id: a redelivery cannot create a second one.
      out.push({ message: singleMessage({ ...base, id: only.id }, only), scope: { groupKey }, rows: 1 });
    } else {
      const id = await newId(orgId, integrationId, token, groupKey);
      out.push({
        message: { ...base, id, ...renderGroup(bucket) },
        scope: { groupKey },
        rows: bucket.length,
      });
    }
  }
  if (digest.length > 0) {
    const cause = digest.some((i) => i.holdReason === 'quiet_hours') ? 'quiet_hours' : 'digest';
    const id = await newId(orgId, integrationId, token, 'digest');
    out.push({
      message: { ...base, id, ...renderDigest(digest, cause) },
      scope: { digest: true },
      rows: digest.length,
    });
  }
  return out;
}

/** The claim predicate shared by the guard and the release mark of one planned notification. */
function scopeSql(scope: Planned['scope']): { sql: string; params: string[] } {
  return 'groupKey' in scope
    ? { sql: "hold_reason='grouped' AND group_key=?", params: [scope.groupKey] }
    : { sql: "hold_reason IN ('quiet_hours','digest')", params: [] };
}

function releaseStatements(
  db: D1Database,
  orgId: string,
  integrationId: string,
  token: string,
  nowMs: number,
  planned: readonly Planned[],
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const p of planned) {
    const { sql, params } = scopeSql(p.scope);
    const message = p.message;
    // Created only while the claim is still ours; `changes()` then gates the outbox row, so a
    // delivery that already exists (a redelivered single event) is not sent twice.
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO deliveries(id,integration_id,organization_id,state,dedup_key,created_at)
           SELECT ?,?,?,'pending',?,CURRENT_TIMESTAMP
           WHERE EXISTS (SELECT 1 FROM held_events WHERE organization_id=? AND claim_token=? AND ${sql})`,
        )
        .bind(message.id, integrationId, orgId, `noise:${message.id}`, orgId, token, ...params),
      db
        .prepare(
          `INSERT OR IGNORE INTO notification_outbox(id,organization_id,payload_json) SELECT ?,?,? WHERE changes() > 0`,
        )
        .bind(message.id, orgId, JSON.stringify(message)),
      db
        .prepare(
          `UPDATE held_events SET state='released', released_at=?, released_in=?, claim_token=NULL, claim_expires_at=NULL
           WHERE organization_id=? AND claim_token=? AND state='claimed' AND ${sql}`,
        )
        .bind(nowMs, message.id, orgId, token, ...params),
    );
  }
  return statements;
}

async function releaseUnit(
  env: Bindings,
  orgId: string,
  integrationId: string,
  deps: ReleaseDeps,
): Promise<{ notifications: number; events: number }> {
  const nowMs = deps.now();
  const token = deps.token();
  const claimed = await env.DB.prepare(CLAIM_SQL)
    .bind(
      token,
      nowMs + RELEASE_LEASE_MS,
      orgId,
      integrationId,
      nowMs,
      Math.min(HELD_CAPACITY, COMBINED_COUNT_MAX),
    )
    .all<ClaimedRow>();
  if (claimed.results.length === 0) return { notifications: 0, events: 0 };
  const planned = await plan(orgId, integrationId, token, claimed.results.map(toItem));
  // One transaction PER notification (each covers a disjoint set of claimed rows), so a large
  // backlog is never one giant batch. If one fails, the rows it covers stay claimed and come back
  // when the lease expires; the others are already released. The first failure is rethrown.
  let notifications = 0;
  let events = 0;
  let failure: unknown;
  for (const p of planned) {
    try {
      await env.DB.batch(releaseStatements(env.DB, orgId, integrationId, token, nowMs, [p]));
      notifications++;
      events += p.rows;
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure instanceof Error ? failure : new Error('noise release failed');
  return { notifications, events };
}

/**
 * Claim and release everything due. Each integration is released independently; one failing
 * does not stop the rest (its claim expires and it is retried), and the failure is rethrown at
 * the end so the cron invocation records it.
 */
export async function releaseHeldEvents(
  env: Bindings,
  deps: ReleaseDeps = DEFAULT_DEPS,
): Promise<ReleaseReport> {
  const reclaimed = await env.DB.prepare(RECLAIM_SQL).bind(deps.now(), EXPIRED_RECLAIM_LIMIT).run();
  const due = await env.DB.prepare(DUE_UNITS_SQL)
    .bind(deps.now(), UNITS_PER_TICK)
    .all<{ organization_id: string; integration_id: string }>();
  let notifications = 0;
  let events = 0;
  let failed = 0;
  for (const unit of due.results) {
    try {
      const done = await releaseUnit(env, unit.organization_id, unit.integration_id, deps);
      notifications += done.notifications;
      events += done.events;
    } catch (error) {
      failed++;
      log('error', 'noise_release_failed', { integration_id: unit.integration_id, error });
    }
  }
  const report: ReleaseReport = {
    units: due.results.length - failed,
    notifications,
    events,
    reclaimed: reclaimed.meta.changes ?? 0,
  };
  if (failed > 0) throw new Error(`noise release failed for ${failed} integration(s)`);
  return report;
}

/** Retention for released rows and stale open failures (bounded rounds). */
export async function purgeNoiseRecords(env: Bindings, nowMs: number = Date.now()) {
  return purgeNoise(env.DB, nowMs);
}
