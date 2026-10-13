/**
 * Isolated cron jobs (docs/specs/13-observability.md F192: a job that stopped must never be
 * indistinguishable from a job with nothing to do).
 *
 * Each job runs in its own try/catch so one failing job cannot skip the rest of the tick.
 * A failure logs one redacted error line naming the job; after every job has run, the
 * invocation still fails (one error naming the failed jobs), so the platform records it.
 */
import { log } from '../platform/log';

export interface CronJob {
  readonly name: string;
  readonly run: () => Promise<unknown>;
}

export async function runCronJobs(jobs: readonly CronJob[]): Promise<void> {
  const failed: string[] = [];
  for (const job of jobs) {
    try {
      await job.run();
    } catch (error) {
      failed.push(job.name);
      log('error', 'cron_job_failed', { job: job.name, error });
    }
  }
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
