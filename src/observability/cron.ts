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
/** `{ from, to }` (epoch ms): ticks the cron skipped on purpose, for maintenance. */
export const MAINTENANCE_KEY = 'cron_maintenance';
/** `{ at, gapMs }`: the last time a heartbeat came more than {@link HEARTBEAT_GAP_MS} after the one before. */
export const GAP_KEY = 'cron_gap';
/** How far a maintenance marker's ends may sit from the heartbeats it brackets (two ticks). */
export const MARKER_SLACK_MS = 2 * 60_000;
/** A gap this long between consecutive heartbeats means ticks were missed (`cron_heartbeat_missing`). */
export const HEARTBEAT_GAP_MS = 5 * 60_000;

type Db = Pick<D1Database, 'prepare'>;

const UPSERT = `INSERT INTO ops_state(key,value,updated_at) VALUES(?1,?2,?3)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`;

async function readState(db: Db, key: string): Promise<{ value: string } | null> {
  return db.prepare('SELECT value FROM ops_state WHERE key=?1').bind(key).first<{ value: string }>();
}

export type MaintenanceRange = { readonly from: number; readonly to: number };

function parseRange(raw: string | undefined): { from: number; to: number } | null {
  try {
    const v = JSON.parse(raw ?? '') as { from?: unknown; to?: unknown };
    return typeof v.from === 'number' && typeof v.to === 'number' ? { from: v.from, to: v.to } : null;
  } catch {
    return null;
  }
}

/**
 * Cheap proof the cron ran this tick; the runbook reads it. It also notices a MISSED stretch: when this
 * heartbeat comes {@link HEARTBEAT_GAP_MS} or more after the previous one, and no maintenance skip was
 * recorded in between, it records the gap (`cron_gap`) for the `cron_heartbeat_missing` alert. A cron that
 * stopped entirely cannot report itself; this fires on the first tick after the silence.
 */
export async function writeHeartbeat(db: Db, nowMs: number): Promise<void> {
  const previous = Number((await readState(db, HEARTBEAT_KEY))?.value);
  if (Number.isFinite(previous) && nowMs - previous >= HEARTBEAT_GAP_MS) {
    const maintenance = parseRange((await readState(db, MAINTENANCE_KEY))?.value);
    // Explained only when the cron said it was skipping across the WHOLE gap: the marker starts at the first
    // tick after the last heartbeat and ends at the last tick before this one (a tick of slack each side).
    // A marker in the middle of a longer silence does not excuse the silence around it.
    const explained =
      maintenance !== null &&
      maintenance.from <= previous + MARKER_SLACK_MS &&
      maintenance.to >= nowMs - MARKER_SLACK_MS;
    if (!explained) {
      await db
        .prepare(UPSERT)
        .bind(GAP_KEY, JSON.stringify({ at: nowMs, gapMs: nowMs - previous }), nowMs)
        .run();
    }
  }
  await db.prepare(UPSERT).bind(HEARTBEAT_KEY, String(nowMs), nowMs).run();
}

/**
 * The cron skips every job under MAINTENANCE_MODE (the migration write freeze). That one ops_state upsert
 * is the only write it makes: a tiny key in a table no migration rebuilds. It says "silence here is on
 * purpose", so the heartbeat gap across a maintenance window is not an alert. Never throws.
 */
export async function markMaintenanceSkip(db: Db, nowMs: number): Promise<void> {
  try {
    const previous = parseRange((await readState(db, MAINTENANCE_KEY))?.value);
    // Consecutive skips extend one window; a skip long after the last starts a new one.
    const continues = previous !== null && nowMs - previous.to <= 3 * 60_000;
    const from = continues && previous ? previous.from : nowMs;
    await db
      .prepare(UPSERT)
      .bind(MAINTENANCE_KEY, JSON.stringify({ from, to: nowMs }), nowMs)
      .run();
    // The freeze is meant to last minutes. Every skipped job is silent, so say so loudly once an hour: a
    // MAINTENANCE_MODE left on is otherwise an outage with no alert (the alert job is skipped too).
    const hours = Math.floor((nowMs - from) / PROLONGED_MS);
    const before = continues && previous ? Math.floor((previous.to - from) / PROLONGED_MS) : 0;
    if (hours >= 1 && hours > before) {
      log('error', 'maintenance_mode_prolonged', { hours, since: new Date(from).toISOString() });
    }
  } catch (error) {
    // Marker unwritable: log it. The first heartbeat after the freeze then sees an unexplained gap and the
    // alert fires: a false alarm is the safe direction, silence is not.
    log('warn', 'maintenance_marker_failed', { error });
  }
}

/** The maintenance marker, or null (absent, malformed or unreadable is "no maintenance recorded"). */
export async function readMaintenance(db: Db): Promise<MaintenanceRange | null> {
  return parseRange((await readState(db, MAINTENANCE_KEY))?.value);
}

/** A maintenance window older than this is reported as prolonged, once per further hour. */
export const PROLONGED_MS = 60 * 60_000;
