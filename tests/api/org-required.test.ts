import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOT_ENV } from '../support/boot-env';
import type { Bindings } from '../../src/env';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

/**
 * A person in several workspaces must name the workspace on every write, so a tab left open on
 * workspace A can never write into B after another tab switched the session's active workspace.
 * One central rule in `resolveWorkspace`; this matrix proves it covers every mutating route.
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
                session: { id: `sess-${id}`, activeOrganizationId: 'org-a' },
              }
            : null,
        );
      },
    },
    handler: () => new Response(null, { status: 404 }),
  }),
}));

const { default: worker } = await import('../../src/index');

const ORIGIN = 'https://noti.test';
let db: FakeD1;
let env: Bindings;

function call(method: string, path: string, as: string) {
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { 'x-test-user': as, origin: ORIGIN, 'content-type': 'application/json' },
      body: method === 'GET' || method === 'DELETE' ? null : '{}',
    }),
    env,
    { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
  );
}

beforeEach(() => {
  db = createFakeD1();
  for (const id of ['multi', 'solo']) {
    db.raw
      .prepare('INSERT INTO "user"(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(id, id, `${id}@example.test`, 1, 1, 1);
  }
  for (const org of ['org-a', 'org-b']) seedOrganization(db.raw, org);
  const join = db.raw.prepare(
    'INSERT INTO "member"(id,user_id,organization_id,role,created_at) VALUES(?,?,?,?,?)',
  );
  join.run('m1', 'multi', 'org-a', 'admin', 1);
  join.run('m2', 'multi', 'org-b', 'admin', 2);
  join.run('m3', 'solo', 'org-a', 'admin', 3);
  env = {
    ...BOOT_ENV,
    DB: db.d1,
    APP_ORIGIN: ORIGIN,
    GITHUB_APP_ID: '12345',
    GITHUB_APP_SLUG: 'noti-test',
    GITHUB_CLIENT_ID: 'Iv1.testclient',
    GITHUB_CLIENT_SECRET: 'client-test-value-123',
  } as unknown as Bindings;
});

const MUTATIONS: readonly (readonly [string, string])[] = [
  ['POST', '/api/integrations'],
  ['PATCH', '/api/integrations/x'],
  ['DELETE', '/api/integrations/x'],
  ['POST', '/api/integrations/x/filters/preview'],
  ['POST', '/api/sources'],
  ['PATCH', '/api/sources/x'],
  ['POST', '/api/sources/x/rotate'],
  ['DELETE', '/api/sources/x'],
  ['POST', '/api/deliveries/x/replay'],
  ['POST', '/api/workspace/deletion'],
  ['DELETE', '/api/workspace/deletion'],
  ['POST', '/api/github/install'],
];

const refusedForOrg = async (res: Response) =>
  res.status === 400 && (await res.clone().json<{ error?: string }>()).error === 'org is required';

describe('mutations by a person in several workspaces', () => {
  for (const [method, path] of MUTATIONS) {
    it(`${method} ${path} needs ?org=`, async () => {
      const res = await call(method, path, 'multi');
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'org is required' });
    });

    it(`${method} ${path} is resolved normally with ?org=`, async () => {
      const res = await call(method, `${path}?org=org-b`, 'multi');
      expect(await refusedForOrg(res)).toBe(false);
    });

    it(`${method} ${path} needs no ?org= for a person in one workspace`, async () => {
      const res = await call(method, path, 'solo');
      expect(await refusedForOrg(res)).toBe(false);
    });
  }

  it('does not apply to reads, which fall back to the active workspace', async () => {
    for (const path of ['/api/integrations', '/api/sources', '/api/deliveries', '/api/workspace/team']) {
      expect((await call('GET', path, 'multi')).status, path).toBe(200);
    }
  });

  it('does not apply to switching the active workspace itself', async () => {
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/workspace/active`, {
        method: 'POST',
        headers: { 'x-test-user': 'multi', origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId: 'org-b' }),
      }),
      env,
      { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);
  });

  it('writes nothing when the workspace is not named', async () => {
    await call('POST', '/api/sources', 'multi');
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM sources').get()).toEqual({ n: 0 });
  });
});

describe('recorded probes are rate limited per person', () => {
  it('stops writing denial rows after 20 a minute, without changing the answer', async () => {
    for (let i = 0; i < 40; i++) {
      const res = await call('GET', `/api/integrations?org=org-nope-${i}`, 'solo');
      expect(res.status).toBe(404);
    }
    const count = (where: string) =>
      (
        db.raw
          .prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action='access.denied' AND ${where}`)
          .get() as { n: number }
      ).n;
    // 20 recorded probes, then ONE marker that the rest were not recorded (ADR 0028): the loss is visible.
    expect(count(`metadata_json LIKE '%not_a_member%'`)).toBe(20);
    expect(count(`metadata_json LIKE '%probe_audit_capped%'`)).toBe(1);
    expect(count('1=1')).toBe(21);
    // The marker names no workspace, so no tenant's admin can read it.
    expect(count(`metadata_json LIKE '%probe_audit_capped%' AND organization_id IS NULL`)).toBe(1);
  });

  it('logs the cap once a minute and never changes what the caller is told', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const statuses = new Set<number>();
    for (let i = 0; i < 40; i++)
      statuses.add((await call('GET', `/api/integrations?org=org-nope-${i}`, 'solo')).status);
    expect([...statuses]).toEqual([404]);
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('probe_audit_capped'));
    expect(lines).toHaveLength(1);
    warn.mockRestore();
  });

  it('records a refused switch the same way, against a workspace that exists', async () => {
    await worker.fetch(
      new Request(`${ORIGIN}/api/workspace/active`, {
        method: 'POST',
        headers: { 'x-test-user': 'solo', origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId: 'org-b' }),
      }),
      env,
      { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
    );
    expect(
      db.raw
        .prepare(
          "SELECT organization_id AS o, subject_id AS s FROM audit_events WHERE action='access.denied'",
        )
        .get(),
    ).toEqual({ o: 'org-b', s: 'org-b' });
  });
});
