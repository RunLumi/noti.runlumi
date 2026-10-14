/**
 * Job freshness from `job_runs` (docs/specs/13-observability.md F192): the `job_stale` signal and the
 * `jobs` list of `GET /api/observability/summary`.
 *
 * A job is HEALTHY at a run that finished `ok` or `skipped` (it ran; a throttled job with nothing to do
 * is alive). It is STALE when its last healthy run finished more than `3 x cadence` ago
 * (`src/observability/cadence.ts`). A job that has NEVER run is stale only once the table has been
 * collecting for longer than that, measured from the oldest row of any job, so a fresh deployment (or a
 * job added by this release) does not page before its first tick. Staleness is computed from D1, never
 * from logs.
 *
 * Cost: one statement, one index point-lookup per job and column (`job_runs_job_healthy`), never a scan
 * of the table.
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
  last_ok: number | null;
  last_failed: number | null;
}

// One bound parameter per job (13): far below the 100-parameter limit.
const JOB_PLACEHOLDERS = JOB_NAMES.map(() => '(?)').join(',');

const FRESHNESS_SQL = `SELECT j.column1 AS job,
  (SELECT MAX(r.finished_at) FROM job_runs r WHERE r.job = j.column1 AND r.healthy = 1) AS last_ok,
  (SELECT MAX(r.finished_at) FROM job_runs r WHERE r.job = j.column1 AND r.healthy = 0) AS last_failed
FROM (VALUES ${JOB_PLACEHOLDERS}) j`;

/** Pure: stale when the last healthy run is older than the job's threshold. */
export function isStale(
  name: JobName,
  lastOk: number | null,
  trackingSince: number | null,
  nowMs: number,
): boolean {
  const threshold = JOB_CADENCE[name].staleAfterMs;
  if (lastOk !== null) return nowMs - lastOk > threshold;
  return trackingSince !== null && nowMs - trackingSince > threshold;
}

export async function readJobHealth(db: Db, nowMs: number): Promise<readonly JobHealth[]> {
  const [rows, since] = await Promise.all([
    db
      .prepare(FRESHNESS_SQL)
      .bind(...JOB_NAMES)
      .all<Row>(),
    db.prepare('SELECT MIN(started_at) AS at FROM job_runs').first<{ at: number | null }>(),
  ]);
  const trackingSince = since?.at ?? null;
  const byJob = new Map(rows.results.map((r) => [r.job, r] as const));
  return JOB_NAMES.map((name) => {
    const row = byJob.get(name);
    const lastOk = row?.last_ok ?? null;
    return {
      name,
      lastOk,
      lastFailed: row?.last_failed ?? null,
      stale: isStale(name, lastOk, trackingSince, nowMs),
    };
  });
}
