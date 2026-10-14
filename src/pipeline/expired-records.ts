/**
 * Expired authentication records (docs/specs/15 F237, docs/DATA_RETENTION.md).
 *
 * Four stores hold short-lived authentication data that nothing deleted once it expired:
 *  - `session`: expired sessions (token, IP address, user agent), unusable once `expires_at` has passed, and
 *    sessions older than the absolute lifetime (`SESSION_ABSOLUTE_SECONDS`, ADR 0030) however recently used;
 *  - `verification`: one-time verification and reset records, unusable once `expires_at` has passed;
 *  - `github_auth_states`: single-use install/OAuth states (10-minute TTL), kept one day past expiry
 *    so a support question about a failed install can still be answered;
 *  - `rate_limit` (Better Auth's own counters): rows whose last request is older than a day. Its
 *    longest rule window is 15 minutes, so such a row can never be counted again.
 *
 * Only rows that can no longer be used are deleted. Deletes are bounded per statement and per tick
 * and the whole pass runs at most hourly (`ops_state` key `last_expired_auth_purge_at`, advanced only
 * after a complete pass). `github_auth_states` has an index on its expiry (migration 0010); `session`,
 * `verification` and `rate_limit` have none, so each pass scans them. That is acceptable at hourly
 * cadence and small volume, and is listed in the retention doc.
 *
 * Sanity guard: the purge deletes by comparing a timestamp column with `Date.now()`. If a table held
 * seconds instead of milliseconds, every live row would look expired. Before deleting anything the
 * pass therefore aborts, logs `expired_purge_aborted` and deletes nothing when (a) any `session` or
 * `verification` expiry is below `UNIT_CANARY_MS` (a millisecond timestamp from this century is above
 * 1e12), or (b) a `session` table of at least `MAJORITY_FLOOR` rows would lose more than half its rows.
 * An aborted pass does not advance the throttle, so it is retried and logs every hour until a person looks.
 *
 * UNVERIFIED: `meta.changes` for DELETE was exercised only through the Node SQLite fake, not real D1.
 */
import { SESSION_ABSOLUTE_SECONDS } from '../auth/session-policy';
import { log } from '../platform/log';

export const EXPIRED_BATCH = 500;
/** No millisecond timestamp from this century is below this; a seconds value always is. */
export const UNIT_CANARY_MS = 1e11;
/** Below this many rows the "more than half" rule does not apply (a small table can be mostly stale). */
export const MAJORITY_FLOOR = 200;
export const EXPIRED_MAX_ROUNDS = 5;
export const EXPIRED_INTERVAL_MS = 60 * 60_000;
export const EXPIRED_STATE_KEY = 'last_expired_auth_purge_at';
/** How long a spent or expired install state is kept. */
export const AUTH_STATE_GRACE_MS = 24 * 60 * 60 * 1000;
/** A Better Auth rate-limit row untouched for this long can never be counted again. */
export const AUTH_RATE_LIMIT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type Db = Pick<D1Database, 'prepare'>;

export interface ExpiredAuthReport {
  readonly skipped: boolean;
  readonly sessions: number;
  /** Sessions removed for outliving the absolute lifetime although still being used. */
  readonly overAgeSessions: number;
  readonly verifications: number;
  readonly authStates: number;
  readonly authRateLimits: number;
  readonly more: boolean;
  /** True when the sanity guard stopped the pass before any delete. */
  readonly aborted: boolean;
}

/** `?1` cutoff, `?2` limit. Table and column names are fixed constants below, never input. */
function boundedDelete(table: string, column: string): string {
  return `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column} < ?1 LIMIT ?2)`;
}

export const PURGE_EXPIRED_SESSIONS_SQL = boundedDelete('session', 'expires_at');
/** `?1` is `now - SESSION_ABSOLUTE_SECONDS`: a session signed in before it has reached its absolute end. */
export const PURGE_OVER_AGE_SESSIONS_SQL = boundedDelete('session', 'created_at');
export const PURGE_EXPIRED_VERIFICATIONS_SQL = boundedDelete('verification', 'expires_at');
export const PURGE_EXPIRED_AUTH_STATES_SQL = boundedDelete('github_auth_states', 'expires_at');
export const PURGE_STALE_AUTH_RATE_LIMITS_SQL = boundedDelete('rate_limit', 'last_request');

async function drain(db: Db, sql: string, cutoff: number): Promise<{ n: number; more: boolean }> {
  let n = 0;
  for (let i = 0; i < EXPIRED_MAX_ROUNDS; i++) {
    const res = await db.prepare(sql).bind(cutoff, EXPIRED_BATCH).run();
    const changed = res.meta?.changes ?? 0;
    n += changed;
    if (changed < EXPIRED_BATCH) return { n, more: false };
  }
  return { n, more: true };
}

