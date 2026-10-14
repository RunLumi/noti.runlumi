import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthHarness, type AuthHarness } from '../auth/harness';

/**
 * The signed-in person's own sessions (spec 02 F20, REMAINING 2.2; ADR 0030): list, end one, end all
 * the others. Real Better Auth over the real schema; only the email transport is a recorder.
 */
const LIST = '/api/workspace/me/sessions';
let h: AuthHarness;
let laptop: string;
let phone: string;
let tablet: string;

interface Listed {
  id: string;
  current: boolean;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
}
const listed = async (cookie: string): Promise<Listed[]> =>
  (await (await h.api(LIST, { cookie })).json<{ sessions: Listed[] }>()).sessions;

const rowCount = (sql: string, ...args: string[]): number =>
  Number((h.db.raw.prepare(sql).get(...args) as { n: number }).n);
const alive = async (cookie: string): Promise<boolean> => (await h.api(LIST, { cookie })).status === 200;
const auditRows = (action: string) =>
  h.db.raw
    .prepare(
      'SELECT actor_id, organization_id, subject_type, subject_id, outcome, ip, user_agent, metadata_json FROM audit_events WHERE action=?',
    )
    .all(action) as Array<Record<string, string | null>>;

beforeEach(async () => {
  h = createAuthHarness();
  laptop = await h.register('me@example.test', {
    ip: '203.0.113.20',
    userAgent: 'Mozilla/5.0 (Macintosh) Chrome/130',
  });
  phone = (
    await h.signIn('me@example.test', { ip: '198.51.100.21', userAgent: 'Mozilla/5.0 (iPhone) Safari' })
  ).cookie;
  tablet = (
    await h.signIn('me@example.test', { ip: '198.51.100.22', userAgent: 'Mozilla/5.0 (iPad) Safari' })
  ).cookie;
});

describe('GET /api/workspace/me/sessions', () => {
  it("lists this person's sessions, marks the one making the request, and names the device", async () => {
    const sessions = await listed(phone);
    expect(sessions).toHaveLength(3);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    expect(sessions.find((s) => s.current)?.userAgent).toContain('iPhone');
    expect(sessions.map((s) => s.userAgent).sort()).toEqual(
      [
        'Mozilla/5.0 (Macintosh) Chrome/130',
        'Mozilla/5.0 (iPad) Safari',
        'Mozilla/5.0 (iPhone) Safari',
      ].sort(),
    );
  });

  it('never returns a session token, a cookie value or anything that could stand in for one', async () => {
    const res = await h.api(LIST, { cookie: laptop });
    const text = await res.text();
    const tokens = (h.db.raw.prepare('SELECT token FROM "session"').all() as { token: string }[]).map(
      (r) => r.token,
    );
    expect(tokens).toHaveLength(3);
    for (const token of tokens) expect(text).not.toContain(token);
    for (const key of ['"token"', 'cookie', 'secret']) expect(text.toLowerCase()).not.toContain(key);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('shows a coarse address (the last part hidden), enough to spot a stranger', async () => {
    const ips = (await listed(laptop)).map((s) => s.ip).sort();
    expect(ips).toEqual(['198.51.100.x', '198.51.100.x', '203.0.113.x']);
  });

  it("does not list expired sessions or anyone else's", async () => {
    await h.register('other@example.test', { ip: '203.0.113.30' });
    h.db.raw
      .prepare(
        `UPDATE "session" SET expires_at=1 WHERE id=(SELECT id FROM "session" WHERE user_agent LIKE '%iPad%')`,
      )
      .run();
    const sessions = await listed(laptop);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => !(s.userAgent ?? '').includes('iPad'))).toBe(true);
  });

  it('refuses a caller who is not signed in', async () => {
    expect((await h.api(LIST)).status).toBe(401);
  });
});

