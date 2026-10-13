import { dedupKey, deliveryId as deriveDeliveryId } from '../delivery/ids';
import { COMBINED_COUNT_MAX, type Bindings, type DeliveryMessage } from '../env';
import { log } from '../platform/log';
import { HELD_CAPACITY } from '../routing/noise';
import { DIGEST_MAX_PARTS, renderDigestParts, renderGroup, type HeldItem } from '../routing/noise-render';
import { purgeNoise } from '../routing/noise-store';

/**
 * Release held events (docs/adr/0016-noise-control.md). Runs from the every-minute cron, AFTER
 * the outbox reconcile (a released notification is dispatched on the next tick).
 *
 * Safety properties, each covered by a test:
 *  - BOUNDED BY D1 CALLS, not only by rows: at most {@link NOTIFICATION_BUDGET} notifications per
 *    tick across all integrations, decided BEFORE anything is claimed, released in batches of
 *    {@link BATCH_NOTIFICATIONS}; the rest stays `held` and due for the next tick. One scheduled
 *    invocation therefore makes a small, predictable number of subrequests however large the
 *    backlog (500 distinct group keys take five ticks, not one huge one).
 *  - LEASED: due rows are claimed with a token and an expiry; a crashed run's claim expires and
 *    the rows are claimable again, so nothing is stranded.
 *  - ATOMIC: a notification's delivery row, outbox row and the "released" marks of the rows it
 *    covers commit in one D1 batch, and the delivery insert is guarded on the claim still being
 *    ours, so a run that lost its lease creates nothing and a row is never released without a
 *    delivery. A batch holds several notifications (disjoint rows); if it fails none of them was
 *    created.
 *  - IDEMPOTENT: a second run finds nothing due; a single held event is released under its own
 *    deterministic delivery id, so even a provider redelivery cannot duplicate it.
 *  - POISON-PROOF: every failed or abandoned attempt counts on the row and delays it with a
 *    backoff; after {@link MAX_ATTEMPTS} the row becomes `failed` (kept, visible in the runbook
 *    query and the noise status, never released) so unhealthy rows cannot starve healthy ones.
 *  - PAUSED INTEGRATIONS WAIT: rows of a disabled integration, or one with quarantined
 *    credentials, are not due; they release after it is enabled again and are never dead-lettered.
 *  - DATA MINIMISED: once released, the display columns are blanked; only what the dedupe and the
 *    delivery-log join need remains.
 *  - NORMAL DELIVERIES: the result is an ordinary delivery plus outbox row, so retries,
 *    dead-lettering, replay and audit all apply unchanged.
 */

/** Integrations visited per tick. */
export const UNITS_PER_TICK = 20;
/** Notifications created per tick across all integrations (a digest counts as up to 3). */
export const NOTIFICATION_BUDGET = 100;
/** Notifications per `DB.batch` (3 statements each, all token-guarded). */
export const BATCH_NOTIFICATIONS = 15;
/** Group keys per claim statement (the D1 limit is 100 bound parameters). */
const CLAIM_KEYS_PER_CALL = 40;
/** Long enough for one batch, shorter than the 5-minute stall the observability job reports. */
export const RELEASE_LEASE_MS = 120_000;
/** After this many failed or abandoned attempts a row becomes `failed`. */
export const MAX_ATTEMPTS = 5;
const EXPIRED_RECLAIM_LIMIT = 500;

export interface ReleaseReport {
  /** Integrations released this tick. */
  readonly units: number;
  /** Notifications created (groups, singles and digests). */
  readonly notifications: number;
  /** Held events marked released. */
  readonly events: number;
  /** Expired claims returned to `held` (or `failed`). */
  readonly reclaimed: number;
}

