/**
 * The measurable signals the alert registry reads (docs/specs/13-observability.md F200). Every value is a
 * platform-wide NUMBER computed from D1 (never from logs, F196) or from the boot report; nothing here
 * carries a tenant id, a payload or a URL, and a failed read is `null` ("unknown"), never 0, so a broken
 * query can neither fire nor resolve an alert.
 *
 * Cost discipline: these run every minute, including during an outage when the tables are at their
 * largest. Every COUNT is CAPPED at its alert's threshold (`SELECT COUNT(*) FROM (SELECT 1 ... LIMIT cap)`:
 * the value is "at least the threshold" past that, which is all the alert needs) and every query is an
 * index seek on a state or time index or a partial index from migration 0027. The SQL is exported so
 * `tests/observability/alert-plans.test.ts` asserts the plan of EVERY query: no scan of `deliveries`,
 * `integrations` or `sources`.
 *
 * What is NOT measurable without the Cloudflare Queues API or Analytics Engine and is therefore not a
 * signal: queue depth, consumer concurrency, real DLQ depth, CPU time (docs/specs/13 F198, F192).
 */
import { FAULT_KEY, FAULT_SQL, GUARDS_OPEN_SQL, faultCount } from '../../delivery/egress-guard';
import { sqliteTimestamp } from '../../delivery/claim';
import type { Bindings } from '../../env';
import { bootReport } from '../../platform/config';
import { log } from '../../platform/log';
import { GAP_KEY } from '../cron';
import { recentDecryptFailures } from '../credential-decrypt';
import { readJobHealth } from '../job-health';
import { countStalls, type StallCounts } from '../stall';
import { THRESHOLDS } from './thresholds';

type Db = Pick<D1Database, 'prepare'>;

/** Every signal, by the name the registry uses. `null` = could not be read this tick. */
export interface Signals {
  readonly jobsStale: number | null;
  readonly outboxStalled: number | null;
  readonly deadLettersRecent: number | null;
  readonly breakersOpen: number | null;
  /** Breakers holding deliveries back now (see BREAKERS_HOLDING_SQL). */
  readonly breakersHolding: number | null;
  readonly keyConfigFaults: number | null;
  readonly credentialsQuarantined: number | null;
  /** Credential decrypt failures at send time in the current burst (credential-decrypt.ts). */
  readonly credentialDecryptFailures: number | null;
  readonly oldestPendingAgeMs: number | null;
  readonly sourcesDropping: number | null;
  readonly heartbeatMaxGapMs: number | null;
  readonly deadLetterStuckRows: number | null;
  readonly egressGuardsOpen: number | null;
  readonly egressGuardFaults: number | null;
}

/** ?1 window start (epoch ms) · ?2 cap. Seeks the partial index `delivery_attempts_dead`. */
export const DEAD_LETTERS_SQL = `SELECT COUNT(*) AS n FROM (
  SELECT 1 FROM delivery_attempts WHERE started_at >= ?1 AND outcome = 'dead_lettered' LIMIT ?2)`;

/** ?1 cap. Seeks `destination_health_state`. */
export const BREAKERS_SQL = `SELECT COUNT(*) AS n FROM (
  SELECT 1 FROM destination_health WHERE state IN ('open','half_open') LIMIT ?1)`;

/**
 * Breakers holding deliveries back RIGHT NOW: open inside its window (`open_until` in the future), or half-open
 * with a probe lease still live. This is the same test `gateAttempt` applies (src/delivery/health.ts), so the
 * alert reads what the consumer does. An `open` row whose window has passed is NOT counted: nothing is held
 * back, and a stored state that nothing has probed would otherwise keep the alert firing for an idle integration.
 * ?1 now (epoch ms) · ?2 cap. Seeks `destination_health_state`.
 */
export const BREAKERS_HOLDING_SQL = `SELECT COUNT(*) AS n FROM (
  SELECT 1 FROM destination_health
  WHERE state IN ('open','half_open')
    AND ((state='open' AND COALESCE(open_until,0) > ?1) OR (state='half_open' AND COALESCE(probe_until,0) > ?1))
  LIMIT ?2)`;