describe('POST /api/workspace/me/sessions/:id/revoke', () => {
  it('ends that session at once and leaves the others, and records who did it', async () => {
    const target = (await listed(laptop)).find((s) => (s.userAgent ?? '').includes('iPhone'));
    const res = await h.api(`${LIST}/${target?.id}/revoke`, {
      method: 'POST',
      cookie: laptop,
      ip: '203.0.113.20',
    });
    expect(res.status).toBe(200);
    expect(await alive(phone)).toBe(false);
    expect(await alive(laptop)).toBe(true);
    expect(await alive(tablet)).toBe(true);

    const rows = auditRows('session.revoke');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'success',
      subject_type: 'session',
      subject_id: target?.id,
      organization_id: null,
      ip: '203.0.113.20',
    });
    expect(rows[0]?.actor_id).toBe((h.db.raw.prepare('SELECT id FROM "user"').get() as { id: string }).id);
    expect(JSON.stringify(rows)).not.toMatch(/token/i);
  });

  it("cannot end someone else's session: 404, the session survives, nothing is recorded as done", async () => {
    const victim = await h.register('victim@example.test', { ip: '203.0.113.31' });
    const victimSession = (await listed(victim))[0];
    const res = await h.api(`${LIST}/${victimSession?.id}/revoke`, { method: 'POST', cookie: laptop });
    expect(res.status).toBe(404);
    expect(await alive(victim)).toBe(true);
    expect(auditRows('session.revoke')).toHaveLength(0);
  });

  it('answers 404 for an id that does not exist or is not well formed', async () => {
    for (const id of ['nope', 'x'.repeat(200), '%27%20OR%201%3D1']) {
      const res = await h.api(`${LIST}/${id}/revoke`, { method: 'POST', cookie: laptop });
      expect(res.status, id).toBe(404);
    }
    expect(rowCount('SELECT COUNT(*) AS n FROM "session"')).toBe(3);
  });

  it('refuses to end the session making the request (that is signing out)', async () => {
    const mine = (await listed(laptop)).find((s) => s.current);
    const res = await h.api(`${LIST}/${mine?.id}/revoke`, { method: 'POST', cookie: laptop });
    expect(res.status).toBe(409);
    expect(await alive(laptop)).toBe(true);
  });

  it('is limited to 30 a minute per person', async () => {
    let last = 0;
    for (let i = 0; i < 31; i++)
      last = (await h.api(`${LIST}/nothing-${i}/revoke`, { method: 'POST', cookie: laptop })).status;
    expect(last).toBe(429);
  });

  it('needs a same-origin request: no Origin and a foreign Origin are both refused', async () => {
    const target = (await listed(laptop)).find((s) => !s.current);
    for (const origin of [null, 'https://evil.test']) {
      const res = await h.api(`${LIST}/${target?.id}/revoke`, { method: 'POST', cookie: laptop, origin });
      expect(res.status).toBe(403);
    }
    expect(rowCount('SELECT COUNT(*) AS n FROM "session"')).toBe(3);
  });

  it('a signed-out caller is refused', async () => {
    const target = (await listed(laptop))[0];
    expect((await h.api(`${LIST}/${target?.id}/revoke`, { method: 'POST' })).status).toBe(401);
  });
});

