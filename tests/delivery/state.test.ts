import { describe, expect, it } from 'vitest';
import {
  DELIVERY_STATES,
  isTerminal,
  planReplay,
  transition,
  type DeliveryEvent,
  type DeliveryState,
} from '../../src/delivery/state';

const EVENTS: readonly DeliveryEvent[] = [
  { type: 'claim' },
  { type: 'lease_expired' },
  { type: 'delivered' },
  { type: 'accepted' },
  { type: 'retry_scheduled', code: 'destination_unavailable' },
  { type: 'dead_letter', code: 'destination_revoked' },
  { type: 'suppress', reason: 'duplicate' },
];

/** The complete legal transition table; every other (state, event) pair is illegal. */
const LEGAL: Record<string, DeliveryState> = {
  'pending:claim': 'claimed',
  'retrying:claim': 'claimed',
  'claimed:lease_expired': 'pending',
  'claimed:delivered': 'sent',
  'claimed:accepted': 'accepted',
  'claimed:retry_scheduled': 'retrying',
  'claimed:dead_letter': 'dead_lettered',
  'retrying:dead_letter': 'dead_lettered',
  'pending:suppress': 'suppressed',
  'claimed:suppress': 'suppressed',
  'retrying:suppress': 'suppressed',
};

describe('delivery state machine', () => {
  const pairs = DELIVERY_STATES.flatMap((s) => EVENTS.map((e) => [s, e] as const));

  it.each(pairs)('%s + %o', (from, event) => {
    const expected = LEGAL[`${from}:${event.type}`];
    const result = transition(from, event);
    if (expected === undefined) {
      expect(result).toEqual({ ok: false, error: 'illegal_transition', from, event: event.type });
    } else {
      expect(result).toEqual({ ok: true, from, to: expected });
    }
  });

  it('terminal states accept no event at all', () => {
    DELIVERY_STATES.filter(isTerminal).forEach((state) =>
      EVENTS.forEach((event) => expect(transition(state, event).ok).toBe(false)),
    );
  });

  it('classifies terminal states', () => {
    expect(DELIVERY_STATES.filter(isTerminal).sort()).toEqual(
      ['accepted', 'dead_lettered', 'sent', 'suppressed'].sort(),
    );
  });

  it('retrying is never terminal, so exhaustion must move it to dead_lettered (F180)', () => {
    expect(isTerminal('retrying')).toBe(false);
    expect(transition('retrying', { type: 'dead_letter', code: 'internal_error' })).toEqual({
      ok: true,
      from: 'retrying',
      to: 'dead_lettered',
    });
  });

  it('throws on an impossible event type', () => {
    expect(() => transition('pending', { type: 'suppress', reason: 'duplicate' })).not.toThrow();
    expect(() => transition('pending', { type: 'bogus' } as never)).toThrow('Unhandled delivery event');
  });
});

describe('planReplay (F182)', () => {
  it('replay_resets_attempts_and_preserves_history', () => {
    expect(planReplay({ id: 'd1', state: 'dead_lettered' })).toEqual({
      ok: true,
      plan: { replayOf: 'd1', state: 'pending', attempts: 0 },
    });
  });

  it.each(['sent', 'accepted'] as const)('replay_of_a_successful_delivery_is_refused (%s)', (state) => {
    expect(planReplay({ id: 'd1', state })).toEqual({ ok: false, error: 'already_delivered', state });
  });

  it.each(['pending', 'claimed', 'retrying', 'suppressed'] as const)('refuses replay from %s', (state) => {
    expect(planReplay({ id: 'd1', state })).toEqual({ ok: false, error: 'not_replayable', state });
  });
});
