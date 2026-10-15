import { describe, expect, it } from 'vitest';
import {
  MAX_ALLOWLIST_ENTRIES,
  allowlistOf,
  isUnknownSignupMode,
  signupMode,
  signupRefusal,
} from '../../src/auth/signup-policy';
import { PASSWORD, createAuthHarness } from './harness';

/**
 * Who may create an account (ADR 0047): the invite-only beta and the sign-up kill switch. The rules are
 * tested as pure functions, then through the REAL Better Auth handler, because the check lives in a
 * database hook that only the real configuration runs. Better Auth answers a refused sign-up with the same
 * 200 as a successful one (anti-enumeration), so the guarantees asserted are "no account, no mail".
 */
describe('signupMode', () => {
  it('is open when unset or empty, so local development and tests are unchanged', () => {
    expect(signupMode(undefined)).toBe('open');
    expect(signupMode('')).toBe('open');
    expect(signupMode('  ')).toBe('open');
  });

  it('reads the three modes, ignoring surrounding space', () => {
    expect(signupMode('open')).toBe('open');
    expect(signupMode(' invite_only ')).toBe('invite_only');
    expect(signupMode('closed')).toBe('closed');
  });

  it('fails closed on anything else, and says so', () => {
    for (const raw of ['OPEN', 'invite', 'true', 'off'] as const) {
      expect(signupMode(raw), raw).toBe('closed');
      expect(isUnknownSignupMode(raw), raw).toBe(true);
    }
    expect(isUnknownSignupMode(undefined)).toBe(false);
    expect(isUnknownSignupMode('invite_only')).toBe(false);
  });
});

describe('allowlistOf', () => {
  it('takes exact addresses, case-insensitively, separated by commas or space', () => {
    expect([...allowlistOf('Ops@Example.test, second@example.test\nthird@example.test')]).toEqual([
      'ops@example.test',
      'second@example.test',
      'third@example.test',
    ]);
  });

  it('drops anything that is not an address: no domains, no wildcards', () => {
    expect([...allowlistOf('@example.test, *@example.test, example.test, , ok@example.test')]).toEqual([
      'ok@example.test',
    ]);
    expect(allowlistOf(undefined).size).toBe(0);
  });

  it('reads at most the bound', () => {
    const many = Array.from({ length: MAX_ALLOWLIST_ENTRIES + 10 }, (_, i) => `u${i}@example.test`);
    expect(allowlistOf(many.join(',')).size).toBe(MAX_ALLOWLIST_ENTRIES);
  });
});

describe('signupRefusal', () => {
  const never = () => Promise.reject(new Error('the invitation lookup must not run'));

  it('open admits anyone without looking anything up', async () => {
    expect(
      await signupRefusal({
        mode: 'open',
        email: 'a@b.test',
        allowlist: new Set(),
        hasPendingInvitation: never,
      }),
    ).toBeNull();
  });

  it('closed refuses everyone, allowlisted or invited', async () => {
    expect(
      await signupRefusal({
        mode: 'closed',
        email: 'a@b.test',
        allowlist: new Set(['a@b.test']),
        hasPendingInvitation: never,
      }),
    ).toBe('signup_closed');
  });

  it('invite_only admits an allowlisted address without a lookup, case-insensitively', async () => {
    expect(
      await signupRefusal({
        mode: 'invite_only',
        email: 'Ops@Example.test',
        allowlist: allowlistOf('ops@example.test'),
        hasPendingInvitation: never,
      }),
    ).toBeNull();
  });

  it('invite_only asks about a pending invitation with the normalised address', async () => {
    const asked: string[] = [];
    const has = (email: string) => {
      asked.push(email);
      return Promise.resolve(email === 'invited@example.test');
    };
    const base = { mode: 'invite_only' as const, allowlist: new Set<string>(), hasPendingInvitation: has };
    expect(await signupRefusal({ ...base, email: ' Invited@Example.test ' })).toBeNull();
    expect(await signupRefusal({ ...base, email: 'stranger@example.test' })).toBe('signup_invite_only');
    expect(asked).toEqual(['invited@example.test', 'stranger@example.test']);
  });
});

describe('through the real auth handler', () => {
  const signUp = (h: ReturnType<typeof createAuthHarness>, email: string) =>
    h.call('/sign-up/email', { body: { email, password: PASSWORD, name: 'Test' }, ip: '203.0.113.9' });
  const users = (h: ReturnType<typeof createAuthHarness>): number =>
    Number((h.db.raw.prepare('SELECT COUNT(*) AS n FROM "user"').get() as { n: number }).n);

  it('closed creates no account and sends no mail, and answers like a success (no enumeration)', async () => {
    const h = createAuthHarness({ SIGNUP_MODE: 'closed' });
    const res = await signUp(h, 'someone@example.test');
    expect(res.status).toBe(200);
    expect(users(h)).toBe(0);
    expect(h.mail).toHaveLength(0);
  });

  it('an unknown mode behaves as closed', async () => {
    const h = createAuthHarness({ SIGNUP_MODE: 'opne' });
    await signUp(h, 'someone@example.test');
    expect(users(h)).toBe(0);
    expect(h.mail).toHaveLength(0);
  });

  it('a refused address cannot sign in afterwards', async () => {
    const h = createAuthHarness({ SIGNUP_MODE: 'closed' });
    await signUp(h, 'someone@example.test');
    const { res } = await h.signIn('someone@example.test');
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('invite_only refuses a stranger and admits the allowlisted operator', async () => {
    // Mixed case in the allowlist: the match is case-insensitive (Better Auth lower-cases the address).
    const h = createAuthHarness({ SIGNUP_MODE: 'invite_only', SIGNUP_ALLOWLIST: 'Ops@Example.test' });
    await signUp(h, 'stranger@example.test');
    expect(users(h)).toBe(0);
    expect(h.mail).toHaveLength(0);
    await h.register('ops@example.test');
    expect(users(h)).toBe(1);
  });

  it('invite_only admits an address with a pending invitation, and not once it has expired', async () => {
    const h = createAuthHarness({ SIGNUP_MODE: 'invite_only', SIGNUP_ALLOWLIST: 'ops@example.test' });
    const admin = await h.register('ops@example.test');
    const created = await h.call('/organization/create', {
      body: { name: 'acme', slug: 'acme' },
      cookie: admin,
      ip: '10.0.0.1',
    });
    expect(created.status).toBe(200);
    const organizationId = (await created.json<{ id: string }>()).id;
    for (const email of ['invited@example.test', 'late@example.test']) {
      const invited = await h.call('/organization/invite-member', {
        body: { email, role: 'member', organizationId },
        cookie: admin,
        ip: '10.0.1.1',
      });
      expect(invited.status).toBe(200);
    }
    h.db.raw
      .prepare('UPDATE invitation SET expires_at=? WHERE email=?')
      .run(Date.now() - 1000, 'late@example.test');

    await h.register('invited@example.test');
    const mailBefore = h.mail.filter((m) => m.to === 'late@example.test').length;
    await signUp(h, 'late@example.test');
    expect(users(h)).toBe(2);
    // The only mail the expired invitee ever got is the invitation itself, not a verification link.
    expect(h.mail.filter((m) => m.to === 'late@example.test')).toHaveLength(mailBefore);
  });

  it('open, the default when unset, admits anyone', async () => {
    const h = createAuthHarness();
    await h.register('anyone@example.test');
    expect(users(h)).toBe(1);
  });
});
