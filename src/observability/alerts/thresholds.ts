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
  /**
   * `breaker_open`: integrations whose breaker is holding deliveries back RIGHT NOW (open inside its window, or a
   * half-open probe in flight). An open row whose window has passed holds nothing, so it does not keep this alert up.
   */
  breakersHolding: 1,
  /** `breaker_open_many`: integrations whose breaker is open or half-open right now (stored state). */
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
  /** `cron_heartbeat_missing`: a gap this long between consecutive heartbeats (cron.ts HEARTBEAT_GAP_MS)... */
  heartbeatMaxGapMs: 5 * MINUTE,
  /** ...recorded inside this trailing window, so a gap stays visible for half an hour. */
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

/** Consecutive clear evaluations before an alert resolves (hysteresis; at a minute a tick, three minutes). */
export const CLEAR_TICKS = 3;

/** A notice a sink did not accept is retried this many times, then dropped (it stays in the log). */
export const MAX_NOTIFY_FAILURES = 6;

/** Total time one evaluation may spend in sinks, so a hung webhook cannot delay the jobs after it. */
export const SINK_BUDGET_MS = 15_000;

/**
 * After the last maintenance skip, the alerts that read backlog or job freshness stay quiet this long: the
 * first ticks after a freeze see every job overdue and the outbox undrained, then the cron catches up
 * (docs/RUNBOOK.md "Maintenance windows"). Longer than the longest catch-up we expect (a few ticks).
 */
export const SETTLE_AFTER_MAINTENANCE_MS = 10 * MINUTE;
