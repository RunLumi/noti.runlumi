import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings, DeliveryMessage } from '../../src/env';
import { sha256Base64url } from '../../src/connectors/sources/github/install';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

/**
 * The GitHub App install flow (ADR 0008) and installation lifecycle (F68), end to end over
 * the real migrations. GitHub's HTTP endpoints are mocked; Better Auth's session lookup is
 * replaced by the `x-test-user` header, as in the integrations API tests.
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
const HMAC_FIXTURE = ['test', 'hook', 'hmac'].join('-');
const CLIENT_FIXTURE = ['test', 'client', 'value'].join('-');
const INSTALLATION = 555;

let db: FakeD1;
let env: Bindings;
let sent: DeliveryMessage[];
let github: {
  installations: unknown[];
  repositories: unknown[];
  exchangeStatus: number;
  membership: { status: number; body: unknown };
  user: { login: string; id: number };
  calls: { method: string; url: string; body?: string }[];
};

function user(id: string): void {
  db.raw
    .prepare('INSERT INTO "user"(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(id, id, `${id}@example.test`, 1, 1, 1);
}

function member(userId: string, org: string): void {
  db.raw
    .prepare('INSERT INTO "member"(id,user_id,organization_id,role,created_at) VALUES(?,?,?,?,?)')
    .run(`${userId}-${org}`, userId, org, 'admin', 1);
}

function makeEnv(over: Partial<Bindings> = {}): Bindings {
  return {
    DB: db.d1,
    APP_ORIGIN: ORIGIN,
    BETTER_AUTH_SECRET: 'test-better-auth-secret-0123456789ab',
    KEK_V1: '11'.repeat(32),
    KEK_V2: '',
    KMS_ACTIVE_VERSION: '1',
    ENVIRONMENT_NAME: 'staging',
    KEK_CHECK_V1: '4464ea2121d3a99ebd188370f1ef6cd0',
    ENCRYPTION_KEY: '',
    GITHUB_APP_ID: '1',
    GITHUB_APP_SLUG: 'lumi-noti',
    GITHUB_CLIENT_ID: 'Iv1.client',
    GITHUB_CLIENT_SECRET: CLIENT_FIXTURE,
    GITHUB_WEBHOOK_SECRET: HMAC_FIXTURE,
    DELIVERY_QUEUE: {
      send: (m: DeliveryMessage) => {
        sent.push(m);
        return Promise.resolve();
      },
    },
    ...over,
  } as unknown as Bindings;
}

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

async function browserGet(path: string, as?: string, language?: string): Promise<Response> {
  const headers = new Headers();
  if (as) headers.set('x-test-user', as);
  if (language) headers.set('accept-language', language);
  return await worker.fetch(new Request(`${ORIGIN}${path}`, { headers, redirect: 'manual' }), env, ctx);
}

async function startInstall(as = 'bob'): Promise<string> {
  const res = await worker.fetch(
    new Request(`${ORIGIN}/api/github/install`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'x-test-user': as },
    }),
    env,
    ctx,
  );
  expect(res.status).toBe(200);
  const { url } = await res.json<{ url: string }>();
  expect(url.startsWith('https://github.com/apps/lumi-noti/installations/new?state=')).toBe(true);
  return new URL(url).searchParams.get('state') ?? '';
}

async function setup(
  state: string,
  installationId: number | string = INSTALLATION,
  as = 'bob',
): Promise<URL> {
  const res = await browserGet(
    `/github/setup?installation_id=${installationId}&setup_action=install&state=${state}`,
    as,
  );
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location') ?? '');
}

async function callback(verifyState: string, as = 'bob'): Promise<URL> {
  const res = await browserGet(`/github/callback?code=the-code&state=${verifyState}`, as);
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location') ?? '');
}

async function connect(installationId: number = INSTALLATION, as = 'bob'): Promise<URL> {
  const authorize = await setup(await startInstall(as), installationId, as);
  if (authorize.searchParams.get('github')) return authorize;
  return callback(authorize.searchParams.get('state') ?? '', as);
}

function installationRow(): Record<string, unknown> | undefined {
  return db.raw
    .prepare('SELECT * FROM github_installations WHERE installation_id=?')
    .get(String(INSTALLATION));
}

function audits(action: string): Record<string, unknown>[] {
  return db.raw.prepare('SELECT * FROM audit_events WHERE action=? ORDER BY rowid').all(action);
}

beforeEach(() => {
  db = createFakeD1();
  seedOrganization(db.raw, 'org-a');
  seedOrganization(db.raw, 'org-b');
  for (const id of ['bob', 'eve']) user(id);
  member('bob', 'org-a');
  member('eve', 'org-b');
  sent = [];
  env = makeEnv();
  github = {
    installations: [
      {
        id: INSTALLATION,
        app_id: 1,
        account: { login: 'acme', type: 'Organization', id: 9001 },
        repository_selection: 'selected',
        suspended_at: null,
      },
    ],
    repositories: [{ id: 7, full_name: 'acme/web' }],
    exchangeStatus: 200,
    membership: { status: 200, body: { state: 'active', role: 'admin' } },
    user: { login: 'bob-gh', id: 4242 },
    calls: [],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      github.calls.push({
        method: init?.method ?? 'GET',
        url: url.toString(),
        ...(init?.body !== undefined && init.body !== null && { body: init.body as string }),
      });
      if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token')
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: 'ghu_fixture', token_type: 'bearer' }), {
            status: github.exchangeStatus,
          }),
        );
      if (url.pathname === '/user/installations')
        return Promise.resolve(new Response(JSON.stringify({ installations: github.installations })));
      if (url.pathname.startsWith('/user/installations/') && url.pathname.endsWith('/repositories'))
        return Promise.resolve(new Response(JSON.stringify({ repositories: github.repositories })));
      if (url.pathname.startsWith('/applications/'))
        return Promise.resolve(new Response(null, { status: 204 }));
      if (url.pathname.startsWith('/user/memberships/orgs/'))
        return Promise.resolve(
          new Response(JSON.stringify(github.membership.body), { status: github.membership.status }),
        );
      if (url.pathname === '/user') return Promise.resolve(new Response(JSON.stringify(github.user)));
      return Promise.resolve(new Response(JSON.stringify({ code: 0 })));
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('install flow', () => {
  it('binds the installation to the installing workspace after verifying access', async () => {
    const done = await connect();
    expect(done.pathname).toBe('/integrations');
    expect(done.searchParams.get('github')).toBe('connected');

    expect(installationRow()).toMatchObject({
      organization_id: 'org-a',
      account_login: 'acme',
      repository_selection: 'selected',
      status: 'active',
      bound_by: 'bob',
    });
    expect(db.raw.prepare('SELECT full_name FROM github_installation_repositories').all()).toEqual([
      { full_name: 'acme/web' },
    ]);
    expect(audits('github.installation.bind')).toHaveLength(1);
  });

  it('uses PKCE and revokes the user token after the check', async () => {
    const authorize = await setup(await startInstall());
    expect(authorize.origin + authorize.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/github/callback`);
    const challenge = authorize.searchParams.get('code_challenge');
    await callback(authorize.searchParams.get('state') ?? '');

    const exchange = github.calls.find((c) => c.url.includes('/login/oauth/access_token'));
    const verifier = new URLSearchParams(String(exchange?.body)).get('code_verifier') ?? '';
    expect(await sha256Base64url(verifier)).toBe(challenge);
    expect(
      github.calls.some((c) => c.method === 'DELETE' && c.url.includes('/applications/Iv1.client/token')),
    ).toBe(true);
  });

  it('never stores a state in a usable form', async () => {
    const state = await startInstall();
    const rows = db.raw.prepare('SELECT state_hash FROM github_auth_states').all() as {
      state_hash: string;
    }[];
    expect(rows.map((r) => r.state_hash)).toEqual([await sha256Base64url(state)]);
  });

  it('refuses a spoofed installation id the user cannot access', async () => {
    const done = await connect(999);
    expect(done.searchParams.get('github')).toBe('installation_not_accessible');
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM github_installations').get()).toEqual({ n: 0 });
    expect(audits('github.installation.bind_refused')).toHaveLength(1);
  });

  it('refuses an organization member who is not an admin', async () => {
    github.membership = { status: 200, body: { state: 'active', role: 'member' } };
    expect((await connect()).searchParams.get('github')).toBe('installation_admin_required');
    expect(installationRow()).toBeUndefined();
    expect(audits('github.installation.bind_refused')).toHaveLength(1);
  });

  it('refuses a pending admin and a user without a visible membership', async () => {
    github.membership = { status: 200, body: { state: 'pending', role: 'admin' } };
    expect((await connect()).searchParams.get('github')).toBe('installation_admin_required');
    github.membership = { status: 404, body: { message: 'Not Found' } };
    expect((await connect()).searchParams.get('github')).toBe('installation_admin_required');
  });

  it('requires the account holder for a personal-account installation', async () => {
    github.installations = [
      { ...(github.installations[0] as object), account: { login: 'bob-gh', type: 'User', id: 4242 } },
    ];
    expect((await connect()).searchParams.get('github')).toBe('connected');
  });

  it('refuses someone else’s personal-account installation', async () => {
    github.installations = [
      { ...(github.installations[0] as object), account: { login: 'bob-gh', type: 'User', id: 7777 } },
    ];
    expect((await connect()).searchParams.get('github')).toBe('installation_admin_required');
  });

  it('refuses a user who loses workspace access mid-flow', async () => {
    const authorize = await setup(await startInstall());
    // Another admin removes bob after he started the flow (the last-admin trigger needs one).
    user('carol');
    member('carol', 'org-a');
    db.raw.exec("DELETE FROM member WHERE user_id='bob'");
    expect((await callback(authorize.searchParams.get('state') ?? '')).searchParams.get('github')).toBe(
      'workspace_access_lost',
    );
    expect(installationRow()).toBeUndefined();
  });

  it('refuses to bind an installation GitHub reported deleted before the bind', async () => {
    db.raw
      .prepare('INSERT INTO github_installation_tombstones(installation_id,app_id) VALUES(?,?)')
      .run(String(INSTALLATION), '1');
    expect((await connect()).searchParams.get('github')).toBe('installation_deleted');
    expect(installationRow()).toBeUndefined();
  });

  it('does not fetch or store repositories for an all-repositories installation', async () => {
    github.installations = [{ ...(github.installations[0] as object), repository_selection: 'all' }];
    expect((await connect()).searchParams.get('github')).toBe('connected');
    expect(github.calls.some((c) => c.url.includes('/repositories'))).toBe(false);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM github_installation_repositories').get()).toEqual({
      n: 0,
    });
  });

  it('refuses rather than truncates an installation with more repositories than it can sync', async () => {
    github.repositories = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, full_name: `acme/r${i}` }));
    expect((await connect()).searchParams.get('github')).toBe('installation_too_large');
    expect(installationRow()).toBeUndefined();
  });

  it('stores a 900-repository installation in chunked statements', async () => {
    const all = Array.from({ length: 900 }, (_, i) => ({ id: i + 1, full_name: `acme/r${i}` }));
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith('/repositories')) {
        const page = Number(url.searchParams.get('page'));
        return Promise.resolve(
          new Response(JSON.stringify({ repositories: all.slice((page - 1) * 100, page * 100) })),
        );
      }
      return base(input, init);
    });
    expect((await connect()).searchParams.get('github')).toBe('connected');
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM github_installation_repositories').get()).toEqual({
      n: 900,
    });
  });

  it('sends the client secret in the form body, never the URL', async () => {
    await connect();
    const exchange = github.calls.find((c) => c.url.includes('/login/oauth/access_token'));
    expect(exchange?.url).toBe('https://github.com/login/oauth/access_token');
    expect(String(exchange?.body)).toContain('client_secret=');
  });

  it('stores no PKCE verifier once the flow completes', async () => {
    await connect();
    expect(
      db.raw.prepare('SELECT COUNT(*) AS n FROM github_auth_states WHERE pkce_verifier IS NOT NULL').get(),
    ).toEqual({ n: 0 });
  });

  it('records the claimed installation id on a refused bind', async () => {
    github.membership = { status: 200, body: { state: 'active', role: 'member' } };
    await connect();
    const row = audits('github.installation.bind_refused')[0];
    expect(JSON.parse(String(row?.metadata_json))).toEqual({
      reason: 'installation_admin_required',
      claimedInstallationId: String(INSTALLATION),
    });
  });

  it('lands on the dashboard, not a blank error, when something unexpected fails', async () => {
    const authorize = await setup(await startInstall());
    vi.stubGlobal('fetch', () => Promise.reject(new Error('boom')));
    env = makeEnv({
      DB: { ...db.d1, batch: () => Promise.reject(new Error('d1 down')) } as unknown as D1Database,
    });
    const done = await callback(authorize.searchParams.get('state') ?? '');
    expect(done.pathname).toBe('/integrations');
  });

  it('refuses an installation of a different App with the same id', async () => {
    github.installations = [{ ...(github.installations[0] as object), app_id: 2 }];
    expect((await connect()).searchParams.get('github')).toBe('installation_not_accessible');
  });

  it('never rebinds an installation that belongs to another workspace', async () => {
    expect((await connect(INSTALLATION, 'eve')).searchParams.get('github')).toBe('connected');
    expect((await connect(INSTALLATION, 'bob')).searchParams.get('github')).toBe(
      'installation_bound_elsewhere',
    );
    expect(installationRow()?.organization_id).toBe('org-b');
    expect(() => db.raw.exec("UPDATE github_installations SET organization_id='org-a'")).toThrow(
      /cannot change/,
    );
  });

  it('makes each state single-use', async () => {
    const state = await startInstall();
    await setup(state);
    expect((await setup(state)).searchParams.get('github')).toBe('state_invalid');
  });

  it('refuses a state presented by a different user', async () => {
    const state = await startInstall('bob');
    expect((await setup(state, INSTALLATION, 'eve')).searchParams.get('github')).toBe('state_user_mismatch');
  });

  it('refuses an expired state', async () => {
    const state = await startInstall();
    db.raw.exec('UPDATE github_auth_states SET expires_at=0');
    expect((await setup(state)).searchParams.get('github')).toBe('state_invalid');
  });

  it('refuses a verify state at the setup step and vice versa', async () => {
    const authorize = await setup(await startInstall());
    const verifyState = authorize.searchParams.get('state') ?? '';
    expect((await setup(verifyState)).searchParams.get('github')).toBe('state_invalid');
  });

  it('rejects malformed installation ids before any GitHub call', async () => {
    expect((await setup(await startInstall(), '12abc')).searchParams.get('github')).toBe(
      'installation_id_invalid',
    );
    expect(github.calls).toHaveLength(0);
  });

  it('reports a failed code exchange without binding', async () => {
    github.exchangeStatus = 401;
    expect((await connect()).searchParams.get('github')).toBe('oauth_failed');
    expect(installationRow()).toBeUndefined();
  });

  it('requires a session at every browser step', async () => {
    const res = await browserGet('/github/setup?installation_id=1&state=x');
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('github')).toBe('signin_required');
  });

  it('fails closed while the App is not configured', async () => {
    env = makeEnv({ GITHUB_CLIENT_ID: 'REPLACE_WITH_GITHUB_CLIENT_ID' });
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/github/install`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'x-test-user': 'bob' },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(503);
  });

  it('refuses to start an install without our Origin', async () => {
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/github/install`, { method: 'POST', headers: { 'x-test-user': 'bob' } }),
      env,
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it('lists the workspace’s installations and repositories', async () => {
    await connect();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/github/installations`, { headers: { 'x-test-user': 'bob' } }),
      env,
      ctx,
    );
    expect(await res.json()).toMatchObject({
      configured: true,
      installations: [
        { account: 'acme', repositorySelection: 'selected', status: 'active', repositories: ['acme/web'] },
      ],
    });
    const other = await worker.fetch(
      new Request(`${ORIGIN}/api/github/installations`, { headers: { 'x-test-user': 'eve' } }),
      env,
      ctx,
    );
    expect(await other.json()).toMatchObject({ installations: [] });
  });
});

// ---------------------------------------------------------------------------
// Lifecycle and repository scope at ingress
// ---------------------------------------------------------------------------

async function signedWebhook(kind: string, event: Record<string, unknown>, id = crypto.randomUUID()) {
  const body = JSON.stringify(event);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(HMAC_FIXTURE),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return worker.fetch(
    new Request(`${ORIGIN}/webhooks/github`, {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-github-event': kind,
        'x-github-delivery': id,
        'x-hub-signature-256': 'sha256=' + Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join(''),
      },
    }),
    env,
    ctx,
  );
}

const installationBlock = { id: INSTALLATION, app_id: 1, repository_selection: 'selected' };

function issue(repoId: number, fullName: string) {
  return {
    action: 'opened',
    installation: installationBlock,
    repository: { id: repoId, full_name: fullName, html_url: `https://github.com/${fullName}` },
    issue: { title: 'Bug', html_url: `https://github.com/${fullName}/issues/1` },
  };
}

describe('lifecycle and repository scope', () => {
  beforeEach(async () => {
    await connect();
    db.raw
      .prepare(
        `INSERT INTO integrations(id,organization_id,repo,event_types,destination,webhook_ciphertext)
         VALUES('int-1','org-a','acme/web','["issues.opened"]','slack','')`,
      )
      .run();
  });

  it('routes an event for an in-scope repository', async () => {
    expect((await signedWebhook('issues', issue(7, 'acme/web'))).status).toBe(202);
    expect(sent).toHaveLength(1);
  });

  it('refuses and audits an event for a repository outside a selected installation', async () => {
    expect((await signedWebhook('issues', issue(8, 'acme/secret'))).status).toBe(403);
    expect(audits('github.repository.out_of_scope')).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it('stops delivery the moment an installation is suspended, and resumes on unsuspend', async () => {
    await signedWebhook('installation', { action: 'suspend', installation: installationBlock });
    expect(installationRow()).toMatchObject({ status: 'suspended' });
    expect(installationRow()?.suspended_at).not.toBeNull();
    expect((await signedWebhook('issues', issue(7, 'acme/web'))).status).toBe(403);

    await signedWebhook('installation', { action: 'unsuspend', installation: installationBlock });
    expect(installationRow()).toMatchObject({ status: 'active', suspended_at: null });
    expect((await signedWebhook('issues', issue(7, 'acme/web'))).status).toBe(202);
  });

  it('marks a deleted installation uninstalled and audits it', async () => {
    await signedWebhook('installation', { action: 'deleted', installation: installationBlock });
    expect(installationRow()?.status).toBe('uninstalled');
    expect((await signedWebhook('issues', issue(7, 'acme/web'))).status).toBe(403);
    const rows = audits('github.installation.lifecycle');
    expect(JSON.parse(String(rows.at(-1)?.metadata_json))).toEqual({ action: 'deleted' });
  });

  it('applies repository additions and removals immediately', async () => {
    await signedWebhook('installation_repositories', {
      action: 'added',
      installation: installationBlock,
      repository_selection: 'selected',
      repositories_added: [{ id: 8, full_name: 'acme/secret' }],
      repositories_removed: [],
    });
    db.raw.exec(`UPDATE integrations SET repo='acme/secret'`);
    expect((await signedWebhook('issues', issue(8, 'acme/secret'))).status).toBe(202);

    await signedWebhook('installation_repositories', {
      action: 'removed',
      installation: installationBlock,
      repository_selection: 'selected',
      repositories_added: [],
      repositories_removed: [{ id: 8, full_name: 'acme/secret' }],
    });
    expect((await signedWebhook('issues', issue(8, 'acme/secret'))).status).toBe(403);
  });

  it('ignores lifecycle events for unbound installations or other Apps', async () => {
    const unbound = await signedWebhook('installation', {
      action: 'created',
      installation: { id: 999, app_id: 1 },
    });
    expect(await unbound.json()).toEqual({ accepted: true, lifecycle: 'ignored' });
    const foreign = await signedWebhook('installation', {
      action: 'deleted',
      installation: { id: INSTALLATION, app_id: 2 },
    });
    expect(await foreign.json()).toEqual({ accepted: true, lifecycle: 'ignored' });
    expect(installationRow()?.status).toBe('active');
  });

  it('acknowledges a signed ping without routing anything', async () => {
    const res = await signedWebhook('ping', { zen: 'Keep it logically awesome.', hook_id: 1 });
    expect(res.status).toBe(202);
    expect(sent).toHaveLength(0);
  });

  it('never revives an uninstalled installation from a late or replayed event', async () => {
    await signedWebhook('installation', { action: 'deleted', installation: installationBlock });
    await signedWebhook('installation', { action: 'unsuspend', installation: installationBlock });
    await signedWebhook('installation', { action: 'created', installation: installationBlock });
    expect(installationRow()?.status).toBe('uninstalled');
  });

  it('ignores an unsuspend for an installation that was never suspended', async () => {
    await signedWebhook('installation', { action: 'unsuspend', installation: installationBlock });
    expect(installationRow()).toMatchObject({ status: 'active', suspended_at: null });
  });

  it('tombstones a deletion that arrives before anyone bound the installation', async () => {
    await signedWebhook('installation', { action: 'deleted', installation: { id: 999, app_id: 1 } });
    expect(db.raw.prepare('SELECT installation_id FROM github_installation_tombstones').all()).toEqual([
      { installation_id: '999' },
    ]);
  });

  it('fails closed and flags a resync when the selection switches from all to selected', async () => {
    db.raw.exec("UPDATE github_installations SET repository_selection='all'");
    await signedWebhook('installation_repositories', {
      action: 'removed',
      installation: installationBlock,
      repository_selection: 'selected',
      repositories_added: [],
      repositories_removed: [{ id: 99, full_name: 'acme/other' }],
    });
    expect(installationRow()).toMatchObject({ repository_selection: 'selected', repositories_complete: 0 });
    // acme/web (id 7) is still in the stored set from the bind; anything else is refused
    // until a reconnect resyncs the full set.
    expect((await signedWebhook('issues', issue(7, 'acme/web'))).status).toBe(202);
    expect((await signedWebhook('issues', issue(123, 'acme/new'))).status).toBe(403);
  });

  it('follows an account rename', async () => {
    await signedWebhook('installation_target', {
      action: 'renamed',
      installation: installationBlock,
      account: { login: 'acme-corp', id: 9001 },
    });
    expect(installationRow()?.account_login).toBe('acme-corp');
  });

  it('ignores a rename that names a different account id', async () => {
    await signedWebhook('installation_target', {
      action: 'renamed',
      installation: installationBlock,
      account: { login: 'evil', id: 1 },
    });
    expect(installationRow()?.account_login).toBe('acme');
  });

  it('returns a retryable 500 when a lifecycle update cannot be stored', async () => {
    env = makeEnv({
      DB: {
        ...db.d1,
        prepare: db.d1.prepare.bind(db.d1),
        batch: () => Promise.reject(new Error('down')),
      } as unknown as D1Database,
    });
    expect(
      (await signedWebhook('installation', { action: 'suspend', installation: installationBlock })).status,
    ).toBe(500);
  });

  it('never accepts an unsigned lifecycle event', async () => {
    const res = await worker.fetch(
      new Request(`${ORIGIN}/webhooks/github`, {
        method: 'POST',
        body: JSON.stringify({ action: 'deleted', installation: installationBlock }),
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'installation',
          'x-github-delivery': 'x',
          'x-hub-signature-256': 'sha256=00',
        },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
    expect(installationRow()?.status).toBe('active');
  });
});

async function beginConnect(as = 'bob'): Promise<string> {
  const response = await worker.fetch(
    new Request(`${ORIGIN}/api/github/install`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-test-user': as },
      body: JSON.stringify({ mode: 'connect' }),
    }),
    env,
    ctx,
  );
  expect(response.status).toBe(200);
  const body = await response.json<{ url: string }>();
  const url = new URL(body.url);
  expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
  return url.searchParams.get('state') ?? '';
}
async function discovery(as = 'bob', language?: string): Promise<Response> {
  return browserGet(`/github/callback?code=fixture-code&state=${await beginConnect(as)}`, as, language);
}
async function choose(state: string, as = 'bob', origin = ORIGIN): Promise<Response> {
  return worker.fetch(
    new Request(`${ORIGIN}/github/choose`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded', 'x-test-user': as },
      body: new URLSearchParams({ state }),
    }),
    env,
    ctx,
  );
}
async function choices(language?: string) {
  github.installations.push({
    ...(github.installations[0] as object),
    id: 556,
    account: { login: 'beta', type: 'Organization', id: 9002 },
  });
  const response = await discovery('bob', language);
  expect(response.status).toBe(200);
  const body = await response.text();
  const tickets = [...body.matchAll(/name="state" value="([^"]+)"/g)].map((m) => m[1] ?? '');
  expect(tickets).toHaveLength(2);
  return { response, body, tickets };
}

describe('real-runtime transport regressions', () => {
  it('uses manual redirect mode for every GitHub request and never the unsupported error mode', async () => {
    const base = globalThis.fetch;
    const modes: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.redirect === 'error') throw new TypeError('Invalid redirect value');
      modes.push(String(init?.redirect));
      expect(new Headers(init?.headers).get('user-agent')).toBe('lumi-noti');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return base(input, init);
    });
    expect((await connect()).searchParams.get('github')).toBe('connected');
    expect(modes.length).toBeGreaterThan(3);
    expect(new Set(modes)).toEqual(new Set(['manual']));
  });
  it.each([
    '/login/oauth/access_token',
    '/user/installations',
    '/user/memberships/orgs/acme',
    '/user/installations/555/repositories',
  ])('refuses provider redirects at %s without following credentials', async (path) => {
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === path)
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: 'https://untrusted.test/credentials' } }),
        );
      return base(input, init);
    });
    expect((await connect()).searchParams.get('github')).toBe('github_unavailable');
    expect(installationRow()).toBeUndefined();
    expect(github.calls.some((call) => call.url.includes('untrusted.test'))).toBe(false);
  });
  it.each([429, 500, 503])('does not bind or retry a code exchange after HTTP %s', async (status) => {
    github.exchangeStatus = status;
    expect((await connect()).searchParams.get('github')).toBe('github_unavailable');
    expect(installationRow()).toBeUndefined();
    expect(github.calls.filter((c) => c.url.includes('/login/oauth/access_token'))).toHaveLength(1);
  });
  it.each(['not JSON', 'x'.repeat(17000)])(
    'refuses invalid or oversized OAuth responses without echoing them',
    async (body) => {
      const base = globalThis.fetch;
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
        (input instanceof Request ? input.url : String(input)).includes('/login/oauth/access_token')
          ? Promise.resolve(new Response(body))
          : base(input, init),
      );
      expect((await connect()).searchParams.get('github')).toBe('github_unavailable');
      expect(installationRow()).toBeUndefined();
      expect(JSON.stringify(warning.mock.calls)).not.toContain(body);
      warning.mockRestore();
    },
  );
  it('clears PKCE and does not bind on a fetch timeout, recording only a bounded stage/reason', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', () => Promise.reject(new DOMException('secret-provider-details', 'TimeoutError')));
    expect((await connect()).searchParams.get('github')).toBe('github_unavailable');
    expect(installationRow()).toBeUndefined();
    expect(
      db.raw.prepare('SELECT COUNT(*) AS n FROM github_auth_states WHERE pkce_verifier IS NOT NULL').get(),
    ).toEqual({ n: 0 });
    const logged = JSON.stringify(warning.mock.calls);
    expect(logged).toContain('oauth_exchange');
    expect(logged).not.toContain('secret-provider-details');
    expect(logged).not.toContain(CLIENT_FIXTURE);
    warning.mockRestore();
  });
  it('does not connect a silently truncated or malformed selected-repository response', async () => {
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      (input instanceof Request ? input.url : String(input)).includes('/repositories?')
        ? Promise.resolve(Response.json({ repositories: [{ id: 'wrong', full_name: 'acme/web' }] }))
        : base(input, init),
    );
    expect((await connect()).searchParams.get('github')).toBe('github_unavailable');
    expect(installationRow()).toBeUndefined();
    expect(github.calls.some((c) => c.method === 'DELETE')).toBe(true);
  });
});

describe('OAuth-first install discovery and reconnect', () => {
  it('binds an existing installation without sending the user to GitHub configuration', async () => {
    const response = await discovery();
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('github')).toBe('connected');
    expect(installationRow()).toMatchObject({ organization_id: 'org-a', account_login: 'acme' });
  });
  it('sends a first-time installer through the original single-use installation flow and revokes the discovery token', async () => {
    github.installations = [];
    const response = await discovery();
    const next = new URL(response.headers.get('location') ?? '');
    expect(next.origin + next.pathname).toBe('https://github.com/apps/lumi-noti/installations/new');
    expect(next.searchParams.get('state')).toBeTruthy();
    expect(installationRow()).toBeUndefined();
    expect(github.calls.some((c) => c.method === 'DELETE')).toBe(true);
  });
  it('does not silently choose between several installations or retain an access token', async () => {
    const { response, body } = await choices();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("form-action 'self'");
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(body).toContain('Connect acme');
    expect(body).toContain('Connect beta');
    expect(body).not.toContain('ghu_fixture');
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM github_installations').get()).toEqual({ n: 0 });
    expect(github.calls.some((c) => c.method === 'DELETE')).toBe(true);
  });
  it('reverifies the chosen account through fresh PKCE before binding and refuses a replayed choice', async () => {
    const { tickets } = await choices();
    const ticket = tickets[1] ?? '';
    const selected = await choose(ticket);
    const authorize = new URL(selected.headers.get('location') ?? '');
    expect(authorize.hostname).toBe('github.com');
    expect(authorize.searchParams.get('code_challenge')).toBeTruthy();
    const replay = await choose(ticket);
    expect(new URL(replay.headers.get('location') ?? '').searchParams.get('github')).toBe('state_invalid');
    expect((await callback(authorize.searchParams.get('state') ?? '')).searchParams.get('github')).toBe(
      'connected',
    );
    expect(
      db.raw.prepare("SELECT account_login FROM github_installations WHERE installation_id='556'").get(),
    ).toEqual({ account_login: 'beta' });
  });
  it('refuses a choice from another user and a choice after loss of workspace authority', async () => {
    const { tickets } = await choices();
    const wrong = await choose(tickets[0] ?? '', 'eve');
    expect(new URL(wrong.headers.get('location') ?? '').searchParams.get('github')).toBe(
      'state_user_mismatch',
    );
    user('backup-admin');
    member('backup-admin', 'org-a');
    db.raw.exec("DELETE FROM member WHERE user_id='bob' AND organization_id='org-a'");
    const lost = await choose(tickets[1] ?? '');
    expect(new URL(lost.headers.get('location') ?? '').searchParams.get('github')).toBe(
      'workspace_access_lost',
    );
    expect(installationRow()).toBeUndefined();
  });
  it('requires same-origin form submission without consuming a valid choice on a foreign-origin request', async () => {
    const { tickets } = await choices();
    expect((await choose(tickets[0] ?? '', 'bob', 'https://foreign.test')).status).toBe(403);
    expect((await choose(tickets[0] ?? '')).status).toBe(302);
  });
  it('does not allow a choice ticket to stand in for an OAuth verify state', async () => {
    const { tickets } = await choices();
    expect((await callback(tickets[0] ?? '')).searchParams.get('github')).toBe('oauth_failed');
    expect(installationRow()).toBeUndefined();
  });
  it('bounds account discovery instead of returning a truncated choice list', async () => {
    github.installations = Array.from({ length: 21 }, (_, i) => ({
      ...(github.installations[0] as object),
      id: i + 1,
      account: { login: `account-${i}`, type: 'Organization', id: i + 100 },
    }));
    const response = await discovery();
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('github')).toBe(
      'installation_list_too_large',
    );
    expect(installationRow()).toBeUndefined();
  });
  it('escapes account names on the script-free choice page', async () => {
    github.installations[0] = {
      ...(github.installations[0] as object),
      account: { id: 9001, type: 'Organization', login: '<script>alert(1)</script>' },
    };
    const { body } = await choices();
    expect(body).not.toContain('<script>');
    expect(body).toContain('&lt;script&gt;');
  });
});

describe('pagination boundaries and choice input rejection', () => {
  it.each([1000, 1001])('handles exactly %s selected repositories without truncation', async (count) => {
    const all = Array.from({ length: count }, (_, i) => ({ id: i + 1, full_name: `acme/r${i}` }));
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith('/repositories')) {
        const size = Number(url.searchParams.get('per_page'));
        const page = Number(url.searchParams.get('page'));
        return Promise.resolve(Response.json({ repositories: all.slice((page - 1) * size, page * size) }));
      }
      return base(input, init);
    });
    expect((await connect()).searchParams.get('github')).toBe(
      count === 1000 ? 'connected' : 'installation_too_large',
    );
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM github_installation_repositories').get()).toEqual({
      n: count === 1000 ? 1000 : 0,
    });
  });
  it('does not accept an OAuth state as an account-choice ticket', async () => {
    const state = await beginConnect();
    const response = await choose(state);
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('github')).toBe('state_invalid');
    expect(installationRow()).toBeUndefined();
  });
  it('refuses expired choices and duplicate state form fields', async () => {
    const { tickets } = await choices();
    db.raw.exec('UPDATE github_auth_states SET expires_at=0');
    expect(
      new URL((await choose(tickets[0] ?? '')).headers.get('location') ?? '').searchParams.get('github'),
    ).toBe('state_invalid');
    const duplicate = await worker.fetch(
      new Request(`${ORIGIN}/github/choose`, {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/x-www-form-urlencoded',
          'x-test-user': 'bob',
        },
        body: new URLSearchParams([
          ['state', 'a'],
          ['state', 'b'],
        ]),
      }),
      env,
      ctx,
    );
    expect(new URL(duplicate.headers.get('location') ?? '').searchParams.get('github')).toBe('state_invalid');
  });
  it('refuses an unsupported connect mode or oversized start request before creating any states', async () => {
    for (const body of [JSON.stringify({ mode: 'unknown' }), 'x'.repeat(1025)]) {
      const response = await worker.fetch(
        new Request(`${ORIGIN}/api/github/install`, {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-test-user': 'bob' },
          body,
        }),
        env,
        ctx,
      );
      expect([400, 413]).toContain(response.status);
    }
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM github_auth_states').get()).toEqual({ n: 0 });
  });
  it('serves only a static stylesheet for the choice page', async () => {
    const response = await browserGet('/github/connect.css');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/css');
    expect(await response.text()).not.toContain('state=');
  });
});

describe('authority changes while GitHub requests are in flight', () => {
  it('rechecks workspace authority after token revocation and before binding', async () => {
    user('second-admin');
    member('second-admin', 'org-a');
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') db.raw.exec("DELETE FROM member WHERE user_id='bob'");
      return base(input, init);
    });
    expect((await connect()).searchParams.get('github')).toBe('workspace_access_lost');
    expect(installationRow()).toBeUndefined();
  });
});

it('renders the account-choice handoff in Vietnamese when the browser requests it', async () => {
  const { body } = await choices('vi-VN,vi;q=0.9');
  expect(body).toContain('lang="vi"');
  expect(body).toContain('Chọn tài khoản GitHub cần kết nối');
  expect(body).toContain('Nhiều tài khoản đã cài Lumi Noti');
});
