import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOT_ENV } from '../support/boot-env';
import { FIRST_EVENT_SQL, VERIFIED_SQL, deriveProgress, STEP_IDS } from '../../src/api/setup-progress';
import type { Bindings } from '../../src/env';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

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

const T = '2026-10-01 08:00:00';

describe('deriveProgress (pure, table-driven)', () => {
  const none = { source: null, integration: null, verified: null, verifiedAccepted: null, firstEvent: null };
  const cases: {
    name: string;
    evidence: Parameters<typeof deriveProgress>[0];
    done: boolean[];
    next: string | null;
    action: string[];
  }[] = [
    {
      name: 'a new workspace has done nothing',
      evidence: none,
      done: [false, false, false, false],
      next: 'source_connected',
      action: ['connect_source', 'create_integration', 'send_test', 'trigger_real_event'],
    },
    {
      name: 'source connected only',
      evidence: { ...none, source: T },
      done: [true, false, false, false],
      next: 'integration_created',
      action: ['none', 'create_integration', 'send_test', 'trigger_real_event'],
    },
    {
      name: 'integration created, not tested',
      evidence: { ...none, source: T, integration: T },
      done: [true, true, false, false],
      next: 'destination_verified',
      action: ['none', 'none', 'send_test', 'trigger_real_event'],
    },
    {
      name: 'tested but no real event yet',
      evidence: { source: T, integration: T, verified: T, verifiedAccepted: null, firstEvent: null },
      done: [true, true, true, false],
      next: 'first_event_received',
      action: ['none', 'none', 'none', 'trigger_real_event'],
    },
    {
      name: 'everything done',
      evidence: { source: T, integration: T, verified: T, verifiedAccepted: null, firstEvent: T },
      done: [true, true, true, true],
      next: null,
      action: ['none', 'none', 'none', 'none'],
    },
    {
      name: 'steps are independent: an event arrived but the destination was never verified',
      evidence: { source: T, integration: T, verified: null, verifiedAccepted: null, firstEvent: T },
      done: [true, true, false, true],
      next: 'destination_verified',
      action: ['none', 'none', 'send_test', 'none'],
    },
  ];

  it.each(cases)('$name', ({ evidence, done, next, action }) => {
    const p = deriveProgress(evidence);
    expect(p.steps.map((s) => s.id)).toEqual([...STEP_IDS]);
    expect(p.steps.map((s) => s.done)).toEqual(done);
    expect(p.steps.map((s) => s.nextAction)).toEqual(action);
    expect(p.next).toBe(next);
    expect(p.complete).toBe(next === null);
  });

  it('accepted-only evidence is reported as accepted, not done, and does not keep the card forever', () => {
    const p = deriveProgress({ ...none, source: T, integration: T, verifiedAccepted: T, firstEvent: T });
    const step = p.steps[2];
    expect(step).toMatchObject({ status: 'accepted', done: false, nextAction: 'send_test' });
    expect(step?.since).toBe('2026-10-01T08:00:00.000Z');
    expect(p.complete).toBe(true);
    // Confirmed evidence wins over accepted.
    expect(deriveProgress({ ...none, verified: T, verifiedAccepted: T }).steps[2]?.status).toBe('done');
  });

  it('since is an ISO instant for a done step and null otherwise', () => {
    const p = deriveProgress({ ...none, source: T });
    expect(p.steps[0]?.since).toBe('2026-10-01T08:00:00.000Z');
    expect(p.steps[1]?.since).toBeNull();
  });
});

let db: FakeD1;
let env: Bindings;