describe('POST /api/workspace/me/sessions/revoke-others', () => {
  it('ends every other session, keeps this one, and records how many', async () => {
    const res = await h.api(`${LIST}/revoke-others`, { method: 'POST', cookie: tablet });
    expect(res.status).toBe(200);
    expect((await res.json<{ revoked: number }>()).revoked).toBe(2);
    expect(await alive(laptop)).toBe(false);
    expect(await alive(phone)).toBe(false);
    expect(await alive(tablet)).toBe(true);

    const rows = auditRows('session.revoke_others');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.metadata_json ?? '{}')).toEqual({ revoked: 2 });
  });

  it("does not touch another person's sessions", async () => {
    const other = await h.register('other@example.test', { ip: '203.0.113.32' });
    await h.api(`${LIST}/revoke-others`, { method: 'POST', cookie: laptop });
    expect(await alive(other)).toBe(true);
  });

  it('with nothing else to end it changes nothing and records nothing', async () => {
    await h.api(`${LIST}/revoke-others`, { method: 'POST', cookie: laptop });
    const again = await h.api(`${LIST}/revoke-others`, { method: 'POST', cookie: laptop });
    expect(again.status).toBe(200);
    expect((await again.json<{ revoked: number }>()).revoked).toBe(0);
    expect(auditRows('session.revoke_others')).toHaveLength(1);
  });

  it('is refused without the same Origin', async () => {
    expect(
      (await h.api(`${LIST}/revoke-others`, { method: 'POST', cookie: laptop, origin: null })).status,
    ).toBe(403);
    expect(await alive(phone)).toBe(true);
  });
});

describe("Better Auth's own session-management routes are closed (one audited path only)", () => {
  it.each([
    '/api/auth/list-sessions',
    '/api/auth/revoke-session',
    '/api/auth/revoke-sessions',
    '/api/auth/revoke-other-sessions',
  ])('%s answers 404 through the Worker', async (path) => {
    for (const method of ['GET', 'POST']) {
      const res = await h.api(path, {
        method,
        cookie: laptop,
        ...(method === 'POST' ? { body: { token: 'x' } } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(rowCount('SELECT COUNT(*) AS n FROM "session"')).toBe(3);
  });
});

describe('the closed routes cannot be reached by spelling them differently', () => {
  it.each([
    '/api/auth/list-sessions/',
    '/api/auth//list-sessions',
    '/api/auth/List-Sessions',
    '/api/auth/%6Cist-sessions',
    '/api/auth/./list-sessions',
    '/api/auth/x/../list-sessions',
    '/api/auth/list-sessions?x=1',
  ])('%s never returns a session', async (path) => {
    const res = await h.api(path, { cookie: laptop });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('token');
  });
});

describe('where the session token lives (AR-1, spec 15 F234, verified against the installed Better Auth)', () => {
  it('is stored as is: the cookie value is that token followed by a signature', () => {
    const stored = (h.db.raw.prepare('SELECT token FROM "session"').all() as { token: string }[]).map(
      (r) => r.token,
    );
    const [cookieName, cookieValue] = laptop.split('=');
    expect(cookieName).toMatch(/session_token$/);
    const token = decodeURIComponent(cookieValue ?? '').split('.')[0] ?? '';
    // If this stops being true, Better Auth now hashes tokens: update AR-1 and F234 before celebrating.
    expect(stored).toContain(token);
  });

  it("a stored token alone is not a credential here: without the server secret's signature it signs no one in", async () => {
    const token = (h.db.raw.prepare('SELECT token FROM "session" LIMIT 1').get() as { token: string }).token;
    const name = laptop.split('=')[0] ?? '';
    for (const forged of [`${name}=${token}`, `${name}=${token}.AAAA`, `${name}=${token}.${'A'.repeat(44)}`])
      expect((await h.api(LIST, { cookie: forged })).status, forged).toBe(401);
  });
});

describe('the absolute session lifetime (ADR 0030)', () => {
  it('a session in daily use still ends 90 days after sign-in', async () => {
    const day = 86_400_000;
    for (let elapsed = 20; elapsed <= 80; elapsed += 20) {
      vi.setSystemTime(Date.now() + 20 * day);
      expect((await h.api(LIST, { cookie: laptop })).status, `day ${elapsed}`).toBe(200);
    }
    vi.setSystemTime(Date.now() + 9 * day); // day 89
    expect((await h.api(LIST, { cookie: laptop })).status).toBe(200);
    vi.setSystemTime(Date.now() + 2 * day); // day 91
    expect((await h.api(LIST, { cookie: laptop })).status).toBe(401);
  });
});