/** ?1 cap. Seeks the partial index `integrations_quarantined`. */
export const QUARANTINED_SQL = `SELECT COUNT(*) AS n FROM (
  SELECT 1 FROM integrations WHERE credentials_quarantined_at IS NOT NULL LIMIT ?1)`;

/** Oldest pending delivery: walks `deliveries_state_created` in order and stops at the first real one. */
export const OLDEST_PENDING_SQL = `SELECT created_at AS at FROM deliveries
  WHERE state = 'pending' AND is_test = 0 ORDER BY created_at LIMIT 1`;

/** ?1 window start (text timestamp) · ?2 cap. Seeks the partial index `sources_dropped`. */
export const SOURCES_DROPPING_SQL = `SELECT COUNT(*) AS n FROM (
  SELECT 1 FROM sources WHERE last_dropped_at IS NOT NULL AND last_dropped_at >= ?1 LIMIT ?2)`;

/**
 * Ledger rows non-terminal for hours (the dead-letter proxy). ?1 text cutoff · ?2 epoch-ms cutoff ·
 * ?3 cap, applied to each part. All three seek `deliveries_state_created` by state.
 */
export const DEAD_LETTER_STUCK_SQL = `SELECT
  (SELECT COUNT(*) FROM (SELECT 1 FROM deliveries
     WHERE state = 'pending' AND is_test = 0 AND created_at < ?1 LIMIT ?3))
+ (SELECT COUNT(*) FROM (SELECT 1 FROM deliveries
     WHERE state = 'claimed' AND is_test = 0 AND claimed_at < ?2 LIMIT ?3))
+ (SELECT COUNT(*) FROM (SELECT 1 FROM deliveries
     WHERE state = 'retrying' AND is_test = 0 AND next_attempt_at < ?2 LIMIT ?3)) AS n`;

/** Every signal query the engine runs on its own (the stall counts live in stall.ts, job freshness in job-health.ts). */
export const SIGNAL_QUERIES: Readonly<Record<string, string>> = {
  DEAD_LETTERS_SQL,
  BREAKERS_SQL,
  BREAKERS_HOLDING_SQL,
  QUARANTINED_SQL,
  OLDEST_PENDING_SQL,
  SOURCES_DROPPING_SQL,
  DEAD_LETTER_STUCK_SQL,
  GUARDS_OPEN_SQL,
  FAULT_SQL,
};

async function count(db: Db, sql: string, ...binds: readonly (string | number)[]): Promise<number> {
  const row = await db
    .prepare(sql)
    .bind(...binds)
    .first<{ n: number | null }>();
  return row?.n ?? 0;
}

async function safely<T>(signal: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    log('warn', 'alert_signal_unreadable', { signal, error });
    return null;
  }
}

/**
 * The gap the heartbeat recorded (`cron_gap`, written by `writeHeartbeat`) if it is recent, else 0. A gap
 * across a maintenance window is never recorded (the cron marks its skips), so it cannot appear here.
 */
export async function heartbeatMaxGap(db: Db, nowMs: number): Promise<number> {
  const row = await db
    .prepare('SELECT value FROM ops_state WHERE key=?1')
    .bind(GAP_KEY)
    .first<{ value: string }>();
  if (!row) return 0;
  try {
    const v = JSON.parse(row.value) as { at?: unknown; gapMs?: unknown };
    return typeof v.at === 'number' &&
      typeof v.gapMs === 'number' &&
      nowMs - v.at <= THRESHOLDS.heartbeatWindowMs
      ? v.gapMs
      : 0;
  } catch {
    return 0;
  }
}

