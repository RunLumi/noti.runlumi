/**
 * Platform-wide outbound guard for Discord (docs/specs/REMAINING.md 1.16, spec 09 F108; ADR 0029).
 *
 * WHY THIS EXISTS. Discord bans the calling IP at Cloudflare for ten minutes once it sees 10,000 invalid
 * requests (401, 403 or 429) in ten minutes (docs/DESTINATION_API_REFERENCE.md section 4). Every tenant's
 * Discord webhook leaves from the same Worker egress, so one tenant retrying a dead webhook can take out
 * Discord delivery for EVERY tenant. The per-integration breaker (health.ts) cannot see that: it is keyed
 * by tenant on purpose. This guard is the one deliberately cross-tenant control.
 *
 * WHAT IT DOES.
 *  - Counts Discord requests and invalid responses per minute in `egress_guard_buckets` (counts only: no
 *    tenant, integration, host or URL is ever stored here).
 *  - Trips OPEN when invalid responses in the trailing {@link INVALID_WINDOW_MS} reach {@link INVALID_TRIP}
 *    (10% of Discord's documented limit, so the guard acts long before Discord does). While open, NO
 *    Discord request leaves the platform; deliveries wait, spend no attempt, and are never dead-lettered
 *    by it. It stays open {@link OPEN_MS}, longer than the window, so the counted responses age out
 *    before the next request; then traffic resumes and, if the cause is still there, it trips again.
 *  - Paces total Discord requests to {@link REQUESTS_PER_MINUTE} (80% of the documented global limit of
 *    50 per second), a coarse per-minute cap rather than a per-second one: a per-second counter would
 *    cost a D1 write per request on top of this one and still could not see other Workers sharing the IP.
 *
 * WHAT IT CANNOT DO (honest limits, ADR 0029).
 *  - Discord's global limit is per IP and the Worker's egress IPs are Cloudflare's, shared with other
 *    customers and not under our control. Our counters see only OUR traffic.
 *  - Counting is a D1 read-modify-write per response, not a transaction with the send: concurrent
 *    consumers can overshoot the trip point by the number in flight. The trip is 10x below Discord's.
 *  - The documented numbers are Discord's; none has been observed against the real service (UNVERIFIED).
 *
 * Fails OPEN: if D1 cannot be read the delivery proceeds (the per-integration breaker, the 404 rule and
 * the attempt caps still apply) and the fault is logged. Test notifications are gated like any other
 * request, because they spend the same shared budget.
 */
import { log } from '../platform/log';

export const GUARDED_PROVIDERS = ['discord'] as const;
export type GuardedProvider = (typeof GUARDED_PROVIDERS)[number];

const MINUTE = 60_000;
/** Discord's documented invalid-request window. */
export const INVALID_WINDOW_MS = 10 * MINUTE;
/** Discord's documented limit (reference section 4). */
export const DISCORD_INVALID_LIMIT = 10_000;
/** Trip at a tenth of the documented limit. Engineering judgment, not a Discord number. */
export const INVALID_TRIP = DISCORD_INVALID_LIMIT / 10;
/** Open longer than the window so the counted responses have aged out when traffic resumes. */
export const OPEN_MS = INVALID_WINDOW_MS + MINUTE;
/** 80% of the documented global 50 requests per second, per minute. */
export const REQUESTS_PER_MINUTE = Math.floor(50 * 60 * 0.8);
/** Statuses Discord counts as invalid requests (reference section 4). Conservative: every 429 is counted. */
export const INVALID_STATUSES: ReadonlySet<number> = new Set([401, 403, 429]);
/** Buckets older than this are deleted. */
export const BUCKET_RETENTION_MS = 60 * MINUTE;

export type GuardReason = 'platform_paused';

export type GuardGate =
  | { readonly action: 'proceed' }
  | { readonly action: 'defer'; readonly untilMs: number; readonly reason: GuardReason };

type Db = Pick<D1Database, 'prepare'>;

const minuteOf = (ms: number): number => Math.floor(ms / MINUTE) * MINUTE;

