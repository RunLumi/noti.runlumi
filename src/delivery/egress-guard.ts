/**
 * Platform-wide outbound guard for Discord (docs/specs/REMAINING.md 1.16, spec 09 F108; ADR 0029).
 *
 * WHY THIS EXISTS. Discord bans the calling IP at Cloudflare for ten minutes once it sees 10,000 invalid
 * requests (401, 403 or 429) in ten minutes (docs/DESTINATION_API_REFERENCE.md section 4). Every tenant's
 * Discord webhook leaves from the same Worker egress, so one tenant retrying a dead webhook can take out
 * Discord delivery for EVERY tenant. The per-integration breaker (health.ts) is keyed by tenant on purpose
 * and cannot see that. This guard is the deliberately cross-tenant control.
 *
 * A TENANT CAN CAUSE THIS, SO EACH TENANT IS BOUNDED FIRST (ADR 0029). Without bounds, one workspace with
 * many integrations pointing at one real webhook (429s) or at a webhook with a corrupted token (401s) could
 * open the global breaker on purpose and repeat it. Therefore:
 *  1. PER-TENANT BUDGETS, in a tenant table (`egress_guard_tenant_buckets`, keyed by workspace and
 *     integration): a workspace whose invalid answers in ten minutes reach {@link TENANT_INVALID_BUDGET}, or
 *     one integration reaching {@link INTEGRATION_INVALID_BUDGET}, has ITS OWN deliveries held (reason
 *     `workspace_paused`, shown to it) before the global guard is involved.
 *  2. ONLY WITHIN-BUDGET invalid answers count toward the GLOBAL trip. A workspace past its budget adds
 *     nothing, so the global breaker needs {@link INVALID_TRIP} / {@link TENANT_INVALID_BUDGET} workspaces
 *     all at budget at once: a cost an attacker pays in workspaces, not integrations.
 *  3. PER-TENANT FAIR SHARE of the pacing cap: a workspace may make at most {@link TENANT_REQUESTS_PER_MINUTE}
 *     requests a minute, and once the platform is at {@link REQUESTS_PER_MINUTE} only workspaces still under
 *     {@link LIGHT_TENANT_REQUESTS} that minute are admitted (up to {@link HARD_REQUESTS_PER_MINUTE}, the
 *     documented limit). A heavy backlog cannot starve a light tenant into the 24-hour held-delivery ceiling.
 *
 * WHAT IT STILL CANNOT DO (honest limits).
 *  - An attacker with enough workspaces (each at budget) can still open the global breaker; the cost is
 *    workspace creation, which is rate limited and audited elsewhere, not free. A workspace that burns its
 *    budget repeatedly is visible in `egress_guard_tenant_buckets` for the operator.
 *  - Discord's global limit is per IP and the Worker's egress IPs are Cloudflare's, shared and not under our
 *    control. Our counters see only OUR traffic.
 *  - Counting is a D1 read-modify-write, not a transaction with the send: concurrent consumers can overshoot
 *    a budget by the number in flight.
 *  - `X-RateLimit-Scope: shared` 429s are NOT excluded: docs/DESTINATION_API_REFERENCE.md does not say they are
 *    exempt from Discord's invalid-request count, so they are counted (UNVERIFIED either way).
 *  - Alert-sink requests to a Discord webhook (observability/alerts/sinks.ts) deliberately BYPASS this guard:
 *    the alert that says the guard is open must still be able to leave.
 *  - Every number here is an engineering judgment; none has been observed against the real service.
 *
 * Fails OPEN: if D1 cannot be read the delivery proceeds, the fault is counted in `ops_state`
 * (`egress_guard_fault`, read by the `egress_guard_failing` alert) and logged.
 */
import { log } from '../platform/log';

export const GUARDED_PROVIDERS = ['discord'] as const;
export type GuardedProvider = (typeof GUARDED_PROVIDERS)[number];