export interface ReleaseDeps {
  readonly now: () => number;
  readonly token: () => string;
  /** Test seams; production uses the constants above. */
  readonly budget?: number;
  readonly batchSize?: number;
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

/** Backoff after `attempts` earlier failures: 1 min, 2, 4, ... capped at 1 hour (SQL expression). */
const BACKOFF_SQL = 'MIN(3600000, 60000 * (1 << attempts))';

const RECLAIM_SQL = `UPDATE held_events SET
    state=CASE WHEN attempts+1>=?3 THEN 'failed' ELSE 'held' END,
    released_at=CASE WHEN attempts+1>=?3 THEN ?1 ELSE released_at END,
    retry_after=?1 + ${BACKOFF_SQL}, attempts=attempts+1, last_error_class='lease_expired',
    claim_token=NULL, claim_expires_at=NULL
  WHERE rowid IN (SELECT rowid FROM held_events WHERE state='claimed' AND claim_expires_at<=?1 LIMIT ?2)`;

/**
 * Integrations with due rows. Rows of a disabled integration or one with quarantined credentials
 * are not due (they wait; nothing is dead-lettered), nor are rows still backing off.
 */
const DUE_UNITS_SQL = `SELECT h.organization_id, h.integration_id FROM held_events h
  JOIN integrations i ON i.id=h.integration_id AND i.organization_id=h.organization_id
  WHERE h.state='held' AND h.release_at<=?1 AND h.retry_after<=?1
    AND i.enabled=1 AND i.credentials_quarantined_at IS NULL
  GROUP BY h.organization_id, h.integration_id ORDER BY MIN(h.release_at) LIMIT ?2`;

/** Distinct notifications due for one integration: each group key, plus '' for the digest rows. */
const SCOPES_SQL = `SELECT CASE WHEN hold_reason='grouped' THEN group_key ELSE '' END AS scope,
    MIN(release_at) AS first
  FROM held_events
  WHERE organization_id=? AND integration_id=? AND state='held' AND release_at<=? AND retry_after<=?
  GROUP BY scope ORDER BY first, scope LIMIT ?`;

const CLAIM_COLUMNS =
  'id,hold_reason,group_key,held_at,event_type,title,url,repo,actor,status,summary,resolved';

interface Planned {
  readonly message: DeliveryMessage;
  /** Which claimed rows this notification stands for. */
  readonly scope: Scope;
  /** Rows covered, for the report. */
  readonly rows: number;
}

type Scope =
  | { readonly kind: 'group'; readonly groupKey: string }
  /** `keys` null: every digest row. Otherwise these keys, and (last part) any key in none of `all`. */
  | {
      readonly kind: 'digest';
      readonly keys: readonly string[] | null;
      readonly leftoverOutside: readonly string[] | null;
    };

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
    const scope: Scope = { kind: 'group', groupKey };
    if (bucket.length === 1 && only) {
      // Released under its own deterministic id: a redelivery cannot create a second one.
      out.push({ message: singleMessage({ ...base, id: only.id }, only), scope, rows: 1 });
    } else {
      const id = await newId(orgId, integrationId, token, groupKey);
      out.push({ message: { ...base, id, ...renderGroup(bucket) }, scope, rows: bucket.length });
    }
  }
  if (digest.length > 0) {
    const cause = digest.some((i) => i.holdReason === 'quiet_hours') ? 'quiet_hours' : 'digest';
    const parts = renderDigestParts(digest, cause, DIGEST_MAX_PARTS);
    const allListed = parts.flatMap((p) => p.groupKeys);
    for (const [index, part] of parts.entries()) {
      const { groupKeys, rows, listedItems, notShown, ...fields } = part;
      void listedItems;
      const id = await newId(orgId, integrationId, token, `digest:${index}`);
      const whole = parts.length === 1 && notShown === 0;
      out.push({
        message: { ...base, id, ...fields },
        scope: {
          kind: 'digest',
          keys: whole ? null : groupKeys,
          leftoverOutside: !whole && notShown > 0 ? allListed : null,
        },
        rows,
      });
    }
  }
  return out;
}

