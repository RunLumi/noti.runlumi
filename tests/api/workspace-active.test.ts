import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOT_ENV } from '../support/boot-env';
import type { Bindings } from '../../src/env';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

/** POST /api/workspace/active: membership comes from the database, never from the body. */
const state: { raw: FakeD1['raw'] | null } = vi.hoisted(() => ({ raw: null }));

vi.mock('../../src/auth/better-auth', () => ({
  createAuth: () => ({
    api: {
      getSession: ({ headers }: { headers: Headers }) => {
        const id = headers.get('x-test-user');
        if (!id) return Promise.resolve(null);
        // The mock reads the real session row, as Better Auth does, so a switch is visible.
        const row = state.raw
          ?.prepare('SELECT active_organization_id AS a FROM "session" WHERE id=?')
          .get(`sess-${id}`) as { a: string | null } | undefined;
        return Promise.resolve({
          user: { id, email: `${id}@example.test`, emailVerified: true, name: id },
          session: { id: `sess-${id}`, activeOrganizationId: row?.a ?? null },
        });
      },
    },
    handler: () => new Response(null, { status: 404 }),
  }),
}));

const { default: worker } = await import('../../src/index');

const ORIGIN = 'https://noti.test';
const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;
let db: FakeD1;
let env: Bindings;

function post(as: string | null, body: unknown, init: { origin?: string | null; type?: string } = {}) {
  const headers = new Headers();
  if (as) headers.set('x-test-user', as);
  if (init.origin !== null) headers.set('origin', init.origin ?? ORIGIN);
  headers.set('content-type', init.type ?? 'application/json');
  return worker.fetch(
    new Request(`${ORIGIN}/api/workspace/active`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

const activeOf = (user: string) =>
  (
    db.raw.prepare('SELECT active_organization_id AS a FROM "session" WHERE id=?').get(`sess-${user}`) as {
      a: string | null;
    }
  ).a;

beforeEach(() => {
  db = createFakeD1();
  state.raw = db.raw;
  for (const id of ['multi', 'other']) {
    db.raw
      .prepare('INSERT INTO "user"(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(id, id, `${id}@example.test`, 1, 1, 1);
    db.raw
      .prepare('INSERT INTO "session"(id,user_id,token,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(`sess-${id}`, id, `t-${id}`, 9_999_999_999, 1, 1);
  }
  for (const org of ['org-a', 'org-b', 'org-private']) seedOrganization(db.raw, org);
  const join = db.raw.prepare(
    'INSERT INTO "member"(id,user_id,organization_id,role,created_at) VALUES(?,?,?,?,?)',
  );
  join.run('m1', 'multi', 'org-a', 'admin', 1);
  join.run('m2', 'multi', 'org-b', 'member', 2);
  join.run('m3', 'other', 'org-private', 'admin', 1);
  db.raw.prepare('UPDATE "session" SET active_organization_id=? WHERE id=?').run('org-a', 'sess-multi');
  env = { ...BOOT_ENV, DB: db.d1, APP_ORIGIN: ORIGIN } as unknown as Bindings;
});

describe('POST /api/workspace/active', () => {
  it('switches to a workspace the caller belongs to and persists it on their session', async () => {
    const res = await post('multi', { organizationId: 'org-b' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ activeOrgId: 'org-b', orgName: 'org-b', role: 'member' });
    expect(activeOf('multi')).toBe('org-b');
  });

  it('is reflected by /me afterwards', async () => {
    await post('multi', { organizationId: 'org-b' });
    const me = await worker.fetch(
      new Request(`${ORIGIN}/api/workspace/me`, { headers: { 'x-test-user': 'multi' } }),
      env,
      ctx,
    );
    const body = await me.json<{
      user: { org_id: string; activeOrgId: string; organizations: unknown[] };
    }>();
    expect(body.user).toMatchObject({ org_id: 'org-b', activeOrgId: 'org-b' });
    expect(body.user.organizations).toHaveLength(2);
  });

  it('answers a workspace the caller is not in exactly like one that does not exist', async () => {
    const real = await post('multi', { organizationId: 'org-private' });
    const missing = await post('multi', { organizationId: 'org-does-not-exist' });
    expect(real.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await real.text()).toBe(await missing.text());
    expect(activeOf('multi')).toBe('org-a');
  });

  it('never touches another user session', async () => {
    await post('multi', { organizationId: 'org-b' });
    expect(activeOf('other')).toBeNull();
  });

  it('requires a verified session', async () => {
    expect((await post(null, { organizationId: 'org-a' })).status).toBe(401);
  });

  it('refuses a cross-site request (CSRF) and a missing Origin, changing nothing', async () => {
    expect((await post('multi', { organizationId: 'org-b' }, { origin: 'https://evil.test' })).status).toBe(
      403,
    );
    expect((await post('multi', { organizationId: 'org-b' }, { origin: null })).status).toBe(403);
    expect(activeOf('multi')).toBe('org-a');
  });

  it('requires JSON and a well-formed organizationId', async () => {
    expect((await post('multi', 'organizationId=org-b', { type: 'text/plain' })).status).toBe(415);
    expect((await post('multi', {})).status).toBe(422);
    expect((await post('multi', { organizationId: 7 })).status).toBe(422);
    expect((await post('multi', { organizationId: 'x'.repeat(65) })).status).toBe(422);
    expect((await post('multi', 'not json')).status).toBe(422);
  });

  it('is rate limited per user', async () => {
    let last = 200;
    for (let i = 0; i < 31; i++) last = (await post('multi', { organizationId: 'org-a' })).status;
    expect(last).toBe(429);
    // another user's budget is untouched
    expect((await post('other', { organizationId: 'org-private' })).status).toBe(200);
  });
});