const MINUTE = 60_000;
/** Discord's documented invalid-request window. */
export const INVALID_WINDOW_MS = 10 * MINUTE;
/** Discord's documented limit (reference section 4). */
export const DISCORD_INVALID_LIMIT = 10_000;
/** Global trip at a tenth of the documented limit. Engineering judgment, not a Discord number. */
export const INVALID_TRIP = DISCORD_INVALID_LIMIT / 10;
/** A workspace's own invalid-answer budget per window; it is held, not the platform, when it reaches it. */
export const TENANT_INVALID_BUDGET = 50;
/** One integration's budget per window (several integrations of one workspace share the workspace budget). */
export const INTEGRATION_INVALID_BUDGET = 10;
/** How long a workspace over budget is held before it is looked at again. */
export const TENANT_RECHECK_MS = 2 * MINUTE;
/** Open longer than the window so the counted responses have aged out when traffic resumes. */
export const OPEN_MS = INVALID_WINDOW_MS + MINUTE;
/** 80% of the documented global 50 requests per second, per minute. */
export const REQUESTS_PER_MINUTE = Math.floor(50 * 60 * 0.8);
/** The documented global limit per minute: nothing is admitted above it. */
export const HARD_REQUESTS_PER_MINUTE = 50 * 60;
/** One workspace's share of a minute. */
export const TENANT_REQUESTS_PER_MINUTE = Math.floor(REQUESTS_PER_MINUTE / 4);
/** Above the soft cap, a workspace that has made fewer than this many requests this minute is still admitted. */
export const LIGHT_TENANT_REQUESTS = 100;
/** Statuses Discord counts as invalid requests (reference section 4). Conservative: every 429 is counted. */
export const INVALID_STATUSES: ReadonlySet<number> = new Set([401, 403, 429]);
/** Buckets older than this are deleted. */
export const BUCKET_RETENTION_MS = 60 * MINUTE;
/** A guard fault counts toward `egress_guard_failing` for this long. */
export const FAULT_WINDOW_MS = 15 * MINUTE;
export const FAULT_KEY = 'egress_guard_fault';

export type GuardReason = 'platform_paused' | 'workspace_paused';

export type GuardGate =
  | { readonly action: 'proceed' }
  | { readonly action: 'defer'; readonly untilMs: number; readonly reason: GuardReason };

export interface GuardScope {
  readonly organizationId: string;
  readonly integrationId: string;
}

type Db = Pick<D1Database, 'prepare' | 'batch'>;

const minuteOf = (ms: number): number => Math.floor(ms / MINUTE) * MINUTE;

/** ?1 provider · ?2 window start · ?3 current minute. Seeks the primary key range. */
export const WINDOW_SQL = `SELECT COALESCE(SUM(invalid),0) AS invalid,
  COALESCE(SUM(CASE WHEN minute_start = ?3 THEN requests ELSE 0 END),0) AS current_requests
  FROM egress_guard_buckets WHERE provider = ?1 AND minute_start >= ?2`;
/** ?1 organization · ?2 provider · ?3 window start · ?4 current minute · ?5 integration. Seeks the primary key prefix. */
export const TENANT_WINDOW_SQL = `SELECT COALESCE(SUM(invalid),0) AS invalid,
  COALESCE(SUM(CASE WHEN integration_id = ?5 THEN invalid ELSE 0 END),0) AS integration_invalid,
  COALESCE(SUM(CASE WHEN minute_start = ?4 THEN requests ELSE 0 END),0) AS current_requests
  FROM egress_guard_tenant_buckets WHERE organization_id = ?1 AND provider = ?2 AND minute_start >= ?3`;
/** ?1 provider. Primary key lookup. */
export const STATE_SQL = `SELECT open_until FROM egress_guard_state WHERE provider = ?1`;
/** Guards open now. ?1 now · ?2 cap. */
export const GUARDS_OPEN_SQL = `SELECT COUNT(*) AS n FROM (SELECT 1 FROM egress_guard_state WHERE open_until > ?1 LIMIT ?2)`;
/** Guard faults recorded recently (a count kept in ops_state). */
/** ?1 key (FAULT_KEY) · ?2 limit. Primary key lookup. */
export const FAULT_SQL = `SELECT value FROM ops_state WHERE key = ?1 LIMIT ?2`;

