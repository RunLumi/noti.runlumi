import { describe, expect, it } from 'vitest';
import {
  INGRESS_LIMIT_PER_MINUTE,
  hit,
  ingressLimiter,
  pruneRateLimits,
} from '../../src/security/rate-limit';
import { createFakeD1 } from '../support/d1';

const T0 = Date.UTC(2026, 9, 13, 12, 0, 10);

describe('hit', () => {
  it('counts within a window and flags the hit that exceeds the limit', async () => {
    const { d1 } = createFakeD1();
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await hit(d1, 'k', 3, 60_000, T0));
    expect(results.map((r) => r.count)).toEqual([1, 2, 3, 4]);
    expect(results.map((r) => r.limited)).toEqual([false, false, false, true]);
  });

  it('reports a Retry-After to the end of the window, at least one second', async () => {
    const { d1 } = createFakeD1();
    expect((await hit(d1, 'k', 0, 60_000, T0)).retryAfterSeconds).toBe(50);
    const edge = Date.UTC(2026, 9, 13, 12, 0, 59, 999);
    expect((await hit(d1, 'k2', 0, 60_000, edge)).retryAfterSeconds).toBe(1);
  });

  it('resets in the next window and isolates keys', async () => {
    const { d1 } = createFakeD1();
    await hit(d1, 'a', 1, 60_000, T0);
    expect((await hit(d1, 'a', 1, 60_000, T0)).limited).toBe(true);
    expect((await hit(d1, 'b', 1, 60_000, T0)).limited).toBe(false);
    expect((await hit(d1, 'a', 1, 60_000, T0 + 60_000)).limited).toBe(false);
  });
});

describe('ingressLimiter (F29)', () => {
  it('is rate limited per installation id', async () => {
    const { d1 } = createFakeD1();
    const env = { DB: d1 };
    for (let i = 0; i < INGRESS_LIMIT_PER_MINUTE; i++) {
      expect((await ingressLimiter(env, 111, T0)).limited).toBe(false);
    }
    const over = await ingressLimiter(env, 111, T0);
    expect(over).toEqual({ limited: true, retryAfterSeconds: 50 });
    // A different installation has its own budget.
    expect((await ingressLimiter(env, 222, T0)).limited).toBe(false);
  });

  it('uses a key namespace separate from the integrations API limiter', async () => {
    const { d1, raw } = createFakeD1();
    await ingressLimiter({ DB: d1 }, 5, T0);
    const keys = raw.prepare('SELECT key FROM api_rate_limits').all() as { key: string }[];
    expect(keys.map((k) => k.key)).toEqual(['ingress:github:5']);
  });

  it('does not count invalid installation ids', async () => {
    const { d1, raw } = createFakeD1();
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(await ingressLimiter({ DB: d1 }, bad, T0)).toEqual({ limited: false });
    }
    expect(raw.prepare('SELECT count(*) AS n FROM api_rate_limits').get()).toEqual({ n: 0 });
  });
});

describe('pruneRateLimits', () => {
  it('deletes only expired windows and respects the batch bound', async () => {
    const { d1, raw } = createFakeD1();
    await hit(d1, 'old1', 9, 60_000, T0 - 3_600_000);
    await hit(d1, 'old2', 9, 60_000, T0 - 3_600_000);
    await hit(d1, 'fresh', 9, 60_000, T0);
    expect(await pruneRateLimits(d1, T0 - 60_000, 1)).toBe(1);
    expect(await pruneRateLimits(d1, T0 - 60_000)).toBe(1);
    const left = raw.prepare('SELECT key FROM api_rate_limits').all() as { key: string }[];
    expect(left.map((r) => r.key)).toEqual(['fresh']);
  });
});
