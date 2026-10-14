/**
 * The attempt vocabulary, kept free of runtime and D1 types so the read model (`api/delivery-view.ts`,
 * which the dashboard type-checks) can import it. `attempts.ts` re-exports these.
 */
export const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx', 'timeout', 'network', 'none'] as const;
export type StatusClass = (typeof STATUS_CLASSES)[number];

export const ATTEMPT_ROW_OUTCOMES = [
  'delivered',
  'accepted',
  'retry_scheduled',
  'dead_lettered',
  'deferred',
] as const;
export type AttemptRowOutcome = (typeof ATTEMPT_ROW_OUTCOMES)[number];

export interface AttemptRecord {
  readonly attempt: number;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly outcome: AttemptRowOutcome;
  readonly errorCode: string | null;
  readonly reason: string | null;
  readonly statusClass: StatusClass;
  readonly retryAfterMs: number | null;
  readonly providerMessageId: string | null;
  readonly possibleDuplicate: boolean;
  /** For a `deferred` row: how many further identical waits were folded into it. */
  readonly repeatCount: number;
}
