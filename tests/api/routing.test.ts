import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings, DeliveryMessage } from '../../src/env';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

/**
 * Routing filters through the API (create, update, dry run, routing log) over the real
 * migrations. Only Better Auth's session lookup is replaced: the `x-test-user` header names
 * the signed-in user. Membership, capabilities, sealing, audit and SQL all run for real.
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
                session: { activeOrganizationId: headers.get('x-test-active-org') },
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
const SLACK = 'https://hooks.slack.com/services/T000/B000/SecretTokenPath';
let db: FakeD1;
let env: Bindings;
let fetchMock: ReturnType<typeof vi.fn>;

function user(id: string): void {
  db.raw
    .prepare('INSERT INTO "user"(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(id, id, `${id}@example.test`, 1, 1, 1);
}

function member(userId: string, org: string, role: 'admin' | 'member'): void {
  db.raw
    .prepare('INSERT INTO "member"(id,user_id,organization_id,role,created_at) VALUES(?,?,?,?,?)')
    .run(`${userId}-${org}`, userId, org, role, 1);
}

function githubInstallation(org: string, installationId: string): void {
  db.raw
    .prepare(
      `INSERT INTO github_installations(id,organization_id,installation_id,app_id,account_login,account_type,repository_selection)
       VALUES(?,?,?,?,?,?,?)`,
    )
    .run(`gi-${installationId}`, org, installationId, '1', 'acme', 'Organization', 'all');
}

async function call(
  method: string,
  path: string,
  options: { as?: string; body?: unknown; origin?: string | null } = {},
): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.as) headers.set('x-test-user', options.as);
  if (options.origin !== null) headers.set('origin', options.origin ?? ORIGIN);
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    env,
    { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
  );
}

const create = (as: string, body: Record<string, unknown> = {}) =>
  call('POST', '/api/integrations', {
    as,
    body: {
      name: 'Alerts',
      repo: 'acme/web',
      eventTypes: ['pull_request.opened'],
      destination: 'slack',
      webhookUrl: SLACK,
      ...body,
    },
  });

async function json<T>(res: Response): Promise<T> {
  return await res.json();
}

beforeEach(() => {
  db = createFakeD1();
  seedOrganization(db.raw, 'org-a');
  seedOrganization(db.raw, 'org-b');
  for (const id of ['alice', 'bob', 'mallory']) user(id);
  member('alice', 'org-a', 'admin');
  member('bob', 'org-a', 'member');
  member('mallory', 'org-b', 'admin');
  githubInstallation('org-a', '1001');
  githubInstallation('org-b', '1002');
  env = {
    DB: db.d1,
    APP_ORIGIN: ORIGIN,
    KEK_V1: '11'.repeat(32),
    KEK_V2: '',
    KMS_ACTIVE_VERSION: '1',
    ENCRYPTION_KEY: '',
    GITHUB_APP_ID: '1',
    GITHUB_WEBHOOK_SECRET: 'x',
    DELIVERY_QUEUE: { send: (_m: DeliveryMessage) => Promise.resolve() },
  } as unknown as Bindings;
  fetchMock = vi.fn(() => Promise.resolve(new Response('ok')));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

const filters = {
  branch: { allow: [' main ', 'release/**'], deny: ['wip/*'] },
  actor: { bots: 'exclude', deny: ['octocat'] },
  draft: 'exclude',
  labels: { include: ['bug'] },
};

type FilterView = {
  id: string;
  filters: Record<string, unknown>;
  filtersInvalid: boolean;
};

function lastAudit(action: string): Record<string, unknown> {
  const row = db.raw
    .prepare('SELECT metadata_json FROM audit_events WHERE action=? ORDER BY rowid DESC LIMIT 1')
    .get(action) as { metadata_json: string };
  return JSON.parse(row.metadata_json) as Record<string, unknown>;
}

describe('filters on create and update', () => {
  it('stores normalised filters and returns them', async () => {
    const res = await create('alice', { filters });
    expect(res.status).toBe(201);
    const { integration } = await json<{ integration: FilterView }>(res);
    expect(integration.filters).toEqual({
      branch: { allow: ['main', 'release/**'], deny: ['wip/*'] },
      actor: { allow: [], deny: ['octocat'], bots: 'exclude' },
      draft: 'exclude',
      labels: { include: ['bug'], exclude: [] },
    });
    expect(integration.filtersInvalid).toBe(false);
    const stored = db.raw.prepare('SELECT filters_json FROM integrations WHERE id=?').get(integration.id) as {
      filters_json: string;
    };
    expect(JSON.parse(stored.filters_json)).toMatchObject({ v: 1, draft: 'exclude' });
  });

  it('creates with no filters by default', async () => {
    const { integration } = await json<{ integration: FilterView }>(await create('alice'));
    expect(integration.filters).toEqual({});
    expect(db.raw.prepare('SELECT filters_json FROM integrations').get()).toEqual({ filters_json: null });
  });

  it('rejects invalid filters with dotted field paths and creates nothing', async () => {
    const res = await create('alice', { filters: { branch: { allow: ['a?b'] }, bogus: {} } });
    expect(res.status).toBe(422);
    const body = await json<{ fields: { field: string }[] }>(res);
    expect(body.fields.map((f) => f.field).sort()).toEqual(['filters.bogus', 'filters.branch.allow[0]']);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM integrations').get()).toEqual({ n: 0 });
  });

  it('audits changed filter ids only, never their values', async () => {
    const { integration } = await json<{ integration: FilterView }>(await create('alice', { filters }));
    expect(lastAudit('integration.create').filters).toEqual(['branch', 'actor', 'draft', 'labels']);
    const res = await call('PATCH', `/api/integrations/${integration.id}`, {
      as: 'alice',
      body: {
        filters: { ...filters, labels: { include: ['bug', 'regression-private-label'] }, draft: undefined },
      },
    });
    expect(res.status).toBe(200);
    expect(lastAudit('integration.update').filters).toEqual(['draft', 'labels']);
    const all = JSON.stringify(db.raw.prepare('SELECT metadata_json FROM audit_events').all());
    expect(all).not.toContain('regression-private-label');
    expect(all).not.toContain('release/**');
    expect(all).not.toContain('octocat');
  });

  it('replaces filters on update and clears them with null', async () => {
    const { integration } = await json<{ integration: FilterView }>(await create('alice', { filters }));
    const path = `/api/integrations/${integration.id}`;
    const replaced = await json<{ integration: FilterView }>(
      await call('PATCH', path, { as: 'alice', body: { filters: { draft: 'exclude' } } }),
    );
    expect(replaced.integration.filters).toEqual({ draft: 'exclude' });
    const cleared = await json<{ integration: FilterView }>(
      await call('PATCH', path, { as: 'alice', body: { filters: null } }),
    );
    expect(cleared.integration.filters).toEqual({});
    expect(db.raw.prepare('SELECT filters_json FROM integrations').get()).toEqual({ filters_json: null });
  });

  it('rejects an invalid update without changing the stored filters', async () => {
    const { integration } = await json<{ integration: FilterView }>(await create('alice', { filters }));
    const res = await call('PATCH', `/api/integrations/${integration.id}`, {
      as: 'alice',
      body: { filters: { actor: { deny: ['ghost'] } } },
    });
    expect(res.status).toBe(422);
    const view = await json<{ integration: FilterView }>(
      await call('GET', `/api/integrations/${integration.id}`, { as: 'alice' }),
    );
    expect(view.integration.filters).toMatchObject({ draft: 'exclude' });
  });

  it('reports corrupt stored filters as filtersInvalid (events are held back) and shows none', async () => {
    const { integration } = await json<{ integration: FilterView }>(await create('alice'));
    db.raw.prepare('UPDATE integrations SET filters_json=? WHERE id=?').run('[1,2]', integration.id);
    const view = await json<{ integration: FilterView & { filtersNewer: boolean } }>(
      await call('GET', `/api/integrations/${integration.id}`, { as: 'alice' }),
    );
    expect(view.integration).toMatchObject({ filters: {}, filtersInvalid: true, filtersNewer: false });
  });

  it('reports a newer-version document as filtersNewer, not invalid', async () => {
    const { integration } = await json<{ integration: FilterView }>(await create('alice'));
    db.raw.prepare('UPDATE integrations SET filters_json=? WHERE id=?').run('{"v":99}', integration.id);
    const view = await json<{ integration: FilterView & { filtersNewer: boolean } }>(
      await call('GET', `/api/integrations/${integration.id}`, { as: 'alice' }),
    );
    expect(view.integration).toMatchObject({ filtersInvalid: false, filtersNewer: true });
  });

  it('replaces corrupt stored filters when new ones are saved', async () => {
    const { integration } = await json<{ integration: FilterView }>(await create('alice'));
    db.raw.prepare('UPDATE integrations SET filters_json=? WHERE id=?').run('[1,2]', integration.id);
    const res = await call('PATCH', `/api/integrations/${integration.id}`, {
      as: 'alice',
      body: { filters: { draft: 'exclude' } },
    });
    const body = await json<{ integration: FilterView }>(res);
    expect(body.integration).toMatchObject({ filters: { draft: 'exclude' }, filtersInvalid: false });
  });

  it('another workspace cannot change filters', async () => {
    const { integration } = await json<{ integration: FilterView }>(await create('alice'));
    const res = await call('PATCH', `/api/integrations/${integration.id}`, {
      as: 'mallory',
      body: { filters: { draft: 'exclude' } },
    });
    expect(res.status).toBe(404);
    expect(db.raw.prepare('SELECT filters_json FROM integrations').get()).toEqual({ filters_json: null });
  });
});

describe('filters must fit the subscribed events (H2)', () => {
  const only = { branch: { allow: ['main'] } };
  type Fields = { fields: { field: string; message: string }[] };

  it('rejects an "only" list on events that cannot read it, without echoing the value', async () => {
    const res = await create('alice', {
      eventTypes: ['push', 'issues.opened'],
      filters: { branch: { allow: ['super-secret-branch'] } },
    });
    expect(res.status).toBe(422);
    const body = await json<Fields>(res);
    expect(body.fields.map((f) => f.field)).toEqual(['filters.coverage']);
    expect(JSON.stringify(body)).toContain('issues.opened');
    expect(JSON.stringify(body)).not.toContain('super-secret-branch');
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM integrations').get()).toEqual({ n: 0 });
  });

  it('accepts a "never" rule on such events and returns a warning naming them', async () => {
    const res = await create('alice', {
      eventTypes: ['push', 'issues.opened'],
      filters: { branch: { deny: ['wip'] } },
    });
    expect(res.status).toBe(201);
    const body = await json<{ warnings: { filter: string; eventTypes: string[] }[] }>(res);
    expect(body.warnings).toEqual([{ filter: 'branch', eventTypes: ['issues.opened'] }]);
  });

  it('returns no warnings when every selected event can be filtered', async () => {
    const body = await json<{ warnings: unknown[] }>(await create('alice', { filters: only }));
    expect(body.warnings).toEqual([]);
  });

  it('rejects subscribing to an event the saved "only" list cannot read', async () => {
    const { integration } = await json<{ integration: FilterView }>(await create('alice', { filters: only }));
    const res = await call('PATCH', `/api/integrations/${integration.id}`, {
      as: 'alice',
      body: { eventTypes: ['pull_request.opened', 'issues.opened'] },
    });
    expect(res.status).toBe(422);
    expect((await json<Fields>(res)).fields.map((f) => f.field)).toEqual(['filters.coverage']);
    expect(db.raw.prepare('SELECT event_types FROM integrations').get()).toEqual({
      event_types: '["pull_request.opened"]',
    });
  });

  it('rejects adding an "only" list to events that cannot read it, and allows fixing both at once', async () => {
    const { integration } = await json<{ integration: FilterView }>(
      await create('alice', { eventTypes: ['issues.opened'] }),
    );
    const path = `/api/integrations/${integration.id}`;
    expect((await call('PATCH', path, { as: 'alice', body: { filters: only } })).status).toBe(422);
    const both = await call('PATCH', path, {
      as: 'alice',
      body: { filters: only, eventTypes: ['push'] },
    });
    expect(both.status).toBe(200);
  });

  it('warns on update for a "never" rule that does not cover some events', async () => {
    const { integration } = await json<{ integration: FilterView }>(
      await create('alice', { eventTypes: ['push', 'issues.opened'] }),
    );
    const res = await call('PATCH', `/api/integrations/${integration.id}`, {
      as: 'alice',
      body: { filters: { draft: 'exclude' } },
    });
    const body = await json<{ warnings: { filter: string }[] }>(res);
    expect(body.warnings.map((w) => w.filter)).toEqual(['draft']);
  });
});

describe('deleting an integration deletes its routing decisions (M2)', () => {
  it('removes them in the same transaction, and only this integration’s', async () => {
    const a = (await json<{ integration: FilterView }>(await create('alice'))).integration.id;
    const b = (await json<{ integration: FilterView }>(await create('alice', { name: 'Other' }))).integration
      .id;
    const insert = db.raw.prepare(
      `INSERT INTO routing_decisions(id,organization_id,integration_id,event_type,outcome,reason,decided_at)
       VALUES(?,?,?,?,?,?,?)`,
    );
    insert.run('r1', 'org-a', a, 'push', 'delivered', 'allowed', 1);
    insert.run('r2', 'org-a', b, 'push', 'delivered', 'allowed', 1);
    expect((await call('DELETE', `/api/integrations/${a}`, { as: 'alice' })).status).toBe(204);
    expect(db.raw.prepare('SELECT id FROM routing_decisions').all()).toEqual([{ id: 'r2' }]);
  });

  it('a delete by another workspace removes nothing', async () => {
    const a = (await json<{ integration: FilterView }>(await create('alice'))).integration.id;
    db.raw
      .prepare(
        `INSERT INTO routing_decisions(id,organization_id,integration_id,event_type,outcome,reason,decided_at)
         VALUES('r1','org-a',?,'push','delivered','allowed',1)`,
      )
      .run(a);
    expect((await call('DELETE', `/api/integrations/${a}`, { as: 'mallory' })).status).toBe(404);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM routing_decisions').get()).toEqual({ n: 1 });
  });
});

describe('POST /api/integrations/:id/filters/preview', () => {
  let id: string;
  beforeEach(async () => {
    const created = await create('alice', { filters: { branch: { allow: ['main'] } } });
    id = (await json<{ integration: FilterView }>(created)).integration.id;
  });
  const preview = (body: unknown, options: { as?: string; origin?: string | null } = {}) =>
    call('POST', `/api/integrations/${id}/filters/preview`, {
      as: options.as ?? 'alice',
      body,
      ...(options.origin !== undefined ? { origin: options.origin } : {}),
    });

  it('evaluates the saved filters against sample facts', async () => {
    const hit = await json<{ result: Record<string, unknown> }>(
      await preview({ eventType: 'push', facts: { branch: 'main' } }),
    );
    expect(hit.result).toEqual({
      outcome: 'delivered',
      filterId: null,
      reason: 'allowed',
      unknownFact: false,
    });
    const miss = await json<{ result: Record<string, unknown> }>(
      await preview({ eventType: 'push', facts: { branch: 'dev' } }),
    );
    expect(miss.result).toEqual({
      outcome: 'filtered',
      filterId: 'branch',
      reason: 'not_in_allow_list',
      unknownFact: false,
    });
  });

  it('evaluates an unsaved draft instead when one is sent, and holds back unknown facts', async () => {
    const res = await json<{ result: Record<string, unknown> }>(
      await preview({ eventType: 'pull_request.opened', facts: {}, filters: { draft: 'exclude' } }),
    );
    expect(res.result).toMatchObject({ outcome: 'filtered', reason: 'unknown_fact', unknownFact: true });
  });

  it('is pure: no delivery, outbox, audit or decision row is written and nothing is fetched', async () => {
    const tables = ['deliveries', 'notification_outbox', 'audit_events', 'routing_decisions'];
    const count = (t: string) => (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const before = tables.map(count);
    await preview({ eventType: 'push', facts: { branch: 'dev' } });
    expect(tables.map(count)).toEqual(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown event type', { eventType: 'star.created', facts: {} }, 'eventType'],
    ['missing event type', { facts: {} }, 'eventType'],
    ['unknown fact', { eventType: 'push', facts: { payload: 'x' } }, 'facts.payload'],
    ['over-long fact', { eventType: 'push', facts: { branch: 'a'.repeat(300) } }, 'facts.branch'],
    [
      'invalid draft filters',
      { eventType: 'push', facts: {}, filters: { branch: { allow: ['a?'] } } },
      'filters.branch.allow[0]',
    ],
  ])('rejects %s', async (_n, body, field) => {
    const res = await preview(body);
    expect(res.status).toBe(422);
    expect((await json<{ fields: { field: string }[] }>(res)).fields.map((f) => f.field)).toContain(field);
  });

  it('enforces the CSRF rules like every mutation', async () => {
    expect((await preview({ eventType: 'push' }, { origin: null })).status).toBe(403);
    expect((await preview({ eventType: 'push' }, { origin: 'https://evil.test' })).status).toBe(403);
    const form = await worker.fetch(
      new Request(`${ORIGIN}/api/integrations/${id}/filters/preview`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'text/plain', 'x-test-user': 'alice' },
        body: '{}',
      }),
      env,
      { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
    );
    expect(form.status).toBe(415);
  });

  it('requires a session and membership; another workspace sees 404', async () => {
    const anon = await call('POST', `/api/integrations/${id}/filters/preview`, {
      body: { eventType: 'push' },
    });
    expect(anon.status).toBe(401);
    expect((await preview({ eventType: 'push' }, { as: 'mallory' })).status).toBe(404);
  });

  it('is available to any workspace member', async () => {
    expect((await preview({ eventType: 'push', facts: { branch: 'main' } }, { as: 'bob' })).status).toBe(200);
  });

  it('is rate limited per user', async () => {
    let last = 200;
    for (let i = 0; i < 62; i++) last = (await preview({ eventType: 'push', facts: {} })).status;
    expect(last).toBe(429);
  });
});

describe('GET /api/integrations/:id/routing-log', () => {
  let id: string;
  const row = (n: number, outcome: 'delivered' | 'filtered' = 'delivered', org = 'org-a') =>
    db.raw
      .prepare(
        `INSERT INTO routing_decisions(id,organization_id,integration_id,event_type,outcome,filter_id,reason,decided_at)
         VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        String(n).padStart(8, '0'),
        org,
        id,
        'push',
        outcome,
        outcome === 'filtered' ? 'branch' : null,
        outcome === 'filtered' ? 'not_in_allow_list' : 'allowed',
        1_700_000_000_000 + n * 1000,
      );

  beforeEach(async () => {
    id = (await json<{ integration: FilterView }>(await create('alice'))).integration.id;
  });

  type Page = {
    entries: { id: string; outcome: string; filterId: string | null; reason: string }[];
    nextCursor: string | null;
  };
  const page = async (query: string) =>
    json<Page>(await call('GET', `/api/integrations/${id}/routing-log?${query}`, { as: 'bob' }));

  it('lists newest first and pages with an opaque cursor', async () => {
    for (let n = 1; n <= 5; n++) row(n, n % 2 ? 'filtered' : 'delivered');
    const first = await page('limit=2');
    expect(first.entries.map((e) => e.id)).toEqual(['00000005', '00000004']);
    expect(first.entries[0]).toMatchObject({
      outcome: 'filtered',
      filterId: 'branch',
      reason: 'not_in_allow_list',
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await page(`limit=2&cursor=${first.nextCursor}`);
    expect(second.entries.map((e) => e.id)).toEqual(['00000003', '00000002']);
    const third = await page(`limit=2&cursor=${second.nextCursor}`);
    expect(third.entries.map((e) => e.id)).toEqual(['00000001']);
    expect(third.nextCursor).toBeNull();
  });

  it('never returns another workspace’s rows, even when a row names this integration id', async () => {
    row(1);
    row(2, 'delivered', 'org-b');
    const own = await page('');
    expect(own.entries).toHaveLength(1);
    expect((await call('GET', `/api/integrations/${id}/routing-log`, { as: 'mallory' })).status).toBe(404);
  });

  it.each(['limit=0', 'limit=101', 'limit=abc', 'cursor=!!', 'cursor=' + 'a'.repeat(300)])(
    'rejects bad query %s',
    async (q) => {
      expect((await call('GET', `/api/integrations/${id}/routing-log?${q}`, { as: 'alice' })).status).toBe(
        400,
      );
    },
  );

  it('requires a session', async () => {
    expect((await call('GET', `/api/integrations/${id}/routing-log`)).status).toBe(401);
  });
});
