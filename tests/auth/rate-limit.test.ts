import { describe, expect, it, vi } from 'vitest';
import { AUTH_RATE_RULES } from '../../src/auth/rate-limit-rules';
import { createAuthHarness } from './harness';

/**
 * Spec 02 F22: every rule in `AUTH_RATE_RULES` is driven to its limit through the real handler. The
 * limiter runs before the endpoint, so a request body that would be refused anyway still counts, which
 * keeps these tests independent of each endpoint's own validation.
 */
const rules = Object.entries(AUTH_RATE_RULES);

describe('auth rate limits (F22)', () => {
  it.each(rules)('%s allows its maximum, then answers 429 with Retry-After', async (path, rule) => {
    const h = createAuthHarness();
    for (let i = 0; i < rule.max; i++) {
      const res = await h.call(path, { body: {}, ip: '198.51.100.7' });
      expect(res.status, `request ${i + 1} of ${rule.max}`).not.toBe(429);
    }
    const blocked = await h.call(path, { body: {}, ip: '198.51.100.7' });
    expect(blocked.status).toBe(429);
    const wait = Number(blocked.headers.get('x-retry-after') ?? blocked.headers.get('retry-after'));
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(rule.window);
  });

  it.each(rules)('%s is available again once its window has passed', async (path, rule) => {
    const h = createAuthHarness();
    for (let i = 0; i <= rule.max; i++) await h.call(path, { body: {}, ip: '198.51.100.8' });
    expect((await h.call(path, { body: {}, ip: '198.51.100.8' })).status).toBe(429);
    vi.setSystemTime(Date.now() + (rule.window + 1) * 1000);
    expect((await h.call(path, { body: {}, ip: '198.51.100.8' })).status).not.toBe(429);
  });

  it('counts per client address: one address being limited does not limit another', async () => {
    const h = createAuthHarness();
    const rule = AUTH_RATE_RULES['/sign-in/email'];
    for (let i = 0; i <= rule.max; i++) await h.call('/sign-in/email', { body: {}, ip: '198.51.100.9' });
    expect((await h.call('/sign-in/email', { body: {}, ip: '198.51.100.9' })).status).toBe(429);
    expect((await h.call('/sign-in/email', { body: {}, ip: '198.51.100.10' })).status).not.toBe(429);
  });

  it('takes the address from cf-connecting-ip only; a forged X-Forwarded-For does not reset the count', async () => {
    const h = createAuthHarness();
    const rule = AUTH_RATE_RULES['/sign-in/email'];
    const call = (forwarded: string) =>
      h.auth.handler(
        new Request('https://noti.test/api/auth/sign-in/email', {
          method: 'POST',
          headers: {
            origin: 'https://noti.test',
            'content-type': 'application/json',
            'cf-connecting-ip': '198.51.100.11',
            'x-forwarded-for': forwarded,
            'x-real-ip': forwarded,
          },
          body: '{}',
        }),
      );
    for (let i = 0; i < rule.max; i++) await call(`10.0.0.${i}`);
    expect((await call('10.9.9.9')).status).toBe(429);
  });

  it('a request with no client address is limited in one shared bucket, not let through unlimited', async () => {
    const h = createAuthHarness();
    const rule = AUTH_RATE_RULES['/sign-in/email'];
    const anonymous = () =>
      h.auth.handler(
        new Request('https://noti.test/api/auth/sign-in/email', {
          method: 'POST',
          headers: { origin: 'https://noti.test', 'content-type': 'application/json' },
          body: '{}',
        }),
      );
    for (let i = 0; i < rule.max; i++) await anonymous();
    expect((await anonymous()).status).toBe(429);
  });

  it('keeps the counters in the database, so the limit survives a new Worker instance', async () => {
    const h = createAuthHarness();
    await h.call('/sign-in/email', { body: {}, ip: '198.51.100.12' });
    const rows = h.db.raw.prepare('SELECT key, count FROM rate_limit').all() as {
      key: string;
      count: number;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toContain('/sign-in/email');
    expect(rows[0]?.count).toBe(1);
  });

  it('a path with no custom rule falls under the general limit (60 per minute)', async () => {
    const h = createAuthHarness();
    for (let i = 0; i < 60; i++) await h.call('/get-session', { ip: '198.51.100.13' });
    expect((await h.call('/get-session', { ip: '198.51.100.13' })).status).toBe(429);
  });

  it('the resend limit is per address, not per mailbox: three resends to anyone from one address, then 429', async () => {
    // Documented so nobody reads the limit as protecting a victim's inbox: an attacker rotating
    // addresses can still send each verification link to a victim. The per-mailbox control is the
    // short link lifetime and Cloudflare Email Sending's own reputation limits (spec 02 F17).
    const h = createAuthHarness();
    const send = (email: string, ip: string) => h.call('/send-verification-email', { body: { email }, ip });
    for (let i = 0; i < 3; i++) await send('victim@example.test', '198.51.100.14');
    expect((await send('victim@example.test', '198.51.100.14')).status).toBe(429);
    expect((await send('victim@example.test', '198.51.100.15')).status).not.toBe(429);
  });
});
