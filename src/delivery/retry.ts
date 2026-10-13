/**
 * Retry policy — docs/specs/12-delivery-reliability.md F177 (two-tier backoff), F178
 * (`Retry-After`), F179/F180 (permanent errors and exhaustion dead-letter), and
 * docs/specs/01-platform-runtime.md F08.
 *
 * Pure: the random source and the clock are injected so every branch is deterministic
 * under test.
 *
 * Attempt numbering is 1-based and comes from the delivery ledger (F184 `attempts`), NOT
 * from the queue message's `attempts`: the Tier 2 ladder outlives any queue delay, so a
 * long wait is parked in D1 (`transport: 'schedule'`) and re-enqueued as a fresh message,
 * which resets the queue's own counter.
 */
import { assertNever, isRetryable, type ErrorCode } from '../platform/errors';

/** Returns a float in [0, 1). `Math.random` in production, a seeded sequence in tests. */
export type RandomSource = () => number;

export interface RetryPolicy {
  /** F177 Tier 1 base, seconds. */
  readonly baseSeconds: number;
  /** F177 Tier 1 cap, seconds. */
  readonly capSeconds: number;
  /** F177: number of Tier 1 attempts (attempts 1..N use Full Jitter for the next delay). */
  readonly transientAttempts: number;
  /** F177 Tier 2: fixed delays before each chronic attempt. Its length sets the total. */
  readonly chronicLadderSeconds: readonly number[];
  /** F178: ceiling for a provider-supplied `Retry-After`. */
  readonly retryAfterCapSeconds: number;
  /**
   * Upper bound for `msg.retry({ delaySeconds })`. Anything longer is parked in D1 and
   * re-enqueued by the reconciler.
   */
  readonly queueMaxDelaySeconds: number;
}

const HOUR = 3600;

/**
 * Cloudflare Queues accepts `delaySeconds` up to 24 hours (86,400 s). Source: Cloudflare
 * Queues documentation, developers.cloudflare.com/queues, as confirmed in the PR #10 review
 * on 2026-10-13. Longer waits are parked in D1 instead.
 */
export const QUEUE_MAX_DELAY_SECONDS = 24 * HOUR;

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseSeconds: 2,
  capSeconds: 900,
  transientAttempts: 6,
  chronicLadderSeconds: [2 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR, 48 * HOUR, 72 * HOUR, 96 * HOUR],
  // Engineering judgment: F178 requires a ceiling but names no number. One hour keeps an
  // absurd value (86400) from consuming the attempt budget while still honouring any
  // realistic throttle window.
  retryAfterCapSeconds: HOUR,
  queueMaxDelaySeconds: QUEUE_MAX_DELAY_SECONDS,
};

/**
 * Fraction of additive jitter on fixed delays (Tier 2 ladder, `Retry-After`). F177 asks
 * that every retry path is jittered; full jitter would let a 2 h ladder step fire after 0 s
 * and would violate `Retry-After`, so fixed delays are only ever *extended*, by ≤10%.
 */
export const FIXED_DELAY_JITTER_FRACTION = 0.1;

/** Total attempts implied by a policy: Tier 1 plus one per ladder rung. 13 by default. */
export function maxAttempts(policy: RetryPolicy = DEFAULT_RETRY_POLICY): number {
  return policy.transientAttempts + policy.chronicLadderSeconds.length;
}

function sample(random: RandomSource): number {
  const r = random();
  if (!(r >= 0 && r < 1)) throw new RangeError(`RandomSource must return a value in [0, 1), got ${r}`);
  return r;
}