/** ?1 provider · ?2 window start. Seeks the primary key range. */
export const WINDOW_SQL = `SELECT COALESCE(SUM(invalid),0) AS invalid,
  COALESCE(SUM(CASE WHEN minute_start = ?3 THEN requests ELSE 0 END),0) AS current_requests
  FROM egress_guard_buckets WHERE provider = ?1 AND minute_start >= ?2`;
/** ?1 provider. Primary key lookup. */
export const STATE_SQL = `SELECT open_until FROM egress_guard_state WHERE provider = ?1`;
/** Provider signals for the alert: how many guarded providers are open right now. */
export const GUARDS_OPEN_SQL = `SELECT COUNT(*) AS n FROM (SELECT 1 FROM egress_guard_state WHERE open_until > ?1 LIMIT ?2)`;

const OPEN_SQL = `INSERT INTO egress_guard_state(provider,open_until,opened_at,opened_count,reason,updated_at)
  VALUES(?1,?2,?3,1,'invalid_requests',?3)
  ON CONFLICT(provider) DO UPDATE SET open_until = MAX(open_until, excluded.open_until),
    opened_at = CASE WHEN open_until > ?3 THEN opened_at ELSE ?3 END,
    opened_count = opened_count + CASE WHEN open_until > ?3 THEN 0 ELSE 1 END,
    reason = 'invalid_requests', updated_at = ?3`;

/** May the platform send to this provider now? Never throws: a fault fails open. */
export async function guardGate(db: Db, provider: GuardedProvider, nowMs: number): Promise<GuardGate> {
  try {
    const state = await db.prepare(STATE_SQL).bind(provider).first<{ open_until: number }>();
    if (state && state.open_until > nowMs)
      return { action: 'defer', untilMs: state.open_until, reason: 'platform_paused' };
    const w = await db
      .prepare(WINDOW_SQL)
      .bind(provider, minuteOf(nowMs - INVALID_WINDOW_MS), minuteOf(nowMs))
      .first<{ invalid: number; current_requests: number }>();
    const invalid = w?.invalid ?? 0;
    if (invalid >= INVALID_TRIP) {
      const untilMs = nowMs + OPEN_MS;
      await db.prepare(OPEN_SQL).bind(provider, untilMs, nowMs).run();
      // Counts and the provider name only: nothing identifies a tenant.
      log('error', 'egress_guard_opened', { provider, invalid_in_window: invalid, trip: INVALID_TRIP });
      return { action: 'defer', untilMs, reason: 'platform_paused' };
    }
    if ((w?.current_requests ?? 0) >= REQUESTS_PER_MINUTE)
      return { action: 'defer', untilMs: minuteOf(nowMs) + MINUTE, reason: 'platform_paused' };
    return { action: 'proceed' };
  } catch (e) {
    log('error', 'egress_guard_unreadable', { provider, error: e });
    return { action: 'proceed' };
  }
}

/**
 * Count one request that was (or was about to be) sent, and whether the answer was an invalid one.
 * `status` is null when no response arrived (timeout, network error): it still spent a request.
 * Best effort: a failure is logged and never changes the delivery's outcome.
 */
export async function recordEgress(
  db: Db,
  provider: GuardedProvider,
  nowMs: number,
  status: number | null,
): Promise<void> {
  const invalid = status !== null && INVALID_STATUSES.has(status) ? 1 : 0;
  try {
    await db
      .prepare(
        `INSERT INTO egress_guard_buckets(provider,minute_start,requests,invalid) VALUES(?1,?2,1,?3)
         ON CONFLICT(provider,minute_start) DO UPDATE SET requests = requests + 1, invalid = invalid + ?3`,
      )
      .bind(provider, minuteOf(nowMs), invalid)
      .run();
  } catch (e) {
    log('error', 'egress_guard_record_failed', { provider, error: e });
  }
}

/** Housekeeping: delete buckets past retention, bounded. Returns the number removed. */
export async function purgeEgressBuckets(db: Db, nowMs: number): Promise<number> {
  const r = await db
    .prepare(
      // At most a few dozen rows live here (one per provider per minute, retained an hour): no LIMIT needed.
      'DELETE FROM egress_guard_buckets WHERE minute_start < ?1',
    )
    .bind(nowMs - BUCKET_RETENTION_MS)
    .run();
  return r.meta?.changes ?? 0;
}
