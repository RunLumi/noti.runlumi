/**
 * The alert registry (docs/specs/13-observability.md F200, F201). Each alert reads ONE measurable signal
 * (`signals.ts`), compares it with a typed threshold (`thresholds.ts`) and names the runbook section that
 * says what to do (`docs/RUNBOOK.md`, heading `Alert: <id>`; `tests/observability/alert-runbook.test.ts`
 * fails when one is missing). Alert text carries the id, severity, value and threshold only: never a
 * tenant id, a payload, a URL or a binding value.
 *
 * Built: ten alerts from signals D1 and the boot report can answer. NOT built (needs data we do not have):
 * the spec's other alerts that read Analytics Engine, queue depth or provider health endpoints.
 */
import type { Signals } from './signals';
import { CLEAR_TICKS, RENOTIFY_MS, THRESHOLDS } from './thresholds';

export type AlertSeverity = 'critical' | 'warning';
export type AlertUnit = 'count' | 'ms';

export const ALERT_IDS = [
  'job_stale',
  'outbox_stall',
  'dead_letter_spike',
  'breaker_open_many',
  'key_config_fault',
  'credentials_quarantined_nonzero',
  'queue_backlog',
  'ingress_drop_rate',
  'cron_heartbeat_missing',
  'dlq_consumer_no_progress',
] as const;
export type AlertId = (typeof ALERT_IDS)[number];

export interface AlertDef {
  readonly id: AlertId;
  readonly severity: AlertSeverity;
  /** One line, static: what the condition means. */
  readonly summary: string;
  readonly unit: AlertUnit;
  /** Fires when the signal is greater than or equal to this. */
  readonly threshold: number;
  /** The signal value; `null` when it could not be read this tick (the alert then neither fires nor resolves). */
  readonly read: (s: Signals) => number | null;
  /** Repeat the notification this often while the alert keeps firing. */
  readonly renotifyMs: number;
  /**
   * Consecutive breached evaluations before it fires. 2 where a single tick can be a false reading
   * (right after a maintenance window every job is overdue until its next run); 1 where the signal
   * is already an observed, sustained fact.
   */
  readonly confirmTicks: number;
  /**
   * Consecutive clear evaluations before RESOLVED is sent, so a signal that flaps around its threshold
   * does not send a FIRING and a RESOLVED every few minutes (hysteresis).
   */
  readonly clearTicks: number;
}

/** The heading anchor in docs/RUNBOOK.md (`### Alert: job_stale`). */
export function runbookAnchor(id: AlertId): string {
  return `alert-${id}`;
}

export function runbookHeading(id: AlertId): string {
  return `Alert: ${id}`;
}

export const ALERTS: readonly AlertDef[] = [
  {
    id: 'job_stale',
    severity: 'critical',
    summary: 'A cron job has not completed for more than three of its cadences.',
    unit: 'count',
    threshold: THRESHOLDS.jobsStale,
    read: (s) => s.jobsStale,
    renotifyMs: RENOTIFY_MS.critical,
    confirmTicks: 2,
    clearTicks: CLEAR_TICKS,
  },
  {
    id: 'outbox_stall',
    severity: 'critical',
    summary: 'Outbox, claim or retry rows are stuck past their thresholds; deliveries are not moving.',
    unit: 'count',
    threshold: THRESHOLDS.outboxStalled,
    read: (s) => s.outboxStalled,
    renotifyMs: RENOTIFY_MS.critical,
    confirmTicks: 1,
    clearTicks: CLEAR_TICKS,
  },
  {
    id: 'dead_letter_spike',
    severity: 'warning',
    summary: 'Many deliveries dead-lettered in the last 15 minutes.',
    unit: 'count',
    threshold: THRESHOLDS.deadLettersRecent,
    read: (s) => s.deadLettersRecent,
    renotifyMs: RENOTIFY_MS.warning,
    confirmTicks: 1,
    clearTicks: CLEAR_TICKS,
  },
  {
    id: 'breaker_open_many',
    severity: 'warning',
    summary: 'Several destination circuit breakers are open at once.',
    unit: 'count',
    threshold: THRESHOLDS.breakersOpen,
    read: (s) => s.breakersOpen,
    renotifyMs: RENOTIFY_MS.warning,
    confirmTicks: 1,
    clearTicks: CLEAR_TICKS,
  },
  {
    id: 'key_config_fault',
    severity: 'critical',
    summary: 'The Worker reports a required configuration fault (storage, credentials or queue binding).',
    unit: 'count',
    threshold: THRESHOLDS.keyConfigFaults,
    read: (s) => s.keyConfigFaults,
    renotifyMs: RENOTIFY_MS.critical,
    confirmTicks: 1,
    clearTicks: CLEAR_TICKS,
  },
  {
    id: 'credentials_quarantined_nonzero',
    severity: 'warning',
    summary: 'At least one integration has credentials the Worker cannot open (quarantined).',
    unit: 'count',
    threshold: THRESHOLDS.credentialsQuarantined,
    read: (s) => s.credentialsQuarantined,
    renotifyMs: RENOTIFY_MS.warning,
    confirmTicks: 1,
    clearTicks: CLEAR_TICKS,
  },
  {
    id: 'queue_backlog',
    severity: 'critical',
    summary: 'The oldest pending delivery is older than 15 minutes (backlog age, not depth).',
    unit: 'ms',
    threshold: THRESHOLDS.oldestPendingAgeMs,
    read: (s) => s.oldestPendingAgeMs,
    renotifyMs: RENOTIFY_MS.critical,
    confirmTicks: 1,
    clearTicks: CLEAR_TICKS,
  },
  {
    id: 'ingress_drop_rate',
    severity: 'warning',
    summary: 'Several provider sources dropped events (flood limit) in the last 15 minutes.',
    unit: 'count',
    threshold: THRESHOLDS.sourcesDropping,
    read: (s) => s.sourcesDropping,
    renotifyMs: RENOTIFY_MS.warning,
    confirmTicks: 1,
    clearTicks: CLEAR_TICKS,
  },
  {
    id: 'cron_heartbeat_missing',
    severity: 'critical',
    summary: 'The cron missed ticks: a gap of five minutes or more between healthy heartbeats.',
    unit: 'ms',
    threshold: THRESHOLDS.heartbeatMaxGapMs,
    read: (s) => s.heartbeatMaxGapMs,
    renotifyMs: RENOTIFY_MS.critical,
    confirmTicks: 2,
    clearTicks: CLEAR_TICKS,
  },
  {
    id: 'dlq_consumer_no_progress',
    severity: 'critical',
    summary:
      'Ledger rows are stuck for hours: dead-letter messages may exist that nothing is consuming (a proxy, not queue depth).',
    unit: 'count',
    threshold: THRESHOLDS.deadLetterStuckRows,
    read: (s) => s.deadLetterStuckRows,
    renotifyMs: RENOTIFY_MS.critical,
    confirmTicks: 1,
    clearTicks: CLEAR_TICKS,
  },
];
