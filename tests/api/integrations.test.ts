import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings, DeliveryMessage } from '../../src/env';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

/**
 * The integrations API over the real migrations. Only Better Auth's session lookup is
 * replaced: the `x-test-user` header names the signed-in user. Membership resolution,
 * capability checks, sealing, audit and SQL all run for real.
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

function githubInstallation(
  org: string,
  installationId: string,
  selection: 'all' | 'selected' = 'all',
): string {
  const id = `gi-${installationId}`;
  db.raw
    .prepare(
      `INSERT INTO github_installations(id,organization_id,installation_id,app_id,account_login,account_type,repository_selection)
       VALUES(?,?,?,?,?,?,?)`,
    )
    .run(id, org, installationId, '1', 'acme', 'Organization', selection);
  return id;
}

async function call(
  method: string,
  path: string,
  options: { as?: string; body?: unknown; origin?: string | null; org?: string } = {},
): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.as) headers.set('x-test-user', options.as);
  if (options.org) headers.set('x-test-active-org', options.org);
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
      eventTypes: ['issues.opened'],
      destination: 'slack',
      webhookUrl: SLACK,
      ...body,
    },
  });

async function json<T>(res: Response): Promise<T> {
  return await res.json();
}

type View = {
  id: string;
  credentials: string;
  destinationHost: string;
  enabled: boolean;
  eventTypes: string[];
};

function auditActions(org: string): string[] {
  return (
    db.raw.prepare('SELECT action FROM audit_events WHERE organization_id=? ORDER BY rowid').all(org) as {
      action: string;
    }[]
  ).map((r) => r.action);
}

beforeEach(() => {
  db = createFakeD1();
  seedOrganization(db.raw, 'org-a');
  seedOrganization(db.raw, 'org-b');
  for (const id of ['alice', 'bob', 'mallory']) user(id);
  member('alice', 'org-a', 'admin');
  member('bob', 'org-a', 'member');
  member('mallory', 'org-b', 'admin');
  // Each workspace has connected GitHub for the `acme` account (F67: an integration may
  // only name a repository an active installation covers).
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

describe('integrations API', () => {
  it('creates a sealed integration and never returns the URL', async () => {
    const res = await create('bob');
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain('SecretTokenPath');
    const { integration } = JSON.parse(text) as { integration: View };
    expect(integration).toMatchObject({
      credentials: 'ok',
      destinationHost: 'hooks.slack.com',
      enabled: true,
    });

    const row = db.raw.prepare('SELECT * FROM integrations WHERE id=?').get(integration.id) as Record<
      string,
      unknown
    >;
    expect(row.organization_id).toBe('org-a');
    expect(row.webhook_ciphertext).toBe('');
    expect(JSON.stringify(Object.values(row).map(String))).not.toContain('SecretTokenPath');
    expect(auditActions('org-a')).toEqual(['integration.create']);
  });

  it('lists only the caller’s workspace', async () => {
    await create('alice');
    await create('mallory', { name: 'Other tenant' });
    const { integrations } = await json<{ integrations: View[] }>(
      await call('GET', '/api/integrations', { as: 'bob' }),
    );
    expect(integrations).toHaveLength(1);
  });

  it('returns 404 for another workspace’s integration on every verb', async () => {
    const { integration } = await json<{ integration: View }>(await create('alice'));
    const path = `/api/integrations/${integration.id}`;
    expect((await call('GET', path, { as: 'mallory' })).status).toBe(404);
    expect((await call('PATCH', path, { as: 'mallory', body: { enabled: false } })).status).toBe(404);
    expect((await call('DELETE', path, { as: 'mallory' })).status).toBe(404);
    const still = await json<{ integration: View }>(await call('GET', path, { as: 'alice' }));
    expect(still.integration.enabled).toBe(true);
  });

  it('returns 404 and audits a request for a workspace the caller does not belong to', async () => {
    const res = await call('GET', '/api/integrations?org=org-a', { as: 'mallory' });
    expect(res.status).toBe(404);
    const row = db.raw.prepare('SELECT * FROM audit_events WHERE action=?').get('access.denied') as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({ organization_id: 'org-a', actor_id: 'mallory', outcome: 'denied' });
  });

  it('rejects mutations without our Origin or without JSON (CSRF)', async () => {
    expect((await call('POST', '/api/integrations', { as: 'bob', origin: null, body: {} })).status).toBe(403);
    expect(
      (await call('POST', '/api/integrations', { as: 'bob', origin: 'https://evil.test', body: {} })).status,
    ).toBe(403);
    const form = await worker.fetch(
      new Request(`${ORIGIN}/api/integrations`, {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'x-test-user': 'bob',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'a=b',
      }),
      env,
      {} as ExecutionContext,
    );
    expect(form.status).toBe(415);
  });

  it('requires a session', async () => {
    expect((await call('GET', '/api/integrations')).status).toBe(401);
  });

  it('returns field errors without echoing input', async () => {
    const res = await create('bob', { webhookUrl: 'https://evil.test/leak-me' });
    expect(res.status).toBe(422);
    expect(await res.text()).not.toContain('leak-me');
  });

  it('updates fields and rotates credentials with fresh key material', async () => {
    const { integration } = await json<{ integration: View }>(await create('bob'));
    const before = db.raw.prepare('SELECT dek_wrapped FROM integrations WHERE id=?').get(integration.id) as {
      dek_wrapped: Uint8Array;
    };
    db.raw.prepare("UPDATE integrations SET credentials_quarantined_at='x' WHERE id=?").run(integration.id);

    const res = await call('PATCH', `/api/integrations/${integration.id}`, {
      as: 'bob',
      body: { enabled: false, webhookUrl: 'https://hooks.slack.com/services/T1/B1/NewTokenPath' },
    });
    expect(res.status).toBe(200);
    const { integration: updated } = await json<{ integration: View }>(res);
    expect(updated).toMatchObject({ enabled: false, credentials: 'ok' });
    const after = db.raw.prepare('SELECT dek_wrapped FROM integrations WHERE id=?').get(integration.id) as {
      dek_wrapped: Uint8Array;
    };
    expect(after.dek_wrapped).not.toEqual(before.dek_wrapped);
    expect(auditActions('org-a')).toEqual([
      'integration.create',
      'integration.credentials.rotate',
      'integration.update',
    ]);
  });

  it('deletes an integration and audits it', async () => {
    const { integration } = await json<{ integration: View }>(await create('bob'));
    expect((await call('DELETE', `/api/integrations/${integration.id}`, { as: 'bob' })).status).toBe(204);
    expect((await call('GET', `/api/integrations/${integration.id}`, { as: 'bob' })).status).toBe(404);
    expect(auditActions('org-a')).toEqual(['integration.create', 'integration.delete']);
  });

  it('database refuses an integration without a workspace or moved to another', () => {
    expect(() =>
      db.raw
        .prepare(
          "INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext) VALUES('x','a/b','[]','slack','')",
        )
        .run(),
    ).toThrow(/organization_id is required/);
  });

  it('the audit log is append-only', async () => {
    await create('bob');
    expect(() => db.raw.exec("UPDATE audit_events SET action='x'")).toThrow(/append-only/);
  });

  it('the created integration actually delivers end to end', async () => {
    const { integration } = await json<{ integration: View }>(await create('bob'));
    const { consumeDeliveries } = await import('../../src/pipeline/consumer');
    db.raw
      .prepare(
        "INSERT INTO deliveries(id,integration_id,organization_id,state) VALUES('d1',?,'org-a','pending')",
      )
      .run(integration.id);
    const msg = {
      body: { id: 'd1', integrationId: integration.id, organizationId: 'org-a', title: 't', url: '' },
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await consumeDeliveries({ messages: [msg], retryAll: vi.fn() } as unknown as MessageBatch<unknown>, env);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(SLACK);
    expect(msg.ack).toHaveBeenCalled();
  });
});

describe('Microsoft Teams integrations', () => {
  const TEAMS =
    'https://prod-12.westus.logic.azure.com/workflows/abc123/triggers/manual/paths/invoke?sig=TeamsSecretSig';
  const teams = { destination: 'teams', webhookUrl: TEAMS };

  it('creates a Teams integration, never returns the URL, and delivers it as accepted', async () => {
    const res = await create('bob', teams);
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain('TeamsSecretSig');
    const { integration } = JSON.parse(text) as { integration: View & { destination: string } };
    expect(integration).toMatchObject({
      destination: 'teams',
      destinationHost: 'prod-12.westus.logic.azure.com',
    });

    const { consumeDeliveries } = await import('../../src/pipeline/consumer');
    db.raw
      .prepare(
        "INSERT INTO deliveries(id,integration_id,organization_id,state) VALUES('d1',?,'org-a','pending')",
      )
      .run(integration.id);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));
    const msg = {
      body: { id: 'd1', integrationId: integration.id, organizationId: 'org-a', title: 't', url: '' },
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await consumeDeliveries({ messages: [msg], retryAll: vi.fn() } as unknown as MessageBatch<unknown>, env);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(TEAMS);
    expect(db.raw.prepare("SELECT state FROM deliveries WHERE id='d1'").get()).toEqual({ state: 'accepted' });
  });

  it('answers 422 with field errors for unsupported trigger authentication, without echoing input', async () => {
    const res = await create('bob', { ...teams, triggerAuth: 'tenant_users' });
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).not.toContain('TeamsSecretSig');
    expect(JSON.parse(text)).toMatchObject({
      error: 'Validation failed',
      fields: [{ field: 'triggerAuth' }],
    });
  });

  it('refuses a Slack URL for a Teams integration', async () => {
    expect((await create('bob', { destination: 'teams' })).status).toBe(422);
  });
});

describe('member capability limits', () => {
  it('lets a member manage integrations', async () => {
    expect((await create('bob')).status).toBe(201);
  });
});

describe('review hardening', () => {
  it('rejects PATCH and DELETE without our Origin', async () => {
    const { integration } = await json<{ integration: View }>(await create('bob'));
    const path = `/api/integrations/${integration.id}`;
    expect(
      (await call('PATCH', path, { as: 'bob', origin: 'https://evil.test', body: { enabled: false } }))
        .status,
    ).toBe(403);
    expect((await call('DELETE', path, { as: 'bob', origin: null })).status).toBe(403);
  });

  it('scopes ?org= for a user in two workspaces', async () => {
    member('alice', 'org-b', 'member');
    const { integration } = await json<{ integration: View }>(await create('mallory'));
    const path = `/api/integrations/${integration.id}`;
    // alice can see org-b's integration only when org-b is the selected workspace
    expect((await call('GET', `${path}?org=org-a`, { as: 'alice' })).status).toBe(404);
    expect((await call('GET', `${path}?org=org-b`, { as: 'alice' })).status).toBe(200);
    expect((await call('PATCH', `${path}?org=org-a`, { as: 'alice', body: { enabled: false } })).status).toBe(
      404,
    );
    expect((await call('DELETE', `${path}?org=org-a`, { as: 'alice' })).status).toBe(404);
    // with two memberships and no selection, the request is refused rather than guessed
    expect((await call('GET', '/api/integrations', { as: 'alice' })).status).toBe(403);
  });

  it('refuses a declared oversized body before reading it', async () => {
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/integrations`, {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'x-test-user': 'bob',
          'content-type': 'application/json',
          'content-length': String(1024 * 1024),
        },
        body: '{}',
      }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(413);
  });

  it('enforces the per-workspace integration quota', async () => {
    const { MAX_INTEGRATIONS_PER_WORKSPACE } = await import('../../src/api/integrations');
    const insert = db.raw.prepare(
      "INSERT INTO integrations(id,organization_id,repo,event_types,destination,webhook_ciphertext) VALUES(?,'org-a','a/b','[]','slack','')",
    );
    for (let i = 0; i < MAX_INTEGRATIONS_PER_WORKSPACE; i++) insert.run(`q${i}`);
    expect((await create('bob')).status).toBe(409);
  });

  it('rate-limits mutations per user with Retry-After', async () => {
    const { MUTATIONS_PER_MINUTE } = await import('../../src/api/integrations');
    const { integration } = await json<{ integration: View }>(await create('bob'));
    let last: Response | undefined;
    for (let i = 0; i < MUTATIONS_PER_MINUTE; i++) {
      last = await call('PATCH', `/api/integrations/${integration.id}`, {
        as: 'bob',
        body: { enabled: i % 2 === 0 },
      });
    }
    expect(last?.status).toBe(429);
    expect(Number(last?.headers.get('retry-after'))).toBeGreaterThan(0);
    // another user is unaffected
    expect((await create('alice')).status).toBe(201);
  });

  it('collapses repeated probes into one audit row and never stores a long ?org=', async () => {
    await call('GET', '/api/integrations?org=org-a', { as: 'mallory' });
    await call('GET', '/api/integrations?org=org-a', { as: 'mallory' });
    await call('GET', `/api/integrations?org=${'x'.repeat(5000)}`, { as: 'mallory' });
    const rows = db.raw
      .prepare("SELECT organization_id,subject_id FROM audit_events WHERE action='access.denied'")
      .all();
    expect(rows).toEqual([
      { organization_id: 'org-a', subject_id: 'org-a' },
      { organization_id: null, subject_id: '(invalid)' },
    ]);
  });

  it('returns 404 and writes no success audit when the row is deleted concurrently', async () => {
    const { integration } = await json<{ integration: View }>(await create('bob'));
    const realPrepare = db.d1.prepare.bind(db.d1);
    let raced = false;
    env = {
      ...env,
      DB: {
        ...db.d1,
        batch: db.d1.batch.bind(db.d1),
        prepare: (sql: string) => {
          if (!raced && sql.startsWith('UPDATE integrations SET')) {
            raced = true;
            db.raw.prepare('DELETE FROM integrations WHERE id=?').run(integration.id);
          }
          return realPrepare(sql);
        },
      } as D1Database,
    };
    const res = await call('PATCH', `/api/integrations/${integration.id}`, {
      as: 'bob',
      body: { name: 'Renamed' },
    });
    expect(res.status).toBe(404);
    expect(auditActions('org-a')).toEqual(['integration.create']);
  });

  it('refuses moving an integration to another workspace in the database', async () => {
    const { integration } = await json<{ integration: View }>(await create('bob'));
    expect(() =>
      db.raw.prepare("UPDATE integrations SET organization_id='org-b' WHERE id=?").run(integration.id),
    ).toThrow(/cannot change/);
    expect(() =>
      db.raw
        .prepare(
          "INSERT INTO integrations(id,organization_id,repo,event_types,destination,webhook_ciphertext) VALUES('e','','a/b','[]','slack','')",
        )
        .run(),
    ).toThrow(/required/);
  });
});

describe('repository scope (F67)', () => {
  it('stores the canonical repository name from the installation', async () => {
    const { integration } = await json<{ integration: View & { repo: string } }>(
      await create('bob', { repo: 'ACME/web' }),
    );
    expect(integration.repo).toBe('acme/web');
  });

  it('refuses a repository no active installation covers', async () => {
    const res = await create('bob', { repo: 'someone-else/web' });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('Connect GitHub');
  });

  it('honours a selected installation’s repository list', async () => {
    db.raw.exec(
      "UPDATE github_installations SET repository_selection='selected' WHERE organization_id='org-a'",
    );
    db.raw
      .prepare(
        'INSERT INTO github_installation_repositories(installation_row_id,repository_id,full_name) VALUES(?,?,?)',
      )
      .run('gi-1001', '42', 'acme/Allowed');
    expect((await create('bob', { repo: 'acme/web' })).status).toBe(422);
    const ok = await json<{ integration: { repo: string } }>(await create('bob', { repo: 'acme/allowed' }));
    expect(ok.integration.repo).toBe('acme/Allowed');
  });

  it('refuses repositories of a suspended installation', async () => {
    db.raw.exec("UPDATE github_installations SET status='suspended' WHERE organization_id='org-a'");
    expect((await create('bob')).status).toBe(422);
  });
});