/** The claim predicate shared by the guard, the release mark and the failure mark. */
function scopeSql(scope: Scope): { sql: string; params: string[] } {
  if (scope.kind === 'group')
    return { sql: "hold_reason='grouped' AND group_key=?", params: [scope.groupKey] };
  const digest = "hold_reason IN ('quiet_hours','digest')";
  if (scope.keys === null) return { sql: digest, params: [] };
  const inKeys = `group_key IN (${scope.keys.map(() => '?').join(',')})`;
  if (scope.leftoverOutside === null) return { sql: `${digest} AND ${inKeys}`, params: [...scope.keys] };
  const outside = `group_key NOT IN (${scope.leftoverOutside.map(() => '?').join(',')})`;
  return {
    sql: `${digest} AND (${inKeys} OR ${outside})`,
    params: [...scope.keys, ...scope.leftoverOutside],
  };
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
      // The display text has done its job: blank it, keep only what dedupe and the log join need.
      db
        .prepare(
          `UPDATE held_events SET state='released', released_at=?, released_in=?, claim_token=NULL, claim_expires_at=NULL,
             title='', summary='', url='', actor='', repo=''
           WHERE organization_id=? AND claim_token=? AND state='claimed' AND ${sql}`,
        )
        .bind(nowMs, message.id, orgId, token, ...params),
    );
  }
  return statements;
}

/** Count a failed attempt on the rows a failed batch covered; the row backs off, then fails for good. */
function failureStatements(
  db: D1Database,
  orgId: string,
  token: string,
  nowMs: number,
  planned: readonly Planned[],
): D1PreparedStatement[] {
  return planned.map((p) => {
    const { sql, params } = scopeSql(p.scope);
    return db
      .prepare(
        `UPDATE held_events SET
           state=CASE WHEN attempts+1>=? THEN 'failed' ELSE 'held' END,
           released_at=CASE WHEN attempts+1>=? THEN ? ELSE released_at END,
           retry_after=? + ${BACKOFF_SQL}, attempts=attempts+1, last_error_class='batch_failed',
           claim_token=NULL, claim_expires_at=NULL
         WHERE organization_id=? AND claim_token=? AND state='claimed' AND ${sql}`,
      )
      .bind(MAX_ATTEMPTS, MAX_ATTEMPTS, nowMs, nowMs, orgId, token, ...params);
  });
}

interface ScopeRow {
  scope: string;
}

/** Claim the rows of some scopes, in statements small enough for D1's parameter limit. */
async function claimScopes(
  env: Bindings,
  orgId: string,
  integrationId: string,
  token: string,
  nowMs: number,
  groupKeys: readonly string[],
  digest: boolean,
): Promise<ClaimedRow[]> {
  const rows: ClaimedRow[] = [];
  const chunks: (readonly string[])[] = [];
  for (let i = 0; i < groupKeys.length; i += CLAIM_KEYS_PER_CALL)
    chunks.push(groupKeys.slice(i, i + CLAIM_KEYS_PER_CALL));
  if (chunks.length === 0 && digest) chunks.push([]);
  for (const [index, keys] of chunks.entries()) {
    const withDigest = digest && index === 0;
    const parts: string[] = [];
    if (keys.length > 0)
      parts.push(`(hold_reason='grouped' AND group_key IN (${keys.map(() => '?').join(',')}))`);
    if (withDigest) parts.push("hold_reason IN ('quiet_hours','digest')");
    if (parts.length === 0) continue;
    const predicate = `organization_id=? AND integration_id=? AND state='held' AND release_at<=? AND retry_after<=? AND (${parts.join(' OR ')})`;
    const binds = [orgId, integrationId, nowMs, nowMs, ...keys];
    const result = await env.DB.prepare(
      `UPDATE held_events SET state='claimed', claim_token=?, claim_expires_at=?
       WHERE ${predicate} AND rowid IN (SELECT rowid FROM held_events WHERE ${predicate} ORDER BY release_at, held_at LIMIT ?)
       RETURNING ${CLAIM_COLUMNS}`,
    )
      .bind(token, nowMs + RELEASE_LEASE_MS, ...binds, ...binds, Math.min(HELD_CAPACITY, COMBINED_COUNT_MAX))
      .all<ClaimedRow>();
    rows.push(...result.results);
  }
  return rows;
}

