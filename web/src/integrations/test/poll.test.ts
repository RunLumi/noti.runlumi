import { describe, expect, it } from 'vitest';
import { DELIVERY_STATES, type DeliveryItem, type DeliveryState } from '../../deliveries/api';
import { PANEL_TERMINAL, outcomeOf, pollTest, POLL_MAX_READ_FAILURES } from './poll';

const delivery = (state: DeliveryState): DeliveryItem => ({
  id: 'd',
  integration: { id: 'i', name: 'n', repo: null, destination: 'slack', destinationHost: null },
  integrationExists: true,
  integrationStatus: 'available',
  state,
  attempts: 1,
  error: null,
  createdAt: null,
  updatedAt: '2026-10-14T00:00:00Z',
  nextAttemptAt: null,
  replayOf: null,
  isTest: true,
  latestReplayState: null,
  canReplay: false,
});

describe('outcomeOf', () => {
  it.each([
    ['sent', 'sent'],
    ['accepted', 'accepted'],
    ['dead_lettered', 'failed'],
    ['retrying', 'retrying'],
    ['pending', null],
    ['claimed', null],
    ['suppressed', null],
  ] as const)('%s -> %s', (state, kind) => {
    expect(outcomeOf(delivery(state))?.kind ?? null).toBe(kind);
  });

  it('agrees with PANEL_TERMINAL for every state', () => {
    for (const state of DELIVERY_STATES)
      expect(outcomeOf(delivery(state)) !== null, state).toBe(PANEL_TERMINAL.has(state));
  });
});

/** A fake clock: `sleep` advances it, so the bounds are tested without waiting. */
function clock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: (ms: number) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
  };
}

describe('pollTest', () => {
  it('returns at the first terminal state, without sleeping first', async () => {
    const c = clock();
    const outcome = await pollTest({
      read: () => Promise.resolve(delivery('sent')),
      cancelled: () => false,
      ...c,
    });
    expect(outcome).toMatchObject({ kind: 'sent' });
    expect(c.sleeps).toEqual([]);
  });

  it('keeps polling through pending and claimed, at the interval', async () => {
    const c = clock();
    const states: DeliveryState[] = ['pending', 'claimed', 'accepted'];
    const outcome = await pollTest({
      read: () => Promise.resolve(delivery(states.shift() ?? 'accepted')),
      cancelled: () => false,
      intervalMs: 500,
      ...c,
    });
    expect(outcome).toMatchObject({ kind: 'accepted' });
    expect(c.sleeps).toEqual([500, 500]);
  });

  it('gives up at the bound with a timeout, never forever', async () => {
    const c = clock();
    const outcome = await pollTest({
      read: () => Promise.resolve(delivery('pending')),
      cancelled: () => false,
      intervalMs: 1000,
      maxMs: 5000,
      ...c,
    });
    expect(outcome).toEqual({ kind: 'timeout' });
    expect(c.now()).toBeLessThanOrEqual(5000);
    expect(c.sleeps.length).toBe(5);
  });

  it('stops quietly when cancelled, before and after a read', async () => {
    const c = clock();
    expect(
      await pollTest({ read: () => Promise.resolve(delivery('sent')), cancelled: () => true, ...c }),
    ).toBeNull();
    let calls = 0;
    expect(
      await pollTest({
        read: () => Promise.resolve(delivery('sent')),
        cancelled: () => ++calls > 1,
        ...c,
      }),
    ).toBeNull();
  });

  it('tolerates a brief read failure but surfaces a persistent one', async () => {
    const c = clock();
    let n = 0;
    const flaky = await pollTest({
      read: () =>
        ++n < POLL_MAX_READ_FAILURES ? Promise.reject(new Error('x')) : Promise.resolve(delivery('sent')),
      cancelled: () => false,
      ...c,
    });
    expect(flaky).toMatchObject({ kind: 'sent' });
    await expect(
      pollTest({ read: () => Promise.reject(new Error('down')), cancelled: () => false, ...clock() }),
    ).rejects.toThrow('down');
  });

  it('a successful read resets the failure count', async () => {
    const c = clock();
    const script: (DeliveryState | Error)[] = [
      new Error('a'),
      new Error('b'),
      'pending',
      new Error('c'),
      new Error('d'),
      'sent',
    ];
    const outcome = await pollTest({
      read: () => {
        const next = script.shift();
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(delivery(next ?? 'sent'));
      },
      cancelled: () => false,
      ...c,
    });
    expect(outcome).toMatchObject({ kind: 'sent' });
  });
});
