import { describe, expect, it } from 'vitest';
import { createAuthHarness, NEW_PASSWORD, PASSWORD, SHORT_PASSWORD, WRONG_PASSWORD } from './harness';

/**
 * Spec 02 F16 (identity), F17 (email verification), F18 (password reset): what the deployed Better Auth
 * configuration actually does, through the real handler and the real schema. Nothing is mocked but the
 * email transport, which is a recorder.
 */

const users = (h: ReturnType<typeof createAuthHarness>) =>
  (h.db.raw.prepare('SELECT email FROM "user" ORDER BY email').all() as { email: string }[]).map(
    (r) => r.email,
  );
const sessionCount = (h: ReturnType<typeof createAuthHarness>) =>
  Number((h.db.raw.prepare('SELECT COUNT(*) AS n FROM "session"').get() as { n: number }).n);

describe('password policy (F16)', () => {
  it('refuses a password shorter than 12 characters and creates no account', async () => {
    const h = createAuthHarness();
    const res = await h.call('/sign-up/email', {
      body: { email: 'short@example.test', password: 'e'.repeat(11), name: 'S' },
    });
    expect(res.status).toBe(400);
    expect(users(h)).toEqual([]);
  });

  it('accepts exactly 12 and exactly 128 characters, refuses 129', async () => {
    const h = createAuthHarness();
    const at = (n: number, ip: string, who: string) =>
      h.call('/sign-up/email', {
        body: { email: `${who}@example.test`, password: 'p'.repeat(n), name: 'P' },
        ip,
      });
    expect((await at(12, '203.0.113.1', 'min')).status).toBe(200);
    expect((await at(128, '203.0.113.2', 'max')).status).toBe(200);
    expect((await at(129, '203.0.113.3', 'over')).status).toBe(400);
    expect(users(h)).toEqual(['max@example.test', 'min@example.test']);
  });

  it('does not store the password, only a salted hash', async () => {
    const h = createAuthHarness();
    await h.register('hash@example.test');
    const row = h.db.raw.prepare(`SELECT password FROM "account" WHERE provider_id='credential'`).get() as {
      password: string;
    };
    expect(row.password).not.toContain(PASSWORD);
    expect(row.password.length).toBeGreaterThan(40);
  });
});

describe('email verification gate (F16, F17)', () => {
  it('sign-up grants no session and sends exactly one verification link', async () => {
    const h = createAuthHarness();
    const res = await h.call('/sign-up/email', {
      body: { email: 'new@example.test', password: PASSWORD, name: 'N' },
    });
    expect(res.status).toBe(200);
    expect(h.cookieOf(res)).toBe('');
    expect(sessionCount(h)).toBe(0);
    expect(h.mail.map((m) => m.to)).toEqual(['new@example.test']);
    expect(h.mail[0]?.subject).toBe('Verify your Lumi Noti email');
  });

  it('refuses sign-in before verification (403, no session) and re-sends the link', async () => {
    const h = createAuthHarness();
    await h.call('/sign-up/email', { body: { email: 'u@example.test', password: PASSWORD, name: 'U' } });
    const { res, cookie } = await h.signIn('u@example.test');
    expect(res.status).toBe(403);
    expect(cookie).toBe('');
    expect(sessionCount(h)).toBe(0);
    expect(h.mail).toHaveLength(2);
  });

  it('a verification link works once, and does not sign the person in', async () => {
    const h = createAuthHarness();
    await h.call('/sign-up/email', { body: { email: 'v@example.test', password: PASSWORD, name: 'V' } });
    const link = h.lastLink('v@example.test');
    const path = link.pathname.replace('/api/auth', '') + link.search;
    const ok = await h.call(path);
    expect(ok.status).toBeLessThan(400);
    expect(h.cookieOf(ok)).toBe('');
    expect(sessionCount(h)).toBe(0);
    const verified = h.db.raw.prepare(`SELECT email_verified AS v FROM "user"`).get() as { v: number };
    expect(verified.v).toBe(1);
  });

  it('a tampered verification token is refused and leaves the account unverified', async () => {
    const h = createAuthHarness();
    await h.call('/sign-up/email', { body: { email: 't@example.test', password: PASSWORD, name: 'T' } });
    const link = h.lastLink('t@example.test');
    const token = link.searchParams.get('token') ?? '';
    const res = await h.call(`/verify-email?token=${token.slice(0, -3)}abc`);
    expect(res.status).toBeGreaterThanOrEqual(300);
    const verified = h.db.raw.prepare(`SELECT email_verified AS v FROM "user"`).get() as { v: number };
    expect(verified.v).toBe(0);
  });

  it('a verification link expires after one hour', async () => {
    const h = createAuthHarness();
    await h.call('/sign-up/email', { body: { email: 'e@example.test', password: PASSWORD, name: 'E' } });
    const link = h.lastLink('e@example.test');
    const exp = JSON.parse(
      Buffer.from(link.searchParams.get('token')?.split('.')[1] ?? '', 'base64url').toString(),
    ) as { exp: number; iat: number };
    expect(exp.exp - exp.iat).toBe(3600);
  });
});

