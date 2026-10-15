import { describe, expect, it } from 'vitest';
import type { DeliveryItem } from '../../deliveries/api';
import type { Integration } from '../../lib/api';
import { repairsFor, summariseHealth } from './repair';

const integration = (over: Partial<Integration> = {}): Integration => ({
  id: 'i1',
  name: 'Builds',
  repo: 'acme/web',
  sourceId: null,
  eventTypes: [],
  destination: 'slack',
  destinationHost: null,
  enabled: true,
  credentials: 'ok',
  revoked: false,
  keyDestroyed: false,
  credentialFingerprint: null,
  filters: {},
  filtersInvalid: false,
  filtersNewer: false,
  noise: null,
  noiseInvalid: false,
  noiseNewer: false,
  createdAt: null,
  updatedAt: null,
  health: null,
  ...over,
});

const delivery = (state: DeliveryItem['state'], code: string | null = null): DeliveryItem =>
  ({
    id: `d-${state}-${code}`,
    state,
    isTest: false,
    updatedAt: '2026-10-01T00:00:00Z',
    error: code ? { code, messageKey: null, retryable: false, userActionable: true } : null,
  }) as unknown as DeliveryItem;

const kinds = (i: Integration, recent: DeliveryItem[] = []) => repairsFor(i, recent).map((r) => r.kind);

describe('repairsFor', () => {
  it('has nothing to repair on a healthy integration', () => {
    expect(kinds(integration(), [delivery('sent')])).toEqual([]);
  });
  it('quarantined credentials point at the credentials section', () => {
    expect(repairsFor(integration({ credentials: 'quarantined' }), [])).toEqual([
      { kind: 'quarantined', target: 'credentials' },
    ]);
  });
  it('a latest delivery the destination rejected asks for a new address', () => {
    for (const code of ['destination_revoked', 'destination_credentials_invalid', 'destination_unauthorized'])
      expect(kinds(integration(), [delivery('dead_lettered', code)])).toEqual(['destination_rejected']);
  });
  it('an old rejection that a later success cleared is history, not a repair', () => {
    expect(
      kinds(integration(), [delivery('sent'), delivery('dead_lettered', 'destination_revoked')]),
    ).toEqual([]);
  });
  it('an unrelated failure is not a credentials repair', () => {
    expect(kinds(integration(), [delivery('dead_lettered', 'destination_unavailable')])).toEqual([]);
  });
  it('an open breaker offers a test, but only while the integration is on', () => {
    const health = {
      state: 'open',
      paused: true,
      consecutiveFailures: 5,
      retryAt: null,
      pacedUntil: null,
      timesOpened: 1,
    } as const;
    expect(kinds(integration({ health }))).toEqual(['breaker_open']);
    expect(kinds(integration({ health, enabled: false }))).toEqual([]);
  });
  it('unreadable filters and noise settings are named', () => {
    expect(kinds(integration({ filtersInvalid: true, noiseInvalid: true }))).toEqual([
      'filters_unreadable',
      'noise_unreadable',
    ]);
  });
});

describe('summariseHealth', () => {
  it('finds the newest success and failure and says how many it looked at', () => {
    const rows = [
      delivery('retrying'),
      delivery('accepted'),
      delivery('dead_lettered', 'x'),
      delivery('sent'),
    ];
    const h = summariseHealth(rows);
    expect(h.lastDelivered?.state).toBe('accepted');
    expect(h.lastFailed?.state).toBe('dead_lettered');
    expect(h.considered).toBe(4);
    expect(summariseHealth([])).toEqual({ lastDelivered: null, lastFailed: null, considered: 0 });
  });
});
