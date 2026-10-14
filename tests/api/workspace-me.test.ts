import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOT_ENV } from '../support/boot-env';
import type { Bindings } from '../../src/env';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

/**
 * /api/workspace/me for users in every membership state. A user with no workspace yet is
 * the normal start of onboarding; answering 403 bounced them to /signin forever.
 */
vi.mock('../../src/auth/better-auth', () => ({
  createAuth: () => ({
    api: {
      getSession: ({ headers }: { headers: Headers }) => {
        const id = headers.get('x-test-user');
        return Promise.resolve(
          id
            ? {
                user: { id, email: `${id}@example.test`, emailVerified: true, name: id },
                session: { id: `sess-${id}`, activeOrganizationId: headers.get('x-test-active-org') },
              }
            : null,
        );
      },
    },
    handler: () => new Response(null, { status: 404 }),
  }),
}));

const { default: worker } = await import('../../src/index');

let db: FakeD1;
let env: Bindings;

function call(path: string, as?: string, activeOrg?: string): Promise<Response> {
  const headers = new Headers();
  if (as) headers.set('x-test-user', as);
  if (activeOrg) headers.set('x-test-active-org', activeOrg);
  return Promise.resolve(
    worker.fetch(new Request(`https://noti.test${path}`, { headers }), env, {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext),
  );
}

beforeEach(() => {
  db = createFakeD1();
  for (const id of ['newbie', 'multi']) {
    db.raw
      .prepare('INSERT INTO "user"(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(id, id, `${id}@example.test`, 1, 1, 1);
  }
  seedOrganization(db.raw, 'org-first');
  seedOrganization(db.raw, 'org-second');
  const join = db.raw.prepare(
    'INSERT INTO "member"(id,user_id,organization_id,role,created_at) VALUES(?,?,?,?,?)',
  );
  join.run('m1', 'multi', 'org-second', 'member', 20);
  join.run('m2', 'multi', 'org-first', 'admin', 10);
  db.raw
    .prepare('INSERT INTO "session"(id,user_id,token,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run('sess-multi', 'multi', 't', 9_999_999_999, 1, 1);
  env = { ...BOOT_ENV, DB: db.d1, APP_ORIGIN: 'https://noti.test' } as unknown as Bindings;
});

describe('/api/workspace/me', () => {
  it('returns the user with no workspace instead of 403, so onboarding can start', async () => {
    const res = await call('/api/workspace/me', 'newbie');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      user: { id: 'newbie', org_id: null, role: null, organizations: [] },
    });
  });

  it('still requires a session', async () => {
    expect((await call('/api/workspace/me')).status).toBe(401);
  });

  it('settles a multi-workspace user with no active workspace on their earliest one and remembers it', async () => {
    const res = await call('/api/workspace/me', 'multi');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { org_id: 'org-first', role: 'admin' } });
    expect(
      db.raw.prepare("SELECT active_organization_id AS a FROM session WHERE id='sess-multi'").get(),
    ).toEqual({
      a: 'org-first',
    });
  });

  it('honours an explicit active workspace and never invents a membership', async () => {
    const res = await call('/api/workspace/me', 'multi', 'org-second');
    expect(await res.json()).toMatchObject({ user: { org_id: 'org-second' } });
    // a stale active workspace the user does not belong to falls back to their own earliest
    const stale = await call('/api/workspace/me', 'multi', 'org-not-mine');
    expect(await stale.json()).toMatchObject({ user: { org_id: 'org-first' } });
  });

  it('keeps refusing an explicit request for a workspace the caller is not in', async () => {
    expect((await call('/api/workspace/me?org=org-not-mine', 'multi')).status).toBe(404);
  });
});