async function lastRun(db: Db): Promise<number | null> {
  try {
    const row = await db
      .prepare('SELECT value FROM ops_state WHERE key=?1')
      .bind(EXPIRED_STATE_KEY)
      .first<{ value: string }>();
    const n = row ? Number(row.value) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null; // unreadable throttle state: run the purge rather than skip it
  }
}

async function markRun(db: Db, nowMs: number): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO ops_state(key,value,updated_at) VALUES(?1,?2,?3)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      )
      .bind(EXPIRED_STATE_KEY, String(nowMs), nowMs)
      .run();
  } catch {
    // The next tick simply runs again.
  }
}

interface Anomaly {
  readonly table: string;
  readonly reason: 'expiry_not_milliseconds' | 'majority_expired';
  readonly total: number;
  readonly expired: number;
}

async function countRows(db: Db, sql: string, ...binds: number[]): Promise<number> {
  const row = await db
    .prepare(sql)
    .bind(...binds)
    .first<{ n: number | null }>();
  return Number(row?.n ?? 0);
}

/** Looks for a pass that would delete live rows; returns the first anomaly, or null. */
async function findAnomaly(db: Db, nowMs: number): Promise<Anomaly | null> {
  for (const table of ['session', 'verification'] as const) {
    const wrongUnit = await countRows(
      db,
      `SELECT COUNT(*) AS n FROM ${table} WHERE expires_at < ?1`,
      UNIT_CANARY_MS,
    );
    if (wrongUnit > 0)
      return { table, reason: 'expiry_not_milliseconds', total: wrongUnit, expired: wrongUnit };
  }
  // The over-age delete compares `created_at`, so it needs the same unit check.
  const createdWrongUnit = await countRows(
    db,
    'SELECT COUNT(*) AS n FROM session WHERE created_at < ?1',
    UNIT_CANARY_MS,
  );
  if (createdWrongUnit > 0)
    return {
      table: 'session',
      reason: 'expiry_not_milliseconds',
      total: createdWrongUnit,
      expired: createdWrongUnit,
    };
  const total = await countRows(db, 'SELECT COUNT(*) AS n FROM session');
  if (total >= MAJORITY_FLOOR) {
    // Only idle-expired rows count. A cohort signing in together reaches its absolute end together, and that
    // is the policy working, not a unit mix-up; the `created_at` canary above still catches a wrong unit.
    const expired = await countRows(db, 'SELECT COUNT(*) AS n FROM session WHERE expires_at < ?1', nowMs);
    if (expired * 2 > total) return { table: 'session', reason: 'majority_expired', total, expired };
  }
  return null;
}

export async function purgeExpiredAuthRecords(db: Db, nowMs: number): Promise<ExpiredAuthReport> {
  const previous = await lastRun(db);
  if (previous !== null && nowMs - previous >= 0 && nowMs - previous < EXPIRED_INTERVAL_MS) {
    return {
      skipped: true,
      sessions: 0,
      overAgeSessions: 0,
      verifications: 0,
      authStates: 0,
      authRateLimits: 0,
      more: false,
      aborted: false,
    };
  }
  const anomaly = await findAnomaly(db, nowMs);
  if (anomaly) {
    log('error', 'expired_purge_aborted', { ...anomaly });
    return {
      skipped: false,
      sessions: 0,
      overAgeSessions: 0,
      verifications: 0,
      authStates: 0,
      authRateLimits: 0,
      more: false,
      aborted: true,
    };
  }
  const sessions = await drain(db, PURGE_EXPIRED_SESSIONS_SQL, nowMs);
  const overAgeSessions = await drain(
    db,
    PURGE_OVER_AGE_SESSIONS_SQL,
    nowMs - SESSION_ABSOLUTE_SECONDS * 1000,
  );
  const verifications = await drain(db, PURGE_EXPIRED_VERIFICATIONS_SQL, nowMs);
  const authStates = await drain(db, PURGE_EXPIRED_AUTH_STATES_SQL, nowMs - AUTH_STATE_GRACE_MS);
  const authRateLimits = await drain(
    db,
    PURGE_STALE_AUTH_RATE_LIMITS_SQL,
    nowMs - AUTH_RATE_LIMIT_MAX_AGE_MS,
  );
  const more =
    sessions.more || overAgeSessions.more || verifications.more || authStates.more || authRateLimits.more;
  if (!more) await markRun(db, nowMs);
  return {
    skipped: false,
    sessions: sessions.n,
    overAgeSessions: overAgeSessions.n,
    verifications: verifications.n,
    authStates: authStates.n,
    authRateLimits: authRateLimits.n,
    more,
    aborted: false,
  };
}
