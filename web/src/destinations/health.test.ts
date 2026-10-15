import { describe, expect, it } from 'vitest';
import { INTEGRATIONS } from '../a11y/testing/fixtures';
import type { Integration } from '../lib/api';
import { destinationRow } from './health';

const base: Integration = INTEGRATIONS[0];

describe('destinationRow (ADR 0056)', () => {
  it('passes the reported breaker state and figures through unchanged', () => {
    const row = destinationRow(base);
    expect(row).toMatchObject({
      sending: 'open',
      retryAt: '2026-10-14T09:05:00Z',
      pacedUntil: null,
      consecutiveFailures: 5,
      timesOpened: 1,
      credentials: 'ok',
    });
  });

  it('reports nothing, not zero, when the server sends no health record', () => {
    for (const health of [undefined, null]) {
      const row = destinationRow({ ...base, health });
      expect(row.sending).toBeNull();
      expect(row.consecutiveFailures).toBeNull();
      expect(row.timesOpened).toBeNull();
      expect(row.retryAt).toBeNull();
    }
  });

  it('keeps a closed breaker’s pacing hold but no retry time', () => {
    const row = destinationRow({
      ...base,
      health: {
        state: 'closed',
        paused: false,
        consecutiveFailures: 0,
        retryAt: '2026-10-14T09:05:00Z',
        pacedUntil: '2026-10-14T09:01:00Z',
        timesOpened: 0,
      },
    });
    expect(row).toMatchObject({ sending: 'closed', retryAt: null, pacedUntil: '2026-10-14T09:01:00Z' });
    expect(row.consecutiveFailures).toBe(0);
  });

  it('names a revoke as revoked, and other credential states as the server reports them', () => {
    expect(destinationRow({ ...base, credentials: 'quarantined', revoked: true }).credentials).toBe(
      'revoked',
    );
    expect(destinationRow({ ...base, credentials: 'quarantined' }).credentials).toBe('quarantined');
    expect(destinationRow({ ...base, credentials: 'legacy' }).credentials).toBe('legacy');
  });
});
