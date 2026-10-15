import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NEW_PASSWORD, PASSWORD, WRONG_PASSWORD, createAuthHarness, type AuthHarness } from '../auth/harness';
import { captureConsole, Planted } from '../support/log-capture';

/**
 * F234 (spec 15, AR-1): no session token, password, verification or reset token, auth secret or hash
 * prefix of any of them reaches the console. Every auth and session path is driven through the real
 * Worker and real Better Auth: sign-up, sign-in (right and wrong password), list, revoke one,
 * revoke-others, a password reset that ends every session, the restore script, and a request that
 * presents a made-up cookie. Everything the console receives is captured, and the captured text must
 * not contain any planted value. A control line proves the capture works, so a silent console cannot pass.
 *
 * Coverage note: a successful request writes no line of its own, so the lines captured here are Better
 * Auth's (for example its "Invalid password" line) and the control. Our own `log()` lines on the
 * webhook path are covered by tests/security/webhook-logs.test.ts.
 */

/** The value `createAuthHarness` configures as `BETTER_AUTH_SECRET`; repeated here so it can be planted. */
const AUTH_SECRET = 'auth-harness-secret-Zq7Kd2mV9xR4tLw8';
const EMAIL = 'logs@example.test';
const CONTROL = 'control-line-for-capture-check';

// The restore script is plain ESM (as in tests/security/revoke-all-sessions.test.ts).
interface RevokeAllScript {
  planRevokeAll: (
    executor: { query(sql: string): Promise<Record<string, unknown>[]>; run(s: string[]): Promise<void> },
    options: { reason: string },
  ) => Promise<{ sessions: number; verifications: number; statements: string[] }>;
}
const revokeAllPath = '../../scripts/revoke-all-sessions.mjs';
const revokeAllScript = (await import(/* @vite-ignore */ revokeAllPath)) as RevokeAllScript;

let capture: ReturnType<typeof captureConsole>;

beforeEach(() => {
  capture = captureConsole();
});

afterEach(() => {
  capture.restore();
});

/** Every token the database holds, every verification value, and every token in a mail link. */
function collect(h: AuthHarness, planted: Planted): void {
  for (const row of h.db.raw.prepare('SELECT token FROM "session"').all() as { token: string }[])
    planted.add(`session token ${row.token.slice(0, 4)}`, row.token);
  for (const row of h.db.raw.prepare('SELECT value FROM "verification"').all() as { value: string }[])
    planted.add('verification value', row.value);
  for (const mail of h.mail) {
    for (const match of mail.text.matchAll(/https?:\/\/\S+/g)) {
      const url = new URL(match[0]);
      const token = url.searchParams.get('token') ?? url.pathname.split('/').pop() ?? '';
      planted.add('emailed link token', decodeURIComponent(token));
    }
  }
}

describe('no token, password or secret reaches the console (F234, AR-1)', () => {
  it('sign-in, session list and revoke, revoke-others, password reset and the restore script', async () => {
    const h = createAuthHarness();
    const planted = new Planted();
    planted.add('auth secret', AUTH_SECRET);
    planted.add('password', PASSWORD);
    planted.add('wrong password', WRONG_PASSWORD);
    planted.add('new password', NEW_PASSWORD);

    // Control: the capture sees a line written to the console.
    console.info(CONTROL);
    expect(capture.lines.join('\n')).toContain(CONTROL);

    // Sign-up, verification by emailed link, and the first sign-in.
    const laptop = await h.register(EMAIL, { ip: '203.0.113.20', userAgent: 'Mozilla/5.0 (Macintosh)' });
    planted.add('laptop cookie', laptop);
    collect(h, planted);

    // A wrong password is refused.
    const wrong = await h.signIn(EMAIL, { password: WRONG_PASSWORD, ip: '203.0.113.21' });
    expect(wrong.res.status).toBe(401);

    // Two more devices, so there is something to revoke.
    const phone = await h.signIn(EMAIL, { ip: '198.51.100.21', userAgent: 'Mozilla/5.0 (iPhone) Safari' });
    const tablet = await h.signIn(EMAIL, { ip: '198.51.100.22', userAgent: 'Mozilla/5.0 (iPad) Safari' });
    expect(phone.res.status).toBe(200);
    expect(tablet.res.status).toBe(200);
    planted.add('phone cookie', phone.cookie);
    planted.add('tablet cookie', tablet.cookie);
    collect(h, planted);

    // The session API: list, end one, end the others.
    const listed = await h.api('/api/workspace/me/sessions', { cookie: laptop });
    expect(listed.status).toBe(200);
    const other = (await listed.json<{ sessions: { id: string; current: boolean }[] }>()).sessions.find(
      (s) => !s.current,
    );
    expect(other).toBeDefined();
    const one = await h.api(`/api/workspace/me/sessions/${other?.id}/revoke`, {
      method: 'POST',
      cookie: laptop,
    });
    expect(one.status).toBe(200);
    const others = await h.api('/api/workspace/me/sessions/revoke-others', {
      method: 'POST',
      cookie: laptop,
    });
    expect(others.status).toBe(200);

    // A made-up cookie, and a raw token presented without its signature: both refused, neither logged.
    const forged = `better-auth.session_token=${sha('made-up')}.${sha('sig')}`;
    planted.add('forged cookie', forged);
    expect((await h.api('/api/workspace/me/sessions', { cookie: forged })).status).toBe(401);
    const rawToken = (h.db.raw.prepare('SELECT token FROM "session" LIMIT 1').get() as { token: string })
      .token;
    expect(
      (await h.api('/api/workspace/me/sessions', { cookie: `better-auth.session_token=${rawToken}` })).status,
    ).toBe(401);

    // A password reset ends every session (the reset path writes its own audit row).
    await h.call('/request-password-reset', {
      body: { email: EMAIL, redirectTo: '/reset' },
      ip: '203.0.113.30',
    });
    collect(h, planted);
    const resetLink =
      [...h.mail]
        .reverse()
        .find((m) => m.to === EMAIL)
        ?.text.match(/https?:\/\/\S+/)?.[0] ?? '';
    const resetToken = new URL(resetLink).pathname.split('/').pop() ?? '';
    planted.add('reset token', resetToken);
    const reset = await h.call('/reset-password', {
      body: { newPassword: NEW_PASSWORD, token: resetToken },
      ip: '203.0.113.30',
    });
    expect(reset.status).toBe(200);
    collect(h, planted);

    // The restore script ends whatever is left, and records that it did.
    const executor = {
      query: (sql: string) => Promise.resolve(h.db.raw.prepare(sql).all() as Record<string, unknown>[]),
      run: (statements: string[]) => {
        for (const s of statements) h.db.raw.exec(s);
        return Promise.resolve();
      },
    };
    const plan = await revokeAllScript.planRevokeAll(executor, { reason: 'restore' });
    await executor.run(plan.statements);
    collect(h, planted);

    // Signing in with the new password works, and its cookie is planted too.
    const again = await h.signIn(EMAIL, { password: NEW_PASSWORD, ip: '203.0.113.31' });
    expect(again.res.status).toBe(200);
    planted.add('cookie after reset', again.cookie);
    collect(h, planted);

    const text = capture.lines.join('\n');
    expect(text).toContain(CONTROL);
    expect(planted.leaked(text)).toEqual([]);
    // The matcher itself: a planted value, and its hash prefix, are found when they are present.
    expect(planted.leaked(`line with ${AUTH_SECRET} in it`)).toContain('auth secret');
    expect(planted.leaked(`hash ${sha(AUTH_SECRET).slice(0, 12)}`)).toContain(
      'auth secret (sha256 hex prefix)',
    );
  });
});

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
