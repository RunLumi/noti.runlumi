/**
 * Job run records (docs/specs/13-observability.md F192). One row per cron job execution in D1 (never
 * only in logs: a logging stop must not erase the evidence that a job stopped).
 *
 * What a row may hold: the job name, start and finish, an outcome, bounded integer COUNTERS (rows
 * processed) and an error CLASS from a closed vocabulary. It never holds an error message, a tenant id,
 * a payload or a URL: a thrown error is classified from its shape and the text is discarded here (the
 * redacted log line has it).
 *
 * Rows are buffered for the tick and written in ONE batch (one D1 round trip), flushed before the alert
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

/** Retention of `job_runs`: the staleness check needs minutes of history; three days is for a human. */
export const JOB_RUNS_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

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

const INSERT_SQL = `INSERT INTO job_runs(job,started_at,finished_at,outcome,healthy,counters_json,error_class)
VALUES(?1,?2,?3,?4,?5,?6,?7)`;

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
          rows.map((r) =>
            db
              .prepare(INSERT_SQL)
              .bind(
                r.job,
                r.startedAt,
                r.finishedAt,
                r.outcome,
                r.outcome === 'failed' ? 0 : 1,
                Object.keys(r.counters).length > 0 ? JSON.stringify(r.counters) : null,
                r.errorClass,
              ),
          ),
        );
      } catch (error) {
        log('warn', 'job_runs_write_failed', { rows: rows.length, error });
      }
    },
  };
}