function seedUser(id: string, org: string): void {
  db.raw
    .prepare('INSERT INTO "user"(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(id, id, `${id}@example.test`, 1, 1, 1);
  db.raw
    .prepare('INSERT INTO "member"(id,user_id,organization_id,role,created_at) VALUES(?,?,?,?,?)')
    .run(`${id}-${org}`, id, org, 'member', 1);
}

async function progress(as = 'bob'): Promise<Response> {
  return worker.fetch(
    new Request('https://noti.test/api/setup/progress', { headers: as ? { 'x-test-user': as } : {} }),
    env,
    { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
  );
}

interface Body {
  organizationId: string;
  steps: { id: string; done: boolean; status: string; since: string | null }[];
  complete: boolean;
  next: string | null;
}

const body = async (): Promise<Body> => await (await progress()).json();
const done = (b: Body): string[] => b.steps.filter((s) => s.done).map((s) => s.id);

function installation(org: string, status: string): void {
  db.raw
    .prepare(
      `INSERT INTO github_installations(id,organization_id,installation_id,app_id,account_login,account_type,repository_selection,status)
       VALUES(?,?,?,?,?,?,?,?)`,
    )
    .run(`gi-${org}-${status}`, org, `${org}-${status}`, '1', org, 'Organization', 'all', status);
}

function integration(id: string, org: string): void {
  db.raw
    .prepare(
      `INSERT INTO integrations(id,organization_id,repo,event_types,destination,webhook_ciphertext)
       VALUES(?,?,'acme/web','[]','slack','')`,
    )
    .run(id, org);
}

const nowSql = (): string => new Date().toISOString().slice(0, 19).replace('T', ' ');

function delivery(
  id: string,
  org: string,
  state: string,
  opts: { test?: boolean; createdAt?: string } = {},
): void {
  db.raw
    .prepare(
      'INSERT INTO deliveries(id,integration_id,organization_id,state,created_at,is_test) VALUES(?,?,?,?,?,?)',
    )
    .run(id, 'int-a', org, state, opts.createdAt ?? nowSql(), opts.test ? 1 : 0);
}

beforeEach(() => {
  db = createFakeD1();
  seedOrganization(db.raw, 'org-a');
  seedOrganization(db.raw, 'org-b');
  seedUser('bob', 'org-a');
  seedUser('mallory', 'org-b');
  env = { ...BOOT_ENV, DB: db.d1, APP_ORIGIN: 'https://noti.test' } as unknown as Bindings;
});

describe('GET /api/setup/progress', () => {
  it('requires a session', async () => {
    expect((await progress('')).status).toBe(401);
  });

  it('an empty workspace has nothing done', async () => {
    const b = await body();
    expect(done(b)).toEqual([]);
    expect(b.next).toBe('source_connected');
  });

  it('only an ACTIVE installation counts; a suspended one does not', async () => {
    installation('org-a', 'suspended');
    expect(done(await body())).toEqual([]);
    installation('org-a', 'active');
    expect(done(await body())).toEqual(['source_connected']);
  });

  it('a generic source counts as a connected source', async () => {
    db.raw
      .prepare(
        `INSERT INTO sources(id,organization_id,kind,name,endpoint_id,secret_envelope,key_salt,dek_wrapped,kek_version,enabled,created_by)
         VALUES('s1','org-a','generic','CI',?,x'0a',x'0b',x'0c',1,1,'bob')`,
      )
      .run('e'.repeat(24));
    expect(done(await body())).toEqual(['source_connected']);
  });

  it('a test delivery verifies the destination but is NOT a real event', async () => {
    integration('int-a', 'org-a');
    delivery('t1', 'org-a', 'sent', { test: true });
    const b = await body();
    expect(done(b)).toEqual(['integration_created', 'destination_verified']);
    expect(b.next).toBe('source_connected');
  });

  it('failed, retrying and pending verify nothing; accepted is reported separately (see below)', async () => {
    integration('int-a', 'org-a');
    delivery('f1', 'org-a', 'dead_lettered', { test: true });
    delivery('f2', 'org-a', 'retrying', { test: true });
    delivery('f3', 'org-a', 'pending', { test: true });
    expect(done(await body())).toEqual(['integration_created']);
    delivery('a1', 'org-a', 'accepted', { test: true });
    expect(done(await body())).not.toContain('destination_verified');
  });

  it('a delivery older than 30 days does not verify', async () => {
    integration('int-a', 'org-a');
    delivery('old', 'org-a', 'sent', { createdAt: '2020-01-01 00:00:00' });
    expect(done(await body())).toEqual(['integration_created', 'first_event_received']);
  });

  it('a real event in any state (even failed) proves the source reached us', async () => {
    integration('int-a', 'org-a');
    delivery('r1', 'org-a', 'dead_lettered');
    expect(done(await body())).toEqual(['integration_created', 'first_event_received']);
  });

  it('everything done is complete', async () => {
    installation('org-a', 'active');
    integration('int-a', 'org-a');
    delivery('r1', 'org-a', 'sent');
    const b = await body();
    expect(b.complete).toBe(true);
    expect(b.next).toBeNull();
  });

  it('never counts another workspace’s rows', async () => {
    installation('org-b', 'active');
    integration('int-b', 'org-b');
    delivery('x1', 'org-b', 'sent');
    const b = await body();
    expect(b.organizationId).toBe('org-a');
    expect(done(b)).toEqual([]);
  });
});

describe('destination_verified: usable integrations only, and accepted is its own state', () => {
  const status = async (): Promise<string | undefined> =>
    (await body()).steps.find((x) => x.id === 'destination_verified')?.status;

  it('a delivery to a since-deleted integration verifies nothing', async () => {
    integration('int-a', 'org-a');
    delivery('s1', 'org-a', 'sent');
    expect(await status()).toBe('done');
    db.raw.prepare("DELETE FROM integrations WHERE id='int-a'").run();
    expect(await status()).toBe('todo');
  });

  it('a quarantined or paused integration verifies nothing', async () => {
    integration('int-a', 'org-a');
    delivery('s1', 'org-a', 'sent');
    db.raw.prepare("UPDATE integrations SET credentials_quarantined_at='2026-10-01 00:00:00'").run();
    expect(await status()).toBe('todo');
    db.raw.prepare('UPDATE integrations SET credentials_quarantined_at=NULL, enabled=0').run();
    expect(await status()).toBe('todo');
  });

  it('accepted-only evidence (Teams) is `accepted`; a confirmed one upgrades it to `done`', async () => {
    integration('int-a', 'org-a');
    delivery('a1', 'org-a', 'accepted', { test: true });
    expect(await status()).toBe('accepted');
    expect(done(await body())).not.toContain('destination_verified');
    delivery('s1', 'org-a', 'sent', { test: true });
    expect(await status()).toBe('done');
  });

  it('a disabled source does not count as a connected source', async () => {
    db.raw
      .prepare(
        `INSERT INTO sources(id,organization_id,kind,name,endpoint_id,secret_envelope,key_salt,dek_wrapped,kek_version,enabled,created_by)
         VALUES('s1','org-a','generic','CI',?,x'0a',x'0b',x'0c',1,0,'bob')`,
      )
      .run('e'.repeat(24));
    expect(done(await body())).toEqual([]);
  });

  it('every evidence query is index-driven: EXPLAIN QUERY PLAN names deliveries_org_created and no full scan of deliveries', async () => {
    for (const [sql, args] of [
      [VERIFIED_SQL, ['org-a', '2026-01-01 00:00:00', 'sent']],
      [FIRST_EVENT_SQL, ['org-a', '1970-01-01 00:00:00']],
    ] as const) {
      const rows = await db.d1
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...args)
        .all<{ detail: string }>();
      const plan = rows.results.map((r) => r.detail).join('\n');
      expect(plan).toContain('deliveries_org_created');
      expect(plan).not.toMatch(/SCAN d(eliveries)?(?! USING)\b/);
    }
  });
});
