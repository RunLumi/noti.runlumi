/**
 * The cron job fleet and its expected cadence (docs/specs/13-observability.md F192, F190): ONE table
 * that the scheduler (`src/index.ts`), the staleness check (`job-health.ts`), the `job_stale` alert and
 * the runbook all read, so a job cannot be scheduled without a cadence or checked against a different one.
 *
 * Every job runs on the platform's every-minute trigger (`triggers.crons` in wrangler.jsonc); a job that
 * does its work less often (retention is hourly) still RUNS every minute and records `skipped` when the
 * throttle says there is nothing to do, so "ran" and "did work" are distinguishable (F192).
 */

export const CRON_INTERVAL_MS = 60_000;

/** A job is stale when it has not completed healthily for this many cadences (F192). */
export const STALE_AFTER_CADENCES = 3;

export const JOB_NAMES = [
  'heartbeat',
  'stall_detection',
  'alerts',
  'outbox_reconcile',
  'noise_release',
  'credential_maintenance',
  'rate_limit_prune',
  'workspace_purge',
  'retention_purge',
  'routing_decisions_purge',
  'noise_purge',
  'expired_auth_purge',
  'dedup_purge',
  'egress_maintenance',
] as const;

export type JobName = (typeof JOB_NAMES)[number];

export interface JobCadence {
  /** How often the scheduler runs the job. */
  readonly intervalMs: number;
  /** Overdue beyond this, `job_stale` fires. Derived from the interval, never typed twice. */
  readonly staleAfterMs: number;
  /** One line for the runbook's job table. */
  readonly purpose: string;
}

function every(intervalMs: number, purpose: string): JobCadence {
  return { intervalMs, staleAfterMs: intervalMs * STALE_AFTER_CADENCES, purpose };
}

export const JOB_CADENCE: Readonly<Record<JobName, JobCadence>> = {
  heartbeat: every(CRON_INTERVAL_MS, 'Proves the cron fired (one UPSERT).'),
  stall_detection: every(
    CRON_INTERVAL_MS,
    'Counts stuck outbox, claim and retry rows; logs on entry and recovery.',
  ),
  alerts: every(CRON_INTERVAL_MS, 'Evaluates the alert registry and notifies the sinks.'),
  outbox_reconcile: every(
    CRON_INTERVAL_MS,
    'Releases stale claims, publishes due outbox rows, purges the outbox.',
  ),
  noise_release: every(
    CRON_INTERVAL_MS,
    'Releases held (quiet-hours, digest, grouped) events through the outbox.',
  ),
  credential_maintenance: every(
    CRON_INTERVAL_MS,
    'Legacy credential migration and KEK rewrap, bounded per tick.',
  ),
  rate_limit_prune: every(CRON_INTERVAL_MS, 'Drops expired fixed-window rate-limit counters.'),
  workspace_purge: every(CRON_INTERVAL_MS, 'Purges the next workspace whose deletion window has elapsed.'),
  retention_purge: every(
    CRON_INTERVAL_MS,
    'Retention for deliveries, audit, attempts, destination health and job runs (hourly throttle).',
  ),
  routing_decisions_purge: every(CRON_INTERVAL_MS, 'Routing provenance retention.'),
  noise_purge: every(CRON_INTERVAL_MS, 'Released and failed noise-control records.'),
  expired_auth_purge: every(CRON_INTERVAL_MS, 'Expired sessions, one-time tokens, install states.'),
  dedup_purge: every(CRON_INTERVAL_MS, 'Expired dedup rows.'),
  egress_maintenance: every(
    CRON_INTERVAL_MS,
    'Egress-guard bucket purge; custom-webhook host re-resolution (only while the feature flag is on).',
  ),
};

export function isJobName(value: string): value is JobName {
  return (JOB_NAMES as readonly string[]).includes(value);
}
