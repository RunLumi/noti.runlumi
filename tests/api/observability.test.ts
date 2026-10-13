import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../../src/env';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

/** GET /api/observability/summary: authorization, window bounds, workspace scoping. */
vi.mock('../../src/auth/better-auth', () => ({
  createAuth: () => ({
    api: {
      getSession: ({ headers }: { headers: Headers }) => {
        const id = headers.get('x-test-user');
        return Promise.resolve(
          id
            ? {
                user: { id, email: `${id}@example.test`, emailVerified: true, name: id },
                session: { activeOrganizationId: null },
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

function member(userId: string, org: string, role: 'admin' | 'member'): void {
  db.raw
    .prepare('INSERT INTO "user"(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(userId, userId, `${userId}@example.test`, 1, 1, 1);
  db.raw
    .prepare('INSERT INTO "member"(id,user_id,organization_id,role,created_at) VALUES(?,?,?,?,?)')
    .run(`${userId}-${org}`, userId, org, role, 1);
}

async function get(path: string, as?: string): Promise<Response> {
  return await worker.fetch(
    new Request(`${ORIGIN}${path}`, { headers: as ? { 'x-test-user': as } : {} }),
    env,
    {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext,
  );
}

function delivery(org: string, state: string): void {
  db.raw
    .prepare(
      `INSERT INTO deliveries(id,integration_id,organization_id,state,attempts,created_at,last_attempt_at)
       VALUES(?,?,?,?,1,CURRENT_TIMESTAMP,?)`,
    )
    .run(`d-${Math.random().toString(36).slice(2)}`, 'i', org, state, Date.now());
}

beforeEach(() => {
  db = createFakeD1();
  seedOrganization(db.raw, 'org-a');
  seedOrganization(db.raw, 'org-b');
  member('alice', 'org-a', 'admin');
  member('bob', 'org-a', 'member');
  member('mallory', 'org-b', 'admin');
  env = {
    DB: db.d1,
    APP_ORIGIN: ORIGIN,
    KEK_V1: '11'.repeat(32),
    KMS_ACTIVE_VERSION: '1',
  } as unknown as Bindings;
});

describe('GET /api/observability/summary', () => {
  it('requires a session', async () => {
    expect((await get('/api/observability/summary')).status).toBe(401);
  });

  it('is readable by members (delivery.read) and returns only their workspace', async () => {
    delivery('org-a', 'sent');
    delivery('org-a', 'dead_lettered');
    delivery('org-b', 'sent');
    delivery('org-b', 'sent');
    const res = await get('/api/observability/summary', 'bob');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const body = await res.json<{
      provenance: string;
      deliveries: { total: number };
      successRatio: { numerator: number; denominator: number };
      notMeasurable: { sli: string }[];
    }>();
    expect(body.provenance).toBe('exact');
    expect(body.deliveries.total).toBe(2);
    expect(body.successRatio).toMatchObject({ numerator: 1, denominator: 2 });
    expect(body.notMeasurable.length).toBeGreaterThan(0);
  });

  it("does not let a member of another workspace read this workspace's figures", async () => {
    delivery('org-a', 'sent');
    const res = await get('/api/observability/summary?org=org-a', 'mallory');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('"total"');
  });

  it('accepts windows from 1h to 30d', async () => {
    for (const w of ['1h', '24h', '7d', '30d']) {
      expect((await get(`/api/observability/summary?window=${w}`, 'alice')).status).toBe(200);
    }
  });

  it.each(['31d', '0h', '90d', 'abc', '1w', '-1d'])('rejects window=%s with 400', async (w) => {
    const res = await get(`/api/observability/summary?window=${w}`, 'alice');
    expect(res.status).toBe(400);
  });

  it('reports no data for a workspace with no deliveries', async () => {
    const res = await get('/api/observability/summary', 'alice');
    const body = await res.json<{ successRatio: { value: number | null } }>();
    expect(body.successRatio.value).toBeNull();
  });
});

describe('x-request-id on the Worker', () => {
  it('is echoed on /health, replaced by our own id, and present on 401s', async () => {
    const res = await worker.fetch(
      new Request(`${ORIGIN}/health`, { headers: { 'x-request-id': 'caller-supplied-1' } }),
      env,
      {} as ExecutionContext,
    );
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    expect(id).not.toBe('caller-supplied-1');
    expect((await get('/api/observability/summary')).headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('rate limit', () => {
  it('limits a user to 30 summaries a minute with Retry-After, per user', async () => {
    for (let i = 0; i < 30; i++) expect((await get('/api/observability/summary', 'alice')).status).toBe(200);
    const limited = await get('/api/observability/summary', 'alice');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect((await get('/api/observability/summary', 'bob')).status).toBe(200);
  });
});