/**
 * Ledger rows that are non-terminal long after any retry window could still own them: pending or claimed
 * since before `stuckMs`, or `retrying` and overdue by more than `stuckMs`. This is the ledger-side
 * footprint of a message that exhausted its queue retries and sits in the dead-letter queue unconsumed.
 * A PROXY: other faults (a stopped dispatcher) leave the same footprint and are caught by `outbox_stall`
 * first. Real DLQ depth needs the Queues API (UNVERIFIED, not available to the Worker).
 *
 * No legitimate row stays here: a retry waiting for a future `next_attempt_at` (at most 24 h of breaker
 * deferral, then it dead-letters) is not overdue; a disabled or deleted integration's delivery is still
 * dispatched and then dead-lettered by the consumer (`integration_unavailable`); the outbox purge only
 * removes rows of finished deliveries; test notifications are excluded.
 */
export async function deadLetterStuckRows(db: Db, nowMs: number, stuckMs: number): Promise<number> {
  return count(
    db,
    DEAD_LETTER_STUCK_SQL,
    sqliteTimestamp(nowMs - stuckMs),
    nowMs - stuckMs,
    THRESHOLDS.deadLetterStuckRows,
  );
}

export async function collectSignals(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  nowMs: number,
  stalls?: StallCounts,
): Promise<Signals> {
  const db = env.DB;
  const [
    jobsStale,
    outboxStalled,
    deadLettersRecent,
    breakersOpen,
    breakersHolding,
    keyConfigFaults,
    credentialsQuarantined,
    credentialDecryptFailures,
    oldestPendingAgeMs,
    sourcesDropping,
    heartbeatMaxGapMs,
    stuckRows,
    egressGuardsOpen,
    egressGuardFaults,
  ] = await Promise.all([
    safely('jobs_stale', async () => (await readJobHealth(db, nowMs)).filter((j) => j.stale).length),
    safely('outbox_stalled', async () => {
      const c = stalls ?? (await countStalls(db, nowMs));
      return c.outboxPending + c.claimedStale + c.retryOverdue;
    }),
    safely('dead_letters_recent', () =>
      count(db, DEAD_LETTERS_SQL, nowMs - THRESHOLDS.deadLetterWindowMs, THRESHOLDS.deadLettersRecent),
    ),
    safely('breakers_open', () => count(db, BREAKERS_SQL, THRESHOLDS.breakersOpen)),
    safely('breakers_holding', () => count(db, BREAKERS_HOLDING_SQL, nowMs, THRESHOLDS.breakersHolding)),
    safely('key_config_faults', async () => (await bootReport(env as Bindings)).names.length),
    safely('credentials_quarantined', () => count(db, QUARANTINED_SQL, THRESHOLDS.credentialsQuarantined)),
    safely('credential_decrypt_failures', () => recentDecryptFailures(db, nowMs)),
    safely('oldest_pending_age', async () => {
      const row = await db.prepare(OLDEST_PENDING_SQL).first<{ at: string | null }>();
      if (!row?.at) return 0;
      const created = Date.parse(`${row.at.replace(' ', 'T')}Z`);
      return Number.isFinite(created) ? Math.max(0, nowMs - created) : 0;
    }),
    safely('sources_dropping', () =>
      count(
        db,
        SOURCES_DROPPING_SQL,
        sqliteTimestamp(nowMs - THRESHOLDS.dropWindowMs),
        THRESHOLDS.sourcesDropping,
      ),
    ),
    safely('heartbeat_gap', () => heartbeatMaxGap(db, nowMs)),
    safely('dead_letter_stuck', () => deadLetterStuckRows(db, nowMs, THRESHOLDS.deadLetterStuckMs)),
    safely('egress_guards_open', () => count(db, GUARDS_OPEN_SQL, nowMs, THRESHOLDS.egressGuardsOpen)),
    safely('egress_guard_faults', async () => {
      const row = await db.prepare(FAULT_SQL).bind(FAULT_KEY, 1).first<{ value: string }>();
      return faultCount(row?.value, nowMs);
    }),
  ]);
  return {
    jobsStale,
    outboxStalled,
    deadLettersRecent,
    breakersOpen,
    breakersHolding,
    keyConfigFaults,
    credentialsQuarantined,
    credentialDecryptFailures,
    oldestPendingAgeMs,
    sourcesDropping,
    heartbeatMaxGapMs,
    deadLetterStuckRows: stuckRows,
    egressGuardsOpen,
    egressGuardFaults,
  };
}