interface UnitResult {
  readonly notifications: number;
  readonly events: number;
  /** Budget consumed: notifications planned (a digest counts as the parts it needs). */
  readonly cost: number;
}

async function releaseUnit(
  env: Bindings,
  orgId: string,
  integrationId: string,
  deps: ReleaseDeps,
  budgetLeft: number,
): Promise<UnitResult> {
  const nowMs = deps.now();
  const token = deps.token();
  // The budget is spent BEFORE claiming: only as many scopes as the tick may still release are
  // claimed, so nothing is claimed that this run will not process.
  const scopes = await env.DB.prepare(SCOPES_SQL)
    .bind(orgId, integrationId, nowMs, nowMs, budgetLeft)
    .all<ScopeRow>();
  if (scopes.results.length === 0) return { notifications: 0, events: 0, cost: 0 };
  const groupKeys = scopes.results.map((s) => s.scope).filter((s) => s !== '');
  const digest = scopes.results.some((s) => s.scope === '');
  const claimed = await claimScopes(env, orgId, integrationId, token, nowMs, groupKeys, digest);
  if (claimed.length === 0) return { notifications: 0, events: 0, cost: 0 };
  const planned = await plan(orgId, integrationId, token, claimed.map(toItem));

  // Several notifications per batch (each guarded on the claim). If a batch fails, none of its
  // notifications was created: count an attempt on its rows (they back off, and fail after
  // MAX_ATTEMPTS) and carry on with the others. The first failure is rethrown at the end.
  const size = deps.batchSize ?? BATCH_NOTIFICATIONS;
  let notifications = 0;
  let events = 0;
  let failure: unknown;
  for (let i = 0; i < planned.length; i += size) {
    const slice = planned.slice(i, i + size);
    try {
      await env.DB.batch(releaseStatements(env.DB, orgId, integrationId, token, nowMs, slice));
      notifications += slice.length;
      events += slice.reduce((n, p) => n + p.rows, 0);
    } catch (error) {
      failure ??= error;
      try {
        await env.DB.batch(failureStatements(env.DB, orgId, token, nowMs, slice));
      } catch {
        // The claim simply expires and the reclaim at the start of a run counts the attempt.
      }
    }
  }
  if (failure !== undefined) throw failure instanceof Error ? failure : new Error('noise release failed');
  return { notifications, events, cost: planned.length };
}

/**
 * Claim and release what is due, within the per-tick budget. Each integration is released
 * independently; one failing does not stop the rest, and the failure is rethrown at the end so
 * the cron invocation records it.
 */
export async function releaseHeldEvents(
  env: Bindings,
  deps: ReleaseDeps = DEFAULT_DEPS,
): Promise<ReleaseReport> {
  const reclaimed = await env.DB.prepare(RECLAIM_SQL)
    .bind(deps.now(), EXPIRED_RECLAIM_LIMIT, MAX_ATTEMPTS)
    .run();
  const due = await env.DB.prepare(DUE_UNITS_SQL)
    .bind(deps.now(), UNITS_PER_TICK)
    .all<{ organization_id: string; integration_id: string }>();
  let budget = deps.budget ?? NOTIFICATION_BUDGET;
  let notifications = 0;
  let events = 0;
  let units = 0;
  let failed = 0;
  for (const unit of due.results) {
    if (budget <= 0) break;
    try {
      const done = await releaseUnit(env, unit.organization_id, unit.integration_id, deps, budget);
      notifications += done.notifications;
      events += done.events;
      budget -= done.cost;
      if (done.cost > 0) units++;
    } catch (error) {
      failed++;
      budget -= 1;
      log('error', 'noise_release_failed', { integration_id: unit.integration_id, error });
    }
  }
  const report: ReleaseReport = { units, notifications, events, reclaimed: reclaimed.meta.changes ?? 0 };
  if (failed > 0) throw new Error(`noise release failed for ${failed} integration(s)`);
  return report;
}

/** Retention for released rows, dead-lettered rows and stale open failures (bounded rounds). */
export async function purgeNoiseRecords(env: Bindings, nowMs: number = Date.now()) {
  return purgeNoise(env.DB, nowMs);
}
