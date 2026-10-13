import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromBase64 } from '../../src/connectors/sources/generic/encoding';
import { verifyStandardWebhook } from '../../src/connectors/sources/generic/signature';
import type { Bindings, DeliveryMessage } from '../../src/env';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

/**
 * Discord and the signed customer webhook through the integrations API, over the real
 * migrations (see tests/api/integrations.test.ts for the harness this mirrors). `fetch` is
 * stubbed: it answers the DNS-over-HTTPS save-time lookups and the delivery itself.
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
const DISCORD = 'https://discord.com/api/webhooks/123456789012345678/DiscordApiTestToken';
const HOOK = 'https://hooks.example.com/noti/inbound?channel=ci';
let db: FakeD1;
let env: Bindings;
let fetchMock: ReturnType<typeof vi.fn>;
/** Hostname -> addresses the stubbed DNS-over-HTTPS endpoint returns (A records). */
let dns: Record<string, string[] | 'servfail' | 'nxdomain'>;

function setUp(): void {
  db = createFakeD1();
  seedOrganization(db.raw, 'org-a');
  db.raw
    .prepare('INSERT INTO "user"(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run('bob', 'bob', 'bob@example.test', 1, 1, 1);
  db.raw
    .prepare('INSERT INTO "member"(id,user_id,organization_id,role,created_at) VALUES(?,?,?,?,?)')
    .run('bob-org-a', 'bob', 'org-a', 'member', 1);
  db.raw
    .prepare(
      `INSERT INTO github_installations(id,organization_id,installation_id,app_id,account_login,account_type,repository_selection)
       VALUES('gi-1','org-a','1001','1','acme','Organization','all')`,
    )
    .run();
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
    GENERIC_WEBHOOK_ENABLED: 'true',
  } as unknown as Bindings;
}

