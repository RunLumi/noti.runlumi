/**
 * Isolated cron jobs (docs/specs/13-observability.md F192: a job that stopped must never be
 * indistinguishable from a job with nothing to do).
 *
 * Each job runs in its own try/catch so one failing job cannot skip the rest of the tick.
 * A failure logs one redacted error line naming the job; after every job has run, the
 * invocation still fails (one error naming the failed jobs), so the platform records it.
 *
 * With a `recorder`, every execution is also written to `job_runs` (ok, failed or skipped, counters,
 * an error CLASS). A job that sets `flushBefore` runs only after the rows of the jobs before it were
 * written, so the alert job sees this tick's runs rather than the previous tick's.
 */
import { log } from '../platform/log';
import { classifyJobError, normaliseReport, type JobRecorder } from './job-runs';

export interface CronJob<N extends string = string> {
  readonly name: N;
  /** May return a `JobReport` (counters, `skipped`); anything else is ignored. */
  readonly run: () => Promise<unknown>;
  /** Flush the recorded runs of the jobs before this one first. */
  readonly flushBefore?: boolean;
}

export interface CronOptions {
  readonly recorder?: JobRecorder;
  readonly now?: () => number;
}

export async function runCronJobs<N extends string>(
  jobs: readonly CronJob<N>[],
  options: CronOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const failed: string[] = [];
  for (const job of jobs) {
    if (job.flushBefore) await options.recorder?.flush();
    const startedAt = now();
    try {
      const report = normaliseReport(await job.run());
      options.recorder?.record({
        job: job.name,
        startedAt,
        finishedAt: now(),
        outcome: report.skipped ? 'skipped' : 'ok',
        counters: report.counters,
        errorClass: null,
      });
    } catch (error) {
      failed.push(job.name);
      log('error', 'cron_job_failed', { job: job.name, error });
      options.recorder?.record({
        job: job.name,
        startedAt,
        finishedAt: now(),
        outcome: 'failed',
        counters: {},
        errorClass: classifyJobError(error),
      });
    }
  }
  await options.recorder?.flush();
  if (failed.length > 0) throw new Error(`cron jobs failed: ${failed.join(', ')}`);
}

export const HEARTBEAT_KEY = 'cron_heartbeat';

/** Cheap proof the cron ran this tick (one UPSERT); the runbook reads it. */
export async function writeHeartbeat(db: Pick<D1Database, 'prepare'>, nowMs: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ops_state(key,value,updated_at) VALUES(?1,?2,?3)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    )
    .bind(HEARTBEAT_KEY, String(nowMs), nowMs)
    .run();
}
