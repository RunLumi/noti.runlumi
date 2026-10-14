/**
 * Alert thresholds and windows, as typed constants in one place (docs/specs/13-observability.md F200).
 * Every number is a starting value chosen from the spec's own figures (F200 `outbox_stalled` at five
 * minutes; F192 `3 x cadence`), not a measured baseline: there is no production traffic to tune them
 * against yet, and docs/RUNBOOK.md says so. Change a value here and the registry, the signals and the
 * runbook text all follow.
 */
const MINUTE = 60_000;

export const THRESHOLDS = {
  /** `job_stale`: how many stale jobs fire it (staleness itself is `3 x cadence`, cadence.ts). */
  jobsStale: 1,
  /** `outbox_stall`: any stuck outbox, claim or retry row (same predicate as stall.ts). */
  outboxStalled: 1,
  /** `dead_letter_spike`: attempts that dead-lettered a delivery inside the window. */
  deadLetterWindowMs: 15 * MINUTE,
  deadLettersRecent: 20,
  /** `breaker_open_many`: integrations whose breaker is open or half-open right now. */
  breakersOpen: 3,
  /** `key_config_fault`: any required binding fault in the boot report. */
  keyConfigFaults: 1,
  /** `credentials_quarantined_nonzero`: any integration whose credentials the Worker cannot open. */
  credentialsQuarantined: 1,
  /** `queue_backlog`: age of the oldest delivery still `pending` (age, not depth: F198). */
  oldestPendingAgeMs: 15 * MINUTE,
  /** `ingress_drop_rate`: provider sources that dropped events inside the window. */
  dropWindowMs: 15 * MINUTE,
  sourcesDropping: 3,
  /** `cron_heartbeat_missing`: a gap this long between consecutive healthy heartbeats... */
  heartbeatMaxGapMs: 5 * MINUTE,
  /** ...looked for inside this trailing window, so a gap stays visible for half an hour. */
  heartbeatWindowMs: 30 * MINUTE,
  /** `dlq_consumer_no_progress`: ledger rows non-terminal for longer than this... */
  deadLetterStuckMs: 6 * 60 * MINUTE,
  /** ...and how many of them fire it. */
  deadLetterStuckRows: 1,
} as const;

/** Re-notify cadence while an alert keeps firing, by severity. */
export const RENOTIFY_MS = { critical: 60 * MINUTE, warning: 6 * 60 * MINUTE } as const;

/** After a sink failure, try again this long after the failure rather than waiting a full cadence. */
export const NOTIFY_RETRY_MS = 10 * MINUTE;
