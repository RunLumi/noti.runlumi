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
