import { log } from '../platform/log';

/**
 * D1 write discipline (docs/specs/01-platform-runtime.md F09).
 *
 * D1 retries read-only queries itself (up to two more times) and does NOT retry writes. A transient
 * write failure therefore reaches the caller as an exception, and a webhook ingress that lets it
 * propagate answers 5xx and relies on the provider to resend. `withD1Retry` closes the cheap cases
 * first: bounded attempts, exponential backoff with FULL jitter.
 *
 * Sources (read 2026-10-14):
 *  - https://developers.cloudflare.com/d1/best-practices/retry-queries/ (write queries should be
 *    retried on a transient error; exponential backoff with jitter; the example gives up after 5).
 *  - https://developers.cloudflare.com/d1/observability/debug-d1/ (the error list: which messages
 *    are retryable, which only if the query is idempotent, which are load problems).
 *
 * Idempotency is the caller's contract, and `idempotent` is a required option so it cannot be
 * forgotten. "Network connection lost" can happen AFTER the write committed, so repeating a
 * statement is only correct if repeating it is harmless. A `db.batch()` is one transaction: it
 * either committed whole or not at all, so a whole batch may be retried when each statement in it
 * is itself safe to repeat (INSERT OR IGNORE keyed by a deterministic id, a guarded UPDATE).
 */

export type D1ErrorClass =
  /** The documented action is "re-run": the operation did not complete. Safe for any statement. */
  | 'retry'
  /** Documented as "re-run only if the query is safe to repeat": it may have committed. */
  | 'retry_if_idempotent'
  /**
   * Overload, timeout, memory or CPU limits. Cloudflare's guidance is to reduce load or reshape
   * the work, not to retry, and a retry storm makes an overload worse. Surfaced to the caller
   * (a webhook answers 5xx; the provider's own retry spreads the load).
   */
  | 'shed'
  | 'permanent';

const RETRY: readonly string[] = [
  'reset because its code was updated',
  'storage caused object to be reset',
  "can't read from request stream because client disconnected",
];
const RETRY_IF_IDEMPOTENT: readonly string[] = [
  'network connection lost',
  'replica disconnected from primary',
  'cannot resolve d1 db due to transient issue on remote node',
];
const SHED: readonly string[] = [
  'd1 db is overloaded',
  'exceeded timeout which caused object to be reset',
  'exceeded its memory limit',
  'exceeded its cpu time limit',
];

/**
 * Classify a thrown D1 error by its message. Messages are matched case-insensitively as
 * substrings because D1 wraps them (`D1_ERROR: <message>: SQLITE_...`). Anything unrecognised,
 * including every constraint violation, is `permanent`: a programming error to surface, not to repeat.
 * UNVERIFIED: the exact wording is taken from the documentation page above and has not been
 * observed against a real D1; a wording change makes a transient error `permanent` (surfaced,
 * never silently retried), which is the safe direction.
 */
export function classifyD1Error(error: unknown): D1ErrorClass {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (SHED.some((m) => message.includes(m))) return 'shed';
  if (RETRY.some((m) => message.includes(m))) return 'retry';
  if (RETRY_IF_IDEMPOTENT.some((m) => message.includes(m))) return 'retry_if_idempotent';
  return 'permanent';
}

export interface D1RetryOptions {
  /** Safe to run twice with the same effect? See the file comment. Required. */
  readonly idempotent: boolean;
  /** Total attempts including the first. Default 3, capped at 5 (the documented example's limit). */
  readonly attempts?: number;
  /** Backoff base in ms. Delay before retry n is a uniform random in [0, min(capMs, baseMs * 2^n)). */
  readonly baseMs?: number;
  readonly capMs?: number;
  /** What the retry is for, for the log line. A fixed string of ours, never SQL or a value. */
  readonly label?: string;
  readonly sleep?: (ms: number) => Promise<void>;
}

const MAX_ATTEMPTS = 5;
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying transient D1 failures a bounded number of times. `random` is injectable
 * (returns [0,1)) so tests are deterministic. The last error is rethrown unchanged.
 */
export async function withD1Retry<T>(
  fn: () => Promise<T>,
  options: D1RetryOptions,
  random: () => number = Math.random,
): Promise<T> {
  const attempts = Math.min(Math.max(1, Math.floor(options.attempts ?? 3)), MAX_ATTEMPTS);
  const baseMs = options.baseMs ?? 50;
  const capMs = options.capMs ?? 1000;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const kind = classifyD1Error(e);
      const retryable = kind === 'retry' || (kind === 'retry_if_idempotent' && options.idempotent);
      if (!retryable || attempt >= attempts) {
        if (kind === 'shed') log('warn', 'd1_write_shed', { label: options.label ?? 'write' });
        throw e;
      }
      log('info', 'd1_write_retry', { label: options.label ?? 'write', attempt, class: kind });
      await sleep(Math.floor(random() * Math.min(capMs, baseMs * 2 ** attempt)));
    }
  }
}

/**
 * The ingress write: delivery row + outbox row (+ noise bookkeeping) in one `db.batch()`.
 *
 * Retrying the WHOLE batch is safe for two reasons. A batch is one transaction, so a failure
 * leaves either nothing or everything. And every statement in it is idempotent by construction:
 * `INSERT OR IGNORE` keyed by a deterministic delivery id (the outbox insert is further guarded by
 * `changes() > 0`), a guarded upsert, or a DELETE by key. If the first attempt actually committed
 * (a connection lost after the commit), the retry changes zero rows and the event is still queued
 * exactly once; only the prompt `waitUntil` dispatch is skipped and the every-minute outbox
 * reconciler (F174) picks the row up.
 */
export function ingressBatch(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<D1Result<unknown>[]> {
  return withD1Retry(() => db.batch(statements), { idempotent: true, label: 'ingress_batch' });
}
