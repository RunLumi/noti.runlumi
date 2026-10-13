import { ApiError } from '../../lib/api';
import type { DeliveryItem, DeliveryState } from '../../deliveries/api';

/**
 * Waiting for a test to finish (ADR 0018). The test is an ordinary delivery, so its state is
 * read from the delivery API; this module decides when to stop waiting and what the outcome
 * is. Pure apart from the injected `read` and `sleep`, so the bounds are unit-tested.
 *
 * "Terminal for the panel" is wider than terminal for the ledger: `retrying` stops the wait
 * because the person has something to read (the first attempt failed, Noti is trying again) and
 * nothing to do. `pending` and `claimed` are in flight.
 */
export const PANEL_TERMINAL: ReadonlySet<DeliveryState> = new Set([
  'sent',
  'accepted',
  'dead_lettered',
  'retrying',
]);

export const POLL_INTERVAL_MS = 1_000;
/** The queue normally answers in seconds; beyond this the panel says so and points to Activity. */
export const POLL_MAX_MS = 30_000;
/** Consecutive failed reads tolerated before the error is surfaced. */
export const POLL_MAX_READ_FAILURES = 3;
/** Longest single wait after a 429 while polling. */
export const RATE_LIMIT_WAIT_MAX_MS = 10_000;

export type TestOutcome =
  | { readonly kind: 'sent' | 'accepted' | 'failed' | 'retrying'; readonly delivery: DeliveryItem }
  | { readonly kind: 'timeout' };

export function outcomeOf(delivery: DeliveryItem): TestOutcome | null {
  switch (delivery.state) {
    case 'sent':
      return { kind: 'sent', delivery };
    case 'accepted':
      return { kind: 'accepted', delivery };
    case 'dead_lettered':
      return { kind: 'failed', delivery };
    case 'retrying':
      return { kind: 'retrying', delivery };
    default:
      return null;
  }
}

export interface PollDeps {
  readonly read: () => Promise<DeliveryItem>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly cancelled: () => boolean;
  readonly intervalMs?: number;
  readonly maxMs?: number;
}

/** Resolves with the outcome, `null` if cancelled, or rejects after repeated read failures. */
export async function pollTest(deps: PollDeps): Promise<TestOutcome | null> {
  const interval = deps.intervalMs ?? POLL_INTERVAL_MS;
  const max = deps.maxMs ?? POLL_MAX_MS;
  const started = deps.now();
  let failures = 0;
  for (;;) {
    if (deps.cancelled()) return null;
    try {
      const delivery = await deps.read();
      failures = 0;
      const outcome = outcomeOf(delivery);
      if (outcome) return deps.cancelled() ? null : outcome;
    } catch (error) {
      // Rate limited while polling: not a failure. Wait as asked (bounded) and keep going; if the
      // time runs out the result is `timeout` ("still waiting, see Activity"), never an error.
      if (error instanceof ApiError && error.status === 429) {
        if (deps.now() - started >= max) return { kind: 'timeout' };
        await deps.sleep(
          Math.min(Math.max(interval, (error.retryAfter ?? 0) * 1000), RATE_LIMIT_WAIT_MAX_MS),
        );
        continue;
      }
      failures += 1;
      if (failures >= POLL_MAX_READ_FAILURES) throw error;
    }
    if (deps.now() - started >= max) return { kind: 'timeout' };
    await deps.sleep(interval);
  }
}