const OPEN_SQL = `INSERT INTO egress_guard_state(provider,open_until,opened_at,opened_count,reason,updated_at)
  VALUES(?1,?2,?3,1,'invalid_requests',?3)
  ON CONFLICT(provider) DO UPDATE SET open_until = MAX(open_until, excluded.open_until),
    opened_at = CASE WHEN open_until > ?3 THEN opened_at ELSE ?3 END,
    opened_count = opened_count + CASE WHEN open_until > ?3 THEN 0 ELSE 1 END,
    reason = 'invalid_requests', updated_at = ?3`;

const FAULT_UPSERT_SQL = `INSERT INTO ops_state(key,value,updated_at) VALUES('${FAULT_KEY}', json_object('at',?1,'count',1), ?1)
  ON CONFLICT(key) DO UPDATE SET
    value = json_object('at', ?1, 'count', CASE WHEN COALESCE(json_extract(value,'$.at'),0) >= ?2
      THEN COALESCE(json_extract(value,'$.count'),0) + 1 ELSE 1 END),
    updated_at = ?1`;

/** Count a guard fault so an alert can tell that the safeguard is failing open. Never throws. */
async function recordFault(db: Db, nowMs: number): Promise<void> {
  try {
    await db
      .prepare(FAULT_UPSERT_SQL)
      .bind(nowMs, nowMs - FAULT_WINDOW_MS)
      .run();
  } catch {
    // D1 is down: the fault is in the log line the caller writes; nothing more can be recorded here.
  }
}

interface TenantWindow {
  invalid: number;
  integration_invalid: number;
  current_requests: number;
}

async function tenantWindow(db: Db, provider: GuardedProvider, scope: GuardScope, nowMs: number) {
  return db
    .prepare(TENANT_WINDOW_SQL)
    .bind(
      scope.organizationId,
      provider,
      minuteOf(nowMs - INVALID_WINDOW_MS),
      minuteOf(nowMs),
      scope.integrationId,
    )
    .first<TenantWindow>();
}

const overBudget = (w: Pick<TenantWindow, 'invalid' | 'integration_invalid'>): boolean =>
  w.invalid >= TENANT_INVALID_BUDGET || w.integration_invalid >= INTEGRATION_INVALID_BUDGET;

/** May the platform send to this provider now, for this workspace? Never throws: a fault fails open. */
export async function guardGate(
  db: Db,
  provider: GuardedProvider,
  scope: GuardScope,
  nowMs: number,
): Promise<GuardGate> {
  try {
    const state = await db.prepare(STATE_SQL).bind(provider).first<{ open_until: number }>();
    if (state && state.open_until > nowMs)
      return { action: 'defer', untilMs: state.open_until, reason: 'platform_paused' };
    // The workspace's own budget first: the offender is cut off before the platform is involved.
    const mine = await tenantWindow(db, provider, scope, nowMs);
    if (mine && overBudget(mine))
      return { action: 'defer', untilMs: nowMs + TENANT_RECHECK_MS, reason: 'workspace_paused' };
    const w = await db
      .prepare(WINDOW_SQL)
      .bind(provider, minuteOf(nowMs - INVALID_WINDOW_MS), minuteOf(nowMs))
      .first<{ invalid: number; current_requests: number }>();
    if ((w?.invalid ?? 0) >= INVALID_TRIP) {
      const untilMs = nowMs + OPEN_MS;
      await db.prepare(OPEN_SQL).bind(provider, untilMs, nowMs).run();
      // Counts and the provider name only: nothing identifies a tenant.
      log('error', 'egress_guard_opened', { provider, invalid_in_window: w?.invalid, trip: INVALID_TRIP });
      return { action: 'defer', untilMs, reason: 'platform_paused' };
    }
    const nextMinute = minuteOf(nowMs) + MINUTE;
    const mineNow = mine?.current_requests ?? 0;
    if (mineNow >= TENANT_REQUESTS_PER_MINUTE)
      return { action: 'defer', untilMs: nextMinute, reason: 'workspace_paused' };
    const total = w?.current_requests ?? 0;
    if (
      total >= HARD_REQUESTS_PER_MINUTE ||
      (total >= REQUESTS_PER_MINUTE && mineNow >= LIGHT_TENANT_REQUESTS)
    )
      return { action: 'defer', untilMs: nextMinute, reason: 'platform_paused' };
    return { action: 'proceed' };
  } catch (e) {
    log('error', 'egress_guard_unreadable', { provider, error: e });
    await recordFault(db, nowMs);
    return { action: 'proceed' };
  }
}

