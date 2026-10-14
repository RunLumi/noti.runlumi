/**
 * Job freshness from `job_state` (docs/specs/13-observability.md F192): the `job_stale` signal and the
 * `jobs` list of `GET /api/observability/summary`.
 *
 * A job is HEALTHY at a run that finished `ok` or `skipped` (it ran; a throttled job with nothing to do
 * is alive). It is STALE when its last healthy run finished more than `3 x cadence` ago
 * (`src/observability/cadence.ts`). A job with no record at all is NOT stale: it has no deadline until it
 * first runs, so a job added by a later release, or a fresh deployment, cannot read stale; a job that ran
 * but never healthily is stale once ITS OWN first run is older than the threshold. Staleness is computed
 * from D1, never from logs. A job that is scheduled but never executes is caught statically (a test ties
 * the scheduler to the cadence table), not here.
 *
 * Cost: one read of `job_state` (one row per job, thirteen rows).
 */
import { JOB_CADENCE, JOB_NAMES, type JobName } from './cadence';

type Db = Pick<D1Database, 'prepare'>;

export interface JobHealth {
  readonly name: JobName;
  /** Finish time (epoch ms) of the last `ok` or `skipped` run, or null. */
  readonly lastOk: number | null;
  /** Finish time of the last failed run, or null. */
  readonly lastFailed: number | null;
  readonly stale: boolean;
}

interface Row {
  job: string;
  first_seen_at: number;
  last_healthy_at: number | null;
  last_failed_at: number | null;
}

export const JOB_HEALTH_SQL = 'SELECT job, first_seen_at, last_healthy_at, last_failed_at FROM job_state';

/** Pure: stale when the last healthy run is older than the job's threshold. */
export function isStale(
  name: JobName,
  lastOk: number | null,
  firstSeen: number | null,
  nowMs: number,
): boolean {
  const threshold = JOB_CADENCE[name].staleAfterMs;
  if (lastOk !== null) return nowMs - lastOk > threshold;
  return firstSeen !== null && nowMs - firstSeen > threshold;
}

export async function readJobHealth(db: Db, nowMs: number): Promise<readonly JobHealth[]> {
  const rows = await db.prepare(JOB_HEALTH_SQL).all<Row>();
  const byJob = new Map(rows.results.map((r) => [r.job, r] as const));
  return JOB_NAMES.map((name) => {
    const row = byJob.get(name);
    const lastOk = row?.last_healthy_at ?? null;
    return {
      name,
      lastOk,
      lastFailed: row?.last_failed_at ?? null,
      stale: isStale(name, lastOk, row?.first_seen_at ?? null, nowMs),
    };
  });
}
