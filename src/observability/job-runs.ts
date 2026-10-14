/**
 * Job run records (docs/specs/13-observability.md F192), in D1 and never only in logs: a logging stop must
 * not erase the evidence that a job stopped.
 *
 * Each execution upserts the job's single `job_state` row (what the staleness check, the summary and the
 * alert read). `job_runs` gets a HISTORY row only for a failure, a job's first run or a change of outcome
 * (migration 0027), so a quiet healthy job writes one row a minute, not two plus indexes.
 *
 * What a row may hold: the job name, times, an outcome, bounded integer COUNTERS (rows processed) and an
 * error CLASS from a closed vocabulary. It never holds an error message, a tenant id, a payload or a URL:
 * a thrown error is classified from its shape and the text is discarded here (the redacted log line has it).
 *
 * Runs are buffered for the tick and written in ONE batch (one D1 round trip), flushed before the alert
 * job runs (so the alerts see this tick) and again at the end. A write failure is logged and swallowed:
 * recording must never fail or skip a job.
 */
import { CryptoError } from '../crypto/envelope';
import { log } from '../platform/log';

export type JobOutcome = 'ok' | 'failed' | 'skipped';

export const JOB_ERROR_CLASSES = ['database', 'crypto', 'config', 'timeout', 'internal'] as const;
export type JobErrorClass = (typeof JOB_ERROR_CLASSES)[number];

export type JobCounters = Readonly<Record<string, number>>;

export interface JobRunRecord {
  readonly job: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly outcome: JobOutcome;
  readonly counters: JobCounters;
  readonly errorClass: JobErrorClass | null;
}

/**
 * Retention of `job_runs`, the HISTORY of failures and outcome changes (a quiet healthy job writes none).
 * `job_state`, the one row per job the staleness check reads, is not purged.
 */
export const JOB_RUNS_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

const COUNTER_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_COUNTERS = 8;
const MAX_COUNTER_VALUE = 1_000_000_000;

/**
 * What a job may return to describe itself: `{ skipped: true }` when it ran but the throttle said
 * there was nothing to do, and/or integer counters. Anything else is ignored.
 */
export interface JobReport {
  readonly skipped?: boolean;
  readonly counters?: JobCounters;
}

/** Counters from a job's return value: finite non-negative integers under well-formed keys, at most eight. */
export function normaliseReport(result: unknown): { skipped: boolean; counters: JobCounters } {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return { skipped: false, counters: {} };
  }
  const r = result as Record<string, unknown>;
  const raw =
    typeof r.counters === 'object' && r.counters !== null ? (r.counters as Record<string, unknown>) : {};
  const counters: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Object.keys(counters).length >= MAX_COUNTERS) break;
    if (!COUNTER_KEY.test(key)) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_COUNTER_VALUE)
      continue;
    counters[key] = value;
  }
  return { skipped: r.skipped === true, counters };
}

/** Reads the error's shape (and, to choose a class, its message). Stores only the class. */
export function classifyJobError(error: unknown): JobErrorClass {
  if (error instanceof CryptoError) return 'crypto';
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timeout';
    if (/^config_invalid/.test(error.message)) return 'config';
    if (/D1_|SQLITE|no such table|no such column|database is locked|constraint failed/i.test(error.message))
      return 'database';
  }
  return 'internal';
}

export interface JobRecorder {
  record(run: JobRunRecord): void;
  /** Writes what is buffered in one batch. Never throws. */
  flush(): Promise<void>;
}

/**
 * History row: only for a failed run, the first run of a job, or a CHANGE of outcome. Placed BEFORE the
 * state upsert in the batch, so `job_state.last_outcome` still holds the previous run's outcome.
 */
export const HISTORY_SQL = `INSERT INTO job_runs(job,started_at,finished_at,outcome,healthy,counters_json,error_class)
SELECT ?1,?2,?3,?4,?5,?6,?7
WHERE ?4 = 'failed' OR NOT EXISTS (SELECT 1 FROM job_state WHERE job = ?1 AND last_outcome = ?4)`;

export const STATE_SQL = `INSERT INTO job_state(job,first_seen_at,last_started_at,last_finished_at,last_outcome,
  last_healthy_at,last_failed_at,last_counters_json,last_error_class,runs)
VALUES(?1,?2,?2,?3,?4,?5,?6,?7,?8,1)
ON CONFLICT(job) DO UPDATE SET last_started_at=excluded.last_started_at,
  last_finished_at=excluded.last_finished_at, last_outcome=excluded.last_outcome,
  last_healthy_at=COALESCE(excluded.last_healthy_at, job_state.last_healthy_at),
  last_failed_at=COALESCE(excluded.last_failed_at, job_state.last_failed_at),
  last_counters_json=excluded.last_counters_json, last_error_class=excluded.last_error_class,
  runs=job_state.runs+1`;

export function createJobRecorder(db: Pick<D1Database, 'prepare' | 'batch'>): JobRecorder {
  let buffer: readonly JobRunRecord[] = [];
  return {
    record(run) {
      buffer = [...buffer, run];
    },
    async flush() {
      const rows = buffer;
      buffer = [];
      if (rows.length === 0) return;
      try {
        await db.batch(
          rows.flatMap((r) => {
            const counters = Object.keys(r.counters).length > 0 ? JSON.stringify(r.counters) : null;
            const healthy = r.outcome === 'failed' ? 0 : 1;
            return [
              db
                .prepare(HISTORY_SQL)
                .bind(r.job, r.startedAt, r.finishedAt, r.outcome, healthy, counters, r.errorClass),
              db
                .prepare(STATE_SQL)
                .bind(
                  r.job,
                  r.startedAt,
                  r.finishedAt,
                  r.outcome,
                  healthy === 1 ? r.finishedAt : null,
                  healthy === 0 ? r.finishedAt : null,
                  counters,
                  r.errorClass,
                ),
            ];
          }),
        );
      } catch (error) {
        log('warn', 'job_runs_write_failed', { rows: rows.length, error });
      }
    },
  };
}