function assertAttempt(attempt: number): void {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt must be a positive integer, got ${attempt}`);
  }
}

/** F177 Tier 1 Full Jitter: `random(0, min(cap, base · 2^attempt))`, whole seconds. */
export function fullJitterDelay(
  attempt: number,
  random: RandomSource,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): number {
  assertAttempt(attempt);
  const ceiling = Math.min(policy.capSeconds, policy.baseSeconds * 2 ** attempt);
  return Math.floor(sample(random) * (ceiling + 1));
}

/** Extend a fixed delay by up to {@link FIXED_DELAY_JITTER_FRACTION}; never shortens it. */
export function additiveJitter(seconds: number, random: RandomSource): number {
  return seconds + Math.floor(sample(random) * (Math.floor(seconds * FIXED_DELAY_JITTER_FRACTION) + 1));
}

/**
 * Computed (non-provider) delay before the attempt after `attempt`, or `null` when the
 * attempt budget is spent.
 */
export function backoffDelay(
  attempt: number,
  random: RandomSource,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): number | null {
  assertAttempt(attempt);
  if (attempt >= maxAttempts(policy)) return null;
  if (attempt < policy.transientAttempts) return fullJitterDelay(attempt, random, policy);
  const rung = policy.chronicLadderSeconds[attempt - policy.transientAttempts];
  return rung === undefined ? null : additiveJitter(rung, random);
}

/** F178: clamp a provider delay into `[1, cap]`; `null` when absent or not a finite number. */
export function clampRetryAfter(
  seconds: number | null | undefined,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): number | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  return Math.min(policy.retryAfterCapSeconds, Math.max(1, Math.ceil(seconds)));
}

// RFC 9110 §5.6.7: IMF-fixdate, plus the obsolete RFC 850 and asctime forms recipients
// must still accept.
const HTTP_DATE_FORMS: readonly RegExp[] = [
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/,
  /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT$/,
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/,
];

/**
 * Parse an RFC 9110 `Retry-After` header (`delay-seconds` or `HTTP-date`) into whole
 * seconds from `nowMs`. Returns `null` when absent or malformed, so the caller falls back
 * to computed backoff and raises a metric (F178). A date in the past yields 0.
 */
export function parseRetryAfter(header: string | null | undefined, nowMs: number): number | null {
  const value = header?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  if (!HTTP_DATE_FORMS.some((form) => form.test(value))) return null;
  // asctime carries no zone; RFC 9110 defines every HTTP-date as UTC.
  const at = Date.parse(value.endsWith('GMT') ? value : `${value} GMT`);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}

export type AttemptOutcome =
  | { readonly kind: 'delivered' }
  /** F100: the provider accepted but cannot confirm delivery (e.g. Teams 202). Still final. */
  | { readonly kind: 'accepted' }
  | {
      readonly kind: 'failed';
      readonly code: ErrorCode;
      /** Already parsed from headers/body by the destination adapter (F178). */
      readonly retryAfterSeconds?: number | null;
    };

export type RetryTransport = 'queue' | 'schedule';

export type RetryDecision =
  | { readonly action: 'ack' }
  | {
      readonly action: 'retry';
      readonly delaySeconds: number;
      readonly basis: 'backoff' | 'retry_after';
      /** `queue` → `msg.retry({ delaySeconds })`; `schedule` → persist `next_attempt_at`, ack. */
      readonly transport: RetryTransport;
      /** A provider value was present but unusable; F178 wants a metric for it. */
      readonly malformedRetryAfter: boolean;
    }
  | {
      readonly action: 'dead_letter';
      readonly reason: 'permanent_error' | 'attempts_exhausted';
      readonly code: ErrorCode;
    };

export interface RetryInput {
  /** 1-based number of the attempt that just finished. */
  readonly attempt: number;
  readonly outcome: AttemptOutcome;
  readonly random: RandomSource;
  readonly policy?: RetryPolicy;
}

/**
 * Decide what to do after an attempt. Permanent codes dead-letter immediately (F179 — a
 * revoked webhook must not burn 13 attempts; Discord 404 must never be retried). A
 * retryable code retries until the budget is spent, then dead-letters to a terminal state
 * (F180: never left as `retrying`).
 */
export function decideRetry(input: RetryInput): RetryDecision {
  assertAttempt(input.attempt);
  const { outcome } = input;
  switch (outcome.kind) {
    case 'delivered':
    case 'accepted':
      return { action: 'ack' };
    case 'failed':
      return decideFailure(input.attempt, outcome.code, outcome.retryAfterSeconds, input);
    default:
      return assertNever(outcome, 'attempt outcome');
  }
}

function decideFailure(
  attempt: number,
  code: ErrorCode,
  retryAfter: number | null | undefined,
  input: RetryInput,
): RetryDecision {
  const policy = input.policy ?? DEFAULT_RETRY_POLICY;
  if (!isRetryable(code)) return { action: 'dead_letter', reason: 'permanent_error', code };
  const computed = backoffDelay(attempt, input.random, policy);
  if (computed === null) return { action: 'dead_letter', reason: 'attempts_exhausted', code };
  const clamped = clampRetryAfter(retryAfter, policy);
  const malformedRetryAfter = retryAfter !== null && retryAfter !== undefined && clamped === null;
  // F178: a server-supplied Retry-After overrides computed backoff.
  const delaySeconds = clamped === null ? computed : additiveJitter(clamped, input.random);
  return {
    action: 'retry',
    delaySeconds,
    basis: clamped === null ? 'backoff' : 'retry_after',
    transport: delaySeconds > policy.queueMaxDelaySeconds ? 'schedule' : 'queue',
    malformedRetryAfter,
  };
}