beforeEach(() => {
  setUp();
  dns = { 'hooks.example.com': ['93.184.216.34'] };
  fetchMock = vi.fn((input: string) => {
    const url = new URL(String(input));
    if (url.origin === 'https://cloudflare-dns.com') {
      const answer = dns[url.searchParams.get('name') ?? ''];
      if (answer === 'servfail') return Promise.resolve(new Response('{"Status":2}'));
      if (answer === 'nxdomain' || answer === undefined) return Promise.resolve(new Response('{"Status":3}'));
      const isA = url.searchParams.get('type') === 'A';
      return Promise.resolve(
        new Response(
          JSON.stringify({
            Status: 0,
            ...(isA ? { Answer: answer.map((data) => ({ name: 'x', type: 1, TTL: 60, data })) } : {}),
          }),
        ),
      );
    }
    return Promise.resolve(new Response('{"received":true}', { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: new Headers({ 'content-type': 'application/json', 'x-test-user': 'bob', origin: ORIGIN }),
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
  );
}

const create = (body: Record<string, unknown>) =>
  call('POST', '/api/integrations', {
    name: 'Alerts',
    repo: 'acme/web',
    eventTypes: ['issues.opened'],
    ...body,
  });

type Created = {
  integration: { id: string; destination: string; destinationHost: string };
  signingSecret?: string;
};
type Failed = { error: string; fields: { field: string; message: string }[] };

describe('Discord integrations', () => {
  it('creates a Discord integration, never returns the URL, and stores it sealed', async () => {
    const res = await create({ destination: 'discord', webhookUrl: DISCORD });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain('DiscordApiTestToken');
    const body = JSON.parse(text) as Created;
    expect(body.integration).toMatchObject({ destination: 'discord', destinationHost: 'discord.com' });
    expect(body).not.toHaveProperty('signingSecret');
    const row = db.raw.prepare('SELECT * FROM integrations WHERE id=?').get(body.integration.id) as Record<
      string,
      unknown
    >;
    expect(row.webhook_ciphertext).toBe('');
    expect(JSON.stringify(Object.values(row).map(String))).not.toContain('DiscordApiTestToken');
    // No DNS lookup is needed: Discord is pinned to a documented host.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['https://discordapp.com/api/webhooks/123456789012345678/DiscordApiTestToken'],
    ['https://hooks.slack.com/services/T000/B000/Token'],
    ['https://discord.com/api/webhooks/123456789012345678/DiscordApiTestToken?username=evil'],
    ['http://discord.com/api/webhooks/123456789012345678/DiscordApiTestToken'],
  ])('refuses %s with a field error that does not echo it', async (webhookUrl) => {
    const res = await create({ destination: 'discord', webhookUrl });
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).not.toContain('DiscordApiTestToken');
    expect((JSON.parse(text) as Failed).fields[0]).toMatchObject({ field: 'webhookUrl' });
    expect(text).toContain('discord.com/api/webhooks');
  });

  it('refuses a signing secret, which Discord does not use', async () => {
    const res = await create({ destination: 'discord', webhookUrl: DISCORD, signingSecret: 'abc' });
    expect(res.status).toBe(422);
    expect((await res.json<Failed>()).fields[0]).toMatchObject({ field: 'signingSecret' });
  });

  it('rotates the webhook URL like any other destination', async () => {
    const { integration } = await (
      await create({ destination: 'discord', webhookUrl: DISCORD })
    ).json<Created>();
    const res = await call('PATCH', `/api/integrations/${integration.id}`, {
      webhookUrl: 'https://discord.com/api/webhooks/223456789012345678/AnotherApiTestToken',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('AnotherApiTestToken');
  });
});

describe('custom webhook integrations', () => {
  it('creates one, generates the signing secret, and shows it exactly once', async () => {
    const res = await create({ destination: 'generic_webhook', webhookUrl: HOOK });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).not.toContain('channel=ci');
    const body = JSON.parse(text) as Created;
    expect(body.signingSecret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(body.integration).toMatchObject({
      destination: 'generic_webhook',
      destinationHost: 'hooks.example.com',
    });

    // Never readable again: not by id, not in the list, not in the row.
    for (const path of [`/api/integrations/${body.integration.id}`, '/api/integrations']) {
      const read = await (await call('GET', path)).text();
      expect(read).not.toContain(body.signingSecret ?? 'unreachable');
      expect(read).not.toContain('signingSecret');
    }
    const row = db.raw.prepare('SELECT * FROM integrations WHERE id=?').get(body.integration.id) as Record<
      string,
      unknown
    >;
    expect(row.lark_secret_ciphertext).toBeNull();
    expect(row.lark_secret_envelope).not.toBeNull();
    expect(JSON.stringify(Object.values(row).map(String))).not.toContain(body.signingSecret ?? 'unreachable');
    const audit = db.raw.prepare('SELECT metadata_json FROM audit_events').all() as {
      metadata_json: string;
    }[];
    expect(JSON.stringify(audit)).not.toContain('whsec_');
    expect(JSON.stringify(audit)).not.toContain('channel=ci');
    expect(JSON.parse(audit[0]?.metadata_json ?? '{}')).toMatchObject({
      destination: 'generic_webhook',
      destinationHost: 'hooks.example.com',
      signed: true,
    });
  });

  it('verifies the hostname through DNS and refuses one that resolves to a private address', async () => {
    dns['evil.example.com'] = ['169.254.169.254'];
    const res = await create({
      destination: 'generic_webhook',
      webhookUrl: 'https://evil.example.com/x?t=MARKER',
    });
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).not.toContain('MARKER');
    expect(text).not.toContain('169.254');
    expect(JSON.parse(text)).toMatchObject({ fields: [{ field: 'webhookUrl' }] });
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM integrations').get()).toEqual({ n: 0 });
  });

  it.each([
    ['https://10.0.0.5/x', 'IP address'],
    ['https://[::1]/x', 'IP address'],
    ['https://2130706433/x', 'IP address'],
    ['https://localhost/x', 'internal'],
    ['https://db.internal/x', 'internal'],
    ['https://hooks.example.com:8443/x', 'port'],
    ['http://hooks.example.com/x', 'https'],
    ['https://user:pw@hooks.example.com/x', 'username'],
  ])('refuses %s at write time, before any DNS lookup', async (webhookUrl, hint) => {
    const res = await create({ destination: 'generic_webhook', webhookUrl });
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text.toLowerCase()).toContain(hint.toLowerCase());
    expect(text).not.toContain('pw@');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when the hostname cannot be verified, and says why', async () => {
    dns['hooks.example.com'] = 'servfail';
    const res = await create({ destination: 'generic_webhook', webhookUrl: HOOK });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('could not verify');
    dns['hooks.example.com'] = 'nxdomain';
    expect(await (await create({ destination: 'generic_webhook', webhookUrl: HOOK })).text()).toContain(
      'does not resolve',
    );
  });

  it('does not let the caller choose the signing secret', async () => {
    const res = await create({ destination: 'generic_webhook', webhookUrl: HOOK, signingSecret: 'whsec_x' });
    expect(res.status).toBe(422);
    expect((await res.json<Failed>()).fields[0]).toMatchObject({ field: 'signingSecret' });
  });

  it('rotating the credentials re-verifies the host and issues a new secret, once', async () => {
    const first = await (await create({ destination: 'generic_webhook', webhookUrl: HOOK })).json<Created>();
    dns['new.example.com'] = ['10.1.2.3'];
    const blocked = await call('PATCH', `/api/integrations/${first.integration.id}`, {
      webhookUrl: 'https://new.example.com/x',
    });
    expect(blocked.status).toBe(422);

    dns['new.example.com'] = ['93.184.216.34'];
    const res = await call('PATCH', `/api/integrations/${first.integration.id}`, {
      webhookUrl: 'https://new.example.com/x',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const rotated = await res.json<Created>();
    expect(rotated.signingSecret).toMatch(/^whsec_/);
    expect(rotated.signingSecret).not.toBe(first.signingSecret);
    // An update that does not touch credentials returns no secret.
    const renamed = await call('PATCH', `/api/integrations/${first.integration.id}`, { name: 'Renamed' });
    expect(await renamed.text()).not.toContain('whsec_');
  });

  it('the created integration delivers a request the customer can verify with the secret we showed', async () => {
    const created = await (
      await create({ destination: 'generic_webhook', webhookUrl: HOOK })
    ).json<Created>();
    const { consumeDeliveries } = await import('../../src/pipeline/consumer');
    db.raw
      .prepare(
        "INSERT INTO deliveries(id,integration_id,organization_id,state) VALUES('delivery-9',?,'org-a','pending')",
      )
      .run(created.integration.id);
    fetchMock.mockClear();
    const msg = {
      body: {
        id: 'delivery-9',
        integrationId: created.integration.id,
        organizationId: 'org-a',
        title: 'Deploy finished',
        url: '',
      },
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await consumeDeliveries({ messages: [msg], retryAll: vi.fn() } as unknown as MessageBatch<unknown>, env);
    expect(msg.ack).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe(HOOK);
    const key = fromBase64((created.signingSecret ?? '').slice('whsec_'.length));
    if (!key) throw new Error('key');
    const verdict = await verifyStandardWebhook(
      key,
      {
        id: init.headers['webhook-id'] ?? null,
        timestamp: init.headers['webhook-timestamp'] ?? null,
        signature: init.headers['webhook-signature'] ?? null,
      },
      new TextEncoder().encode(init.body),
      Math.floor(Date.now() / 1000),
    );
    expect(verdict).toEqual({ ok: true });
    expect(db.raw.prepare("SELECT state FROM deliveries WHERE id='delivery-9'").get()).toEqual({
      state: 'sent',
    });
  });

  it('is also available for an integration that routes from a generic source', async () => {
    db.raw
      .prepare(
        `INSERT INTO sources(id,organization_id,kind,name,endpoint_id,secret_envelope,key_salt,dek_wrapped,kek_version)
         VALUES('src-aaaaaaaa','org-a','generic','Deploys','ep-aaaaaaaaaaaaaaaaaaaaaaaa',x'00',x'00',x'00',1)`,
      )
      .run();
    const res = await call('POST', '/api/integrations', {
      name: 'Deploys to hook',
      sourceId: 'src-aaaaaaaa',
      destination: 'generic_webhook',
      webhookUrl: HOOK,
    });
    expect(res.status).toBe(201);
    expect((await res.json<Created>()).signingSecret).toMatch(/^whsec_/);
  });
});

/** Set (or unset) the deployment flag on the env the Worker runs with. */
function setFlag(value: string | undefined): void {
  const { GENERIC_WEBHOOK_ENABLED: _previous, ...rest } = env;
  env = value === undefined ? rest : { ...rest, GENERIC_WEBHOOK_ENABLED: value };
}

async function deliver(integrationId: string, deliveryId: string): Promise<void> {
  const { consumeDeliveries } = await import('../../src/pipeline/consumer');
  db.raw
    .prepare("INSERT INTO deliveries(id,integration_id,organization_id,state) VALUES(?,?,'org-a','pending')")
    .run(deliveryId, integrationId);
  const msg = {
    body: { id: deliveryId, integrationId, organizationId: 'org-a', title: 't', url: '' },
    ack: vi.fn(),
    retry: vi.fn(),
  };
  await consumeDeliveries({ messages: [msg], retryAll: vi.fn() } as unknown as MessageBatch<unknown>, env);
}

const enabledOf = (id: string): number =>
  (db.raw.prepare('SELECT enabled FROM integrations WHERE id=?').get(id) as { enabled: number }).enabled;

describe('Discord auto-pause on a sealed credential', () => {
  const gone = () => Promise.resolve(new Response('{"code":10015}', { status: 404 }));

  it('pauses the integration, with its audit row, when the sealed webhook it used is gone', async () => {
    const { integration } = await (
      await create({ destination: 'discord', webhookUrl: DISCORD })
    ).json<Created>();
    fetchMock.mockImplementationOnce(gone);
    await deliver(integration.id, 'd1');
    expect(enabledOf(integration.id)).toBe(0);
    expect(
      db.raw.prepare("SELECT actor_id FROM audit_events WHERE action='integration.auto_pause'").all(),
    ).toEqual([{ actor_id: null }]);
  });

  it('does not pause a webhook that was rotated while the failing request was in flight', async () => {
    const { integration } = await (
      await create({ destination: 'discord', webhookUrl: DISCORD })
    ).json<Created>();
    fetchMock.mockImplementationOnce(async () => {
      const rotated = await call('PATCH', `/api/integrations/${integration.id}`, {
        webhookUrl: 'https://discord.com/api/webhooks/223456789012345678/ReplacedApiToken',
      });
      expect(rotated.status).toBe(200);
      return new Response('{"code":10015}', { status: 404 });
    });
    await deliver(integration.id, 'd1');
    expect(db.raw.prepare("SELECT state FROM deliveries WHERE id='d1'").get()).toEqual({
      state: 'dead_lettered',
    });
    expect(enabledOf(integration.id)).toBe(1);
    expect(
      db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='integration.auto_pause'").get(),
    ).toEqual({ n: 0 });
  });
});

describe('custom webhook is off unless the deployment turns it on (ADR 0014)', () => {
  beforeEach(() => {
    setFlag(undefined);
  });

  it('refuses to create one, with one message that reveals nothing about the URL policy', async () => {
    const messages = new Set<string>();
    for (const webhookUrl of [HOOK, 'https://127.0.0.1/x', 'http://localhost/x', 'nonsense', '']) {
      const res = await create({ destination: 'generic_webhook', webhookUrl });
      expect(res.status).toBe(422);
      const body = await res.json<Failed>();
      expect(body.fields).toEqual([
        { field: 'destination', message: 'This destination type is not available yet.' },
      ]);
      messages.add(JSON.stringify(body));
    }
    expect(messages.size).toBe(1);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM integrations').get()).toEqual({ n: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is refused for a source integration too, and Discord is unaffected', async () => {
    const res = await call('POST', '/api/integrations', {
      name: 'x',
      sourceId: 'src-aaaaaaaa',
      destination: 'generic_webhook',
      webhookUrl: HOOK,
    });
    expect(res.status).toBe(422);
    expect((await res.json<Failed>()).fields).toEqual([
      { field: 'destination', message: 'This destination type is not available yet.' },
    ]);
    expect((await create({ destination: 'discord', webhookUrl: DISCORD })).status).toBe(201);
  });

  it('reports availability on the list so the dashboard can hide it', async () => {
    const off = await (
      await call('GET', '/api/integrations')
    ).json<{ capabilities: { genericWebhook: boolean } }>();
    expect(off.capabilities).toEqual({ genericWebhook: false });
    for (const flag of ['false', 'TRUE', '']) {
      setFlag(flag);
      const r = await (
        await call('GET', '/api/integrations')
      ).json<{ capabilities: { genericWebhook: boolean } }>();
      expect(r.capabilities.genericWebhook).toBe(false);
    }
    setFlag('true');
    const on = await (
      await call('GET', '/api/integrations')
    ).json<{ capabilities: { genericWebhook: boolean } }>();
    expect(on.capabilities).toEqual({ genericWebhook: true });
  });

  it('refuses to re-enable or re-credential a stored one, but still lets it be paused and deleted', async () => {
    setFlag('true');
    const { integration } = await (
      await create({ destination: 'generic_webhook', webhookUrl: HOOK })
    ).json<Created>();
    setFlag(undefined);
    expect((await call('PATCH', `/api/integrations/${integration.id}`, { enabled: false })).status).toBe(200);
    const enable = await call('PATCH', `/api/integrations/${integration.id}`, { enabled: true });
    expect(enable.status).toBe(422);
    expect((await enable.json<Failed>()).fields[0]?.message).toBe(
      'This destination type is not available yet.',
    );
    const rotate = await call('PATCH', `/api/integrations/${integration.id}`, { webhookUrl: HOOK });
    expect(rotate.status).toBe(422);
    expect(
      await (await call('PATCH', `/api/integrations/${integration.id}`, { name: 'Renamed' })).text(),
    ).not.toContain('whsec_');
    expect((await call('DELETE', `/api/integrations/${integration.id}`)).status).toBe(204);
  });
});

describe('custom webhook limits and re-verification', () => {
  it('caps custom webhooks per workspace', async () => {
    for (let i = 0; i < 10; i++) {
      expect(
        (await create({ destination: 'generic_webhook', webhookUrl: HOOK, name: `Hook ${i}` })).status,
      ).toBe(201);
      // Stay under the per-user mutation limit while filling the workspace.
      db.raw.prepare('DELETE FROM api_rate_limits').run();
    }
    const eleventh = await create({ destination: 'generic_webhook', webhookUrl: HOOK });
    expect(eleventh.status).toBe(409);
    expect((await eleventh.json<{ error: string }>()).error).toContain('at most 10 custom webhooks');
    // The cap is for custom webhooks only.
    expect((await create({ destination: 'discord', webhookUrl: DISCORD })).status).toBe(201);
  });

  it('re-resolves the host when the integration is turned back on', async () => {
    const { integration } = await (
      await create({ destination: 'generic_webhook', webhookUrl: HOOK })
    ).json<Created>();
    expect((await call('PATCH', `/api/integrations/${integration.id}`, { enabled: false })).status).toBe(200);
    // The zone now answers with a private address.
    dns['hooks.example.com'] = ['10.0.0.9'];
    const blocked = await call('PATCH', `/api/integrations/${integration.id}`, { enabled: true });
    expect(blocked.status).toBe(422);
    expect(await blocked.text()).not.toContain('10.0.0.9');
    expect(enabledOf(integration.id)).toBe(0);
    // And a public one turns it back on.
    dns['hooks.example.com'] = ['93.184.216.34'];
    expect((await call('PATCH', `/api/integrations/${integration.id}`, { enabled: true })).status).toBe(200);
    expect(enabledOf(integration.id)).toBe(1);
  });

  it('refuses a public name that is an alias for an internal one', async () => {
    fetchMock.mockImplementation((input: string) => {
      const url = new URL(String(input));
      const isA = url.searchParams.get('type') === 'A';
      return Promise.resolve(
        new Response(
          JSON.stringify({
            Status: 0,
            Answer: [
              { name: 'x', type: 5, TTL: 1, data: 'db.internal.' },
              ...(isA ? [{ name: 'db.internal.', type: 1, TTL: 1, data: '93.184.216.34' }] : []),
            ],
          }),
        ),
      );
    });
    const res = await create({ destination: 'generic_webhook', webhookUrl: 'https://alias.example.com/x' });
    expect(res.status).toBe(422);
    expect(await res.text()).not.toContain('db.internal');
  });

  it.each(['https://svc.workers.dev/x', 'https://site.pages.dev/x', 'https://abc.cfargotunnel.com/x'])(
    'refuses Cloudflare-hosted %s',
    async (webhookUrl) => {
      const res = await create({ destination: 'generic_webhook', webhookUrl });
      expect(res.status).toBe(422);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
