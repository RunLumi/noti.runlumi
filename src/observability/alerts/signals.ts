/**
 * The measurable signals the alert registry reads (docs/specs/13-observability.md F200). Every value is a
 * platform-wide NUMBER computed from D1 (never from logs, F196) or from the boot report; nothing here
 * carries a tenant id, a payload or a URL, and a failed read is `null` ("unknown"), never 0, so a broken
 * query can neither fire nor resolve an alert.
 *
 * What is NOT measurable without the Cloudflare Queues API or Analytics Engine and is therefore not a
 * signal: queue depth, consumer concurrency, real DLQ depth, CPU time (docs/specs/13 F198, F192).
 */
import { sqliteTimestamp } from '../../delivery/claim';
import type { Bindings } from '../../env';
import { bootReport } from '../../platform/config';
import { log } from '../../platform/log';
import { readJobHealth } from '../job-health';
import { THRESHOLDS } from './thresholds';
import { countStalls } from '../stall';

type Db = Pick<D1Database, 'prepare'>;

/** Every signal, by the name the registry uses. `null` = could not be read this tick. */
export interface Signals {
  readonly jobsStale: number | null;
  readonly outboxStalled: number | null;
  readonly deadLettersRecent: number | null;
  readonly breakersOpen: number | null;
  readonly keyConfigFaults: number | null;
  readonly credentialsQuarantined: number | null;
  readonly oldestPendingAgeMs: number | null;
  readonly sourcesDropping: number | null;
  readonly heartbeatMaxGapMs: number | null;
  readonly deadLetterStuckRows: number | null;
}

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

/** Largest gap between consecutive healthy heartbeat runs in the last window (needs two rows). */
export async function heartbeatMaxGap(db: Db, nowMs: number): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT finished_at AS at FROM job_runs
       WHERE job='heartbeat' AND healthy=1 AND finished_at>=?1 ORDER BY finished_at`,
    )
    .bind(nowMs - THRESHOLDS.heartbeatWindowMs)
    .all<{ at: number }>();
  let max = 0;
  for (let i = 1; i < rows.results.length; i++) {
    const a = rows.results[i - 1]?.at;
    const b = rows.results[i]?.at;
    if (a !== undefined && b !== undefined) max = Math.max(max, b - a);
  }
  return max;
}

export async function collectSignals(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  nowMs: number,
): Promise<Signals> {
  const db = env.DB;
  const [
    jobsStale,
    outboxStalled,
    deadLettersRecent,
    breakersOpen,
    keyConfigFaults,
    credentialsQuarantined,
    oldestPendingAgeMs,
    sourcesDropping,
    heartbeatMaxGapMs,
    stuckRows,
  ] = await Promise.all([
    safely('jobs_stale', async () => (await readJobHealth(db, nowMs)).filter((j) => j.stale).length),
    safely('outbox_stalled', async () => {
      const c = await countStalls(db, nowMs);
      return c.outboxPending + c.claimedStale + c.retryOverdue;
    }),
    // Attempt rows, not the ledger: `delivery_attempts_age` is a range seek, `deliveries` has no index on
    // `dead_lettered_at`. A queue-exhausted dead letter writes no attempt row and is counted by the DLQ signal.
    safely('dead_letters_recent', () =>
      count(
        db,
        "SELECT COUNT(*) AS n FROM delivery_attempts WHERE started_at>=?1 AND outcome='dead_lettered'",
        nowMs - THRESHOLDS.deadLetterWindowMs,
      ),
    ),
    safely('breakers_open', () =>
      count(db, "SELECT COUNT(*) AS n FROM destination_health WHERE state IN ('open','half_open')"),
    ),
    safely('key_config_faults', async () => (await bootReport(env as Bindings)).names.length),
    safely('credentials_quarantined', () =>
      count(db, 'SELECT COUNT(*) AS n FROM integrations WHERE credentials_quarantined_at IS NOT NULL'),
    ),
    safely('oldest_pending_age', async () => {
      const row = await db
        .prepare("SELECT MIN(created_at) AS at FROM deliveries WHERE state='pending' AND is_test=0")
        .first<{ at: string | null }>();
      if (!row?.at) return 0;
      const created = Date.parse(`${row.at.replace(' ', 'T')}Z`);
      return Number.isFinite(created) ? Math.max(0, nowMs - created) : 0;
    }),
    safely('sources_dropping', () =>
      count(
        db,
        'SELECT COUNT(*) AS n FROM sources WHERE last_dropped_at IS NOT NULL AND last_dropped_at>=?1',
        sqliteTimestamp(nowMs - THRESHOLDS.dropWindowMs),
      ),
    ),
    safely('heartbeat_gap', () => heartbeatMaxGap(db, nowMs)),
    safely('dead_letter_stuck', () => deadLetterStuckRows(db, nowMs, THRESHOLDS.deadLetterStuckMs)),
  ]);
  return {
    jobsStale,
    outboxStalled,
    deadLettersRecent,
    breakersOpen,
    keyConfigFaults,
    credentialsQuarantined,
    oldestPendingAgeMs,
    sourcesDropping,
    heartbeatMaxGapMs,
    deadLetterStuckRows: stuckRows,
  };
}

/**
 * Ledger rows that are non-terminal long after any retry window could still own them: pending or claimed
 * since before `stuckMs`, or `retrying` and overdue by more than `stuckMs`. This is the ledger-side
 * footprint of a message that exhausted its queue retries and sits in the dead-letter queue unconsumed.
 * A PROXY: other faults (a stopped dispatcher) leave the same footprint and are caught by `outbox_stall`
 * first. Real DLQ depth needs the Queues API (UNVERIFIED, not available to the Worker).
 */
export async function deadLetterStuckRows(db: Db, nowMs: number, stuckMs: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM deliveries WHERE state='pending' AND is_test=0 AND created_at<?1)
       + (SELECT COUNT(*) FROM deliveries WHERE state='claimed' AND is_test=0 AND claimed_at<?2)
       + (SELECT COUNT(*) FROM deliveries WHERE state='retrying' AND is_test=0 AND next_attempt_at<?2) AS n`,
    )
    .bind(sqliteTimestamp(nowMs - stuckMs), nowMs - stuckMs)
    .first<{ n: number | null }>();
  return row?.n ?? 0;
}
