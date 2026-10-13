/**
 * Delivery state machine — docs/specs/12-delivery-reliability.md F172, F175, F180, F182,
 * F184, F185 and docs/specs/07-destination-capabilities.md F100.
 *
 * States:
 * - `pending`        accepted into the ledger, not yet claimed
 * - `claimed`        a consumer holds the claim and is sending (F175)
 * - `sent`           provider confirmed delivery (UI: "Delivered")
 * - `accepted`       provider accepted but cannot confirm delivery (F100, e.g. Teams 202)
 * - `retrying`       a retryable attempt failed; the next attempt is scheduled
 * - `dead_lettered`  terminal failure with a taxonomy code (F180)
 * - `suppressed`     a detected duplicate, recorded rather than dropped (F185)
 *
 * Manual replay (F182) never mutates the original row: it plans a *new* delivery with a
 * fresh attempt counter and a `replayOf` pointer, so the history shows both.
 */
import { assertNever, type ErrorCode } from '../platform/errors';

export const DELIVERY_STATES = [
  'pending',
  'claimed',
  'sent',
  'accepted',
  'retrying',
  'dead_lettered',
  'suppressed',
] as const;

export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<DeliveryState> = new Set([
  'sent',
  'accepted',
  'dead_lettered',
  'suppressed',
]);

export type SuppressionReason = 'duplicate' | 'claim_conflict' | 'provider_idempotency';

export type DeliveryEvent =
  /** F175: this consumer won the claim. */
  | { readonly type: 'claim' }
  /** F172/F174: the claim's lease expired without an outcome; the reconciler returns it. */
  | { readonly type: 'lease_expired' }
  | { readonly type: 'delivered' }
  | { readonly type: 'accepted' }
  | { readonly type: 'retry_scheduled'; readonly code: ErrorCode }
  | { readonly type: 'dead_letter'; readonly code: ErrorCode }
  | { readonly type: 'suppress'; readonly reason: SuppressionReason };

export type TransitionResult =
  | { readonly ok: true; readonly from: DeliveryState; readonly to: DeliveryState }
  | {
      readonly ok: false;
      readonly error: 'illegal_transition';
      readonly from: DeliveryState;
      readonly event: DeliveryEvent['type'];
    };

/** Which states each event may leave from. Anything else is rejected. */
const ALLOWED_FROM: { readonly [E in DeliveryEvent['type']]: ReadonlySet<DeliveryState> } = {
  claim: new Set(['pending', 'retrying']),
  lease_expired: new Set(['claimed']),
  delivered: new Set(['claimed']),
  accepted: new Set(['claimed']),
  retry_scheduled: new Set(['claimed']),
  // From `pending` and `retrying` too: the DLQ consumer receives messages whose ledger row
  // never got an outcome (e.g. a batch retried on a key fault until the queue gave up), and
  // such a row must still reach a terminal state (F180).
  dead_letter: new Set(['pending', 'claimed', 'retrying']),
  suppress: new Set(['pending', 'claimed', 'retrying']),
};

function targetOf(event: DeliveryEvent): DeliveryState {
  switch (event.type) {
    case 'claim':
      return 'claimed';
    case 'lease_expired':
      return 'pending';
    case 'delivered':
      return 'sent';
    case 'accepted':
      return 'accepted';
    case 'retry_scheduled':
      return 'retrying';
    case 'dead_letter':
      return 'dead_lettered';
    case 'suppress':
      return 'suppressed';
    default:
      return assertNever(event, 'delivery event');
  }
}

export function isTerminal(state: DeliveryState): boolean {
  return TERMINAL_STATES.has(state);
}

/** Pure transition. Illegal moves are returned as values, never thrown. */
export function transition(from: DeliveryState, event: DeliveryEvent): TransitionResult {
  // Resolve the target first so an impossible event fails loudly in `assertNever`.
  const to = targetOf(event);
  if (!ALLOWED_FROM[event.type].has(from)) {
    return { ok: false, error: 'illegal_transition', from, event: event.type };
  }
  return { ok: true, from, to };
}

export interface ReplaySource {
  readonly id: string;
  readonly state: DeliveryState;
}

export interface ReplayPlan {
  readonly replayOf: string;
  readonly state: 'pending';
  readonly attempts: 0;
}

export type ReplayResult =
  | { readonly ok: true; readonly plan: ReplayPlan }
  | {
      readonly ok: false;
      readonly error: 'already_delivered' | 'not_replayable';
      readonly state: DeliveryState;
    };

/**
 * F182: only a dead-lettered delivery can be replayed. "Replaying a delivery that already
 * succeeded is not offered" — `sent` and `accepted` are refused with `already_delivered`;
 * every other state is still in flight or deliberately suppressed.
 */
export function planReplay(source: ReplaySource): ReplayResult {
  if (source.state === 'dead_lettered') {
    return { ok: true, plan: { replayOf: source.id, state: 'pending', attempts: 0 } };
  }
  const error =
    source.state === 'sent' || source.state === 'accepted' ? 'already_delivered' : 'not_replayable';
  return { ok: false, error, state: source.state };
}