const TENANT_UPSERT_SQL = `INSERT INTO egress_guard_tenant_buckets(organization_id,integration_id,provider,minute_start,requests,invalid)
  VALUES(?1,?2,?3,?4,1,?5)
  ON CONFLICT(organization_id,provider,minute_start,integration_id) DO UPDATE SET requests = requests + 1, invalid = invalid + ?5`;
const GLOBAL_UPSERT_SQL = `INSERT INTO egress_guard_buckets(provider,minute_start,requests,invalid) VALUES(?1,?2,1,?3)
  ON CONFLICT(provider,minute_start) DO UPDATE SET requests = requests + 1, invalid = invalid + ?3`;

/**
 * Count one request that was sent, and whether the answer was an invalid one. `status` is null when no
 * response arrived (timeout, network error): it still spent a request. An invalid answer is added to the
 * GLOBAL count only while the workspace and the integration are within their own budgets: an offender
 * past its budget is bounded by its own pause and does not drive the platform breaker. Best effort: a
 * failure is counted, logged and never changes the delivery's outcome.
 */
export async function recordEgress(
  db: Db,
  provider: GuardedProvider,
  scope: GuardScope,
  nowMs: number,
  status: number | null,
): Promise<void> {
  const invalid = status !== null && INVALID_STATUSES.has(status) ? 1 : 0;
  const minute = minuteOf(nowMs);
  try {
    const tenant = db
      .prepare(TENANT_UPSERT_SQL)
      .bind(scope.organizationId, scope.integrationId, provider, minute, invalid);
    if (invalid === 0) {
      await db.batch([tenant, db.prepare(GLOBAL_UPSERT_SQL).bind(provider, minute, 0)]);
      return;
    }
    await tenant.run();
    const mine = await tenantWindow(db, provider, scope, nowMs);
    const within =
      mine !== null &&
      mine.invalid <= TENANT_INVALID_BUDGET &&
      mine.integration_invalid <= INTEGRATION_INVALID_BUDGET;
    await db
      .prepare(GLOBAL_UPSERT_SQL)
      .bind(provider, minute, within ? 1 : 0)
      .run();
  } catch (e) {
    log('error', 'egress_guard_record_failed', { provider, error: e });
    await recordFault(db, nowMs);
  }
}

/** Housekeeping: delete buckets past retention (a few dozen global rows; tenant rows by age). */
export async function purgeEgressBuckets(db: Db, nowMs: number): Promise<number> {
  const cutoff = nowMs - BUCKET_RETENTION_MS;
  const [global, tenant] = await db.batch([
    db.prepare('DELETE FROM egress_guard_buckets WHERE minute_start < ?1').bind(cutoff),
    db
      .prepare(
        `DELETE FROM egress_guard_tenant_buckets WHERE rowid IN (
           SELECT rowid FROM egress_guard_tenant_buckets WHERE minute_start < ?1 LIMIT 500)`,
      )
      .bind(cutoff),
  ]);
  return (global?.meta.changes ?? 0) + (tenant?.meta.changes ?? 0);
}

/** The faults recorded in the last {@link FAULT_WINDOW_MS}, for the `egress_guard_failing` alert. */
export function faultCount(raw: string | null | undefined, nowMs: number): number {
  if (!raw) return 0;
  try {
    const v = JSON.parse(raw) as { at?: unknown; count?: unknown };
    return typeof v.at === 'number' && typeof v.count === 'number' && nowMs - v.at <= FAULT_WINDOW_MS
      ? v.count
      : 0;
  } catch {
    return 0;
  }
}