describe('email canonicalisation (F16)', () => {
  it('stores the address lower-cased and trimmed of case differences', async () => {
    const h = createAuthHarness();
    await h.call('/sign-up/email', {
      body: { email: 'Mixed.Case@Example.TEST', password: PASSWORD, name: 'M' },
    });
    expect(users(h)).toEqual(['mixed.case@example.test']);
  });

  it('a second sign-up differing only in case creates no second account and says the same thing', async () => {
    const h = createAuthHarness();
    const first = await h.call('/sign-up/email', {
      body: { email: 'dup@example.test', password: PASSWORD, name: 'D' },
      ip: '203.0.113.1',
    });
    const second = await h.call('/sign-up/email', {
      body: { email: 'DUP@example.test', password: PASSWORD, name: 'D' },
      ip: '203.0.113.2',
    });
    expect(users(h)).toEqual(['dup@example.test']);
    expect(second.status).toBe(first.status);
  });

  it('signs in with any casing of the verified address', async () => {
    const h = createAuthHarness();
    await h.register('case@example.test');
    const { res } = await h.signIn('CASE@Example.test', { ip: '203.0.113.9' });
    expect(res.status).toBe(200);
  });

  it('a sign-in with the wrong password and one for an unknown address are indistinguishable', async () => {
    const h = createAuthHarness();
    await h.register('known@example.test');
    const wrong = await h.signIn('known@example.test', {
      password: WRONG_PASSWORD,
      ip: '203.0.113.5',
    });
    const unknown = await h.signIn('nobody@example.test', { ip: '203.0.113.6' });
    expect(wrong.res.status).toBe(unknown.res.status);
    expect(await wrong.res.text()).toBe(await unknown.res.text());
  });
});

describe('password reset (F18)', () => {
  it('answers identically for a known and an unknown address, and mails only the known one', async () => {
    const h = createAuthHarness();
    await h.register('real@example.test');
    h.mail.length = 0;
    const known = await h.call('/request-password-reset', {
      body: { email: 'real@example.test', redirectTo: '/reset' },
      ip: '203.0.113.11',
    });
    const unknown = await h.call('/request-password-reset', {
      body: { email: 'ghost@example.test', redirectTo: '/reset' },
      ip: '203.0.113.12',
    });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(known.status);
    expect(await unknown.text()).toBe(await known.text());
    expect(h.mail.map((m) => m.to)).toEqual(['real@example.test']);
  });

  async function resetFor(h: ReturnType<typeof createAuthHarness>, email: string, ip: string) {
    await h.call('/request-password-reset', { body: { email, redirectTo: '/reset' }, ip });
    const mail = [...h.mail].reverse().find((m) => m.to === email);
    const url = new URL(/https?:\/\/\S+/.exec(mail?.text ?? '')?.[0] ?? '');
    // The emailed link is /api/auth/reset-password/<token>?callbackURL=...; the token is the last path segment.
    return url.pathname.split('/').pop() ?? '';
  }

  it('revokes every existing session when the password is reset', async () => {
    const h = createAuthHarness();
    const laptop = await h.register('reset@example.test', { ip: '203.0.113.20' });
    const phone = (await h.signIn('reset@example.test', { ip: '203.0.113.21' })).cookie;
    expect(sessionCount(h)).toBe(2);

    const token = await resetFor(h, 'reset@example.test', '203.0.113.22');
    const done = await h.call('/reset-password', {
      body: { newPassword: NEW_PASSWORD, token },
      ip: '203.0.113.22',
    });
    expect(done.status).toBe(200);

    expect(sessionCount(h)).toBe(0);
    for (const cookie of [laptop, phone])
      expect(await (await h.call('/get-session', { cookie })).text()).toBe('null');
    // The new password works and the old one does not.
    expect(
      (await h.signIn('reset@example.test', { password: NEW_PASSWORD, ip: '203.0.113.23' })).res.status,
    ).toBe(200);
    expect((await h.signIn('reset@example.test', { ip: '203.0.113.24' })).res.status).toBe(401);
  });

  it('a reset link is single use', async () => {
    const h = createAuthHarness();
    await h.register('once@example.test');
    const token = await resetFor(h, 'once@example.test', '203.0.113.30');
    const body = { newPassword: NEW_PASSWORD, token };
    expect((await h.call('/reset-password', { body, ip: '203.0.113.30' })).status).toBe(200);
    const again = await h.call('/reset-password', {
      body: { newPassword: NEW_PASSWORD + '2', token },
      ip: '203.0.113.30',
    });
    expect(again.status).toBe(400);
  });

  it('a reset link stops working after one hour', async () => {
    const h = createAuthHarness();
    await h.register('late@example.test');
    const token = await resetFor(h, 'late@example.test', '203.0.113.31');
    const { vi } = await import('vitest');
    vi.setSystemTime(Date.now() + 3600_000 + 1000);
    const res = await h.call('/reset-password', {
      body: { newPassword: NEW_PASSWORD, token },
      ip: '203.0.113.31',
    });
    expect(res.status).toBe(400);
  });

  it('applies the password policy to the new password', async () => {
    const h = createAuthHarness();
    await h.register('weak@example.test');
    const token = await resetFor(h, 'weak@example.test', '203.0.113.32');
    const res = await h.call('/reset-password', {
      body: { newPassword: SHORT_PASSWORD, token },
      ip: '203.0.113.32',
    });
    expect(res.status).toBe(400);
  });
});
