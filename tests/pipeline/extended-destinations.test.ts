import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fromBase64, generateSigningSecret } from '../../src/connectors/sources/generic/encoding';
import { verifyStandardWebhook } from '../../src/connectors/sources/generic/signature';
import type { Bindings, DeliveryMessage } from '../../src/env';
import { consumeDeliveries, type ConsumerDeps } from '../../src/pipeline/consumer';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';
import { legacySeal } from '../support/legacy';

/**
 * Slice 8a over the real migrations and the fake D1: Discord and the signed customer webhook
 * running through the real consumer, adapters and URL policy. `fetch` is stubbed; no provider
 * or customer endpoint is contacted, and every response is a fixture.
 */
const K_LEGACY = 'aa'.repeat(32);
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const DISCORD_URL = 'https://discord.com/api/webhooks/123456789012345678/DiscordPipelineToken';
const GENERIC_URL = 'https://hooks.example.com/noti/inbound?channel=ci';

let db: FakeD1;
let env: Bindings;
let fetchMock: Mock<typeof fetch>;
let claimTokens = 0;

const deps = (): ConsumerDeps => ({
  random: () => 0.999999,
  now: () => NOW,
  newClaimToken: () => `claim-${++claimTokens}`,
});

async function integration(
  kind: 'discord' | 'generic_webhook',
  options: { url?: string; secret?: string | null; id?: string } = {},
): Promise<{ id: string; secret: string | null }> {
  const id = options.id ?? `int-${kind}`;
  const secret =
    options.secret === undefined && kind === 'generic_webhook'
      ? generateSigningSecret()
      : (options.secret ?? null);
  db.raw
    .prepare(
      `INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,lark_secret_ciphertext,organization_id)
       VALUES(?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      'acme/web',
      '["workflow_run.failure"]',
      kind,
      await legacySeal(options.url ?? (kind === 'discord' ? DISCORD_URL : GENERIC_URL), K_LEGACY),
      secret ? await legacySeal(secret, K_LEGACY) : null,
      'org-a',
    );
  return { id, secret };
}

function enqueue(id: string, integrationId: string, extra: Partial<DeliveryMessage> = {}): DeliveryMessage {
  const message: DeliveryMessage = {
    id,
    integrationId,
    organizationId: 'org-a',
    title: 'Build failed',
    url: 'https://github.com/acme/web/actions/runs/1',
    repo: 'acme/web',
    actor: 'octocat',
    status: 'failure',
    eventType: 'workflow_run.failure',
    summary: 'main · failure',
    ...extra,
  };
  db.raw
    .prepare(
      "INSERT INTO deliveries(id,integration_id,organization_id,state,created_at) VALUES(?,?,?,?,'2026')",
    )
    .run(id, integrationId, 'org-a', 'pending');
  db.raw
    .prepare('INSERT INTO notification_outbox(id,organization_id,payload_json) VALUES(?,?,?)')
    .run(id, 'org-a', JSON.stringify(message));
  return message;
}

interface FakeMessage {
  body: unknown;
  attempts: number;
  acked: boolean;
  retried: { delaySeconds?: number } | null;
  ack(): void;
  retry(o?: { delaySeconds?: number }): void;
}

async function consume(body: unknown, attempts = 1): Promise<FakeMessage> {
  const msg: FakeMessage = {
    body,
    attempts,
    acked: false,
    retried: null,
    ack() {
      this.acked = true;
    },
    retry(o = {}) {
      this.retried = o;
    },
  };
  await consumeDeliveries(
    { messages: [msg], retryAll: () => undefined } as unknown as MessageBatch<unknown>,
    env,
    deps(),
  );
  return msg;
}

const row = (id: string) =>
  db.raw.prepare('SELECT state,attempts,last_error,last_error_code FROM deliveries WHERE id=?').get(id) as {
    state: string;
    attempts: number;
    last_error: string | null;
    last_error_code: string | null;
  };

const enabled = (id: string): number =>
  (db.raw.prepare('SELECT enabled FROM integrations WHERE id=?').get(id) as { enabled: number }).enabled;

const call = (n = 0) =>
  fetchMock.mock.calls[n] as [string, RequestInit & { body: string; headers: Record<string, string> }];

beforeEach(() => {
  db = createFakeD1();
  seedOrganization(db.raw, 'org-a');
  env = {
    DB: db.d1,
    DELIVERY_QUEUE: { send: () => Promise.resolve() } as unknown as Queue<DeliveryMessage>,
    GITHUB_WEBHOOK_SECRET: 'unused',
    GITHUB_APP_ID: '777',
    ENCRYPTION_KEY: K_LEGACY,
    KEK_V1: '11'.repeat(32),
    KEK_V2: '',
    KMS_ACTIVE_VERSION: '1',
    ENVIRONMENT_NAME: 'staging',
    KEK_CHECK_V1: '4464ea2121d3a99ebd188370f1ef6cd0',
    APP_ORIGIN: 'https://noti.test',
    GENERIC_WEBHOOK_ENABLED: 'true',
  } as Bindings;
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Discord end to end', () => {
  it('delivers with wait=true on the v10 endpoint, and no mention can reach a person', async () => {
    const { id } = await integration('discord');
    fetchMock.mockResolvedValueOnce(new Response('{"id":"1"}', { status: 200 }));
    await consume(
      enqueue('d1', id, { title: '@everyone <@&123>', actor: '@here', summary: '<@everyone> ping' }),
    );
    expect(row('d1')).toMatchObject({ state: 'sent', attempts: 1, last_error_code: null });
    const [url, init] = call();
    const sent = new URL(url);
    expect(sent.origin + sent.pathname).toBe(
      'https://discord.com/api/v10/webhooks/123456789012345678/DiscordPipelineToken',
    );
    expect(sent.searchParams.get('wait')).toBe('true');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
    const body = JSON.parse(init.body) as { allowed_mentions: unknown; embeds: unknown[] };
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.embeds).toHaveLength(1);
    expect(init.body).not.toMatch(/<@|@everyone|@here/);
  });

  it('204 (what wait=false would return) is recorded as accepted, never as sent', async () => {
    const { id } = await integration('discord');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await consume(enqueue('d1', id));
    expect(row('d1').state).toBe('accepted');
  });

  it('404 is terminal with no retry, pauses the integration, audits it, and stops the next request', async () => {
    const { id } = await integration('discord');
    fetchMock.mockResolvedValueOnce(
      new Response('{"message":"Unknown Webhook","code":10015}', { status: 404 }),
    );
    const msg = await consume(enqueue('d1', id));
    expect(msg).toMatchObject({ acked: true, retried: null });
    expect(row('d1')).toMatchObject({
      state: 'dead_lettered',
      attempts: 1,
      last_error: 'provider_http_404',
      last_error_code: 'destination_revoked',
    });
    expect(enabled(id)).toBe(0);
    const audit = db.raw
      .prepare(
        "SELECT actor_id,action,subject_id,metadata_json FROM audit_events WHERE action='integration.auto_pause'",
      )
      .all() as { actor_id: string | null; action: string; subject_id: string; metadata_json: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: null, subject_id: id });
    expect(JSON.parse(audit[0]?.metadata_json ?? '{}')).toEqual({
      destination: 'discord',
      providerStatus: 404,
      reason: 'destination_revoked',
    });
    expect(audit[0]?.metadata_json).not.toContain('DiscordPipelineToken');

    // The next event for the same dead webhook never reaches Discord.
    await consume(enqueue('d2', id));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(row('d2')).toMatchObject({ state: 'dead_lettered', last_error: 'integration_unavailable' });
  });

  it.each([
    [
      403,
      '{"message":"Unknown Webhook","code":10015}',
      'destination_revoked',
      'provider_discord_unknown_webhook',
    ],
    [
      401,
      '{"message":"Invalid Webhook Token","code":50027}',
      'destination_unauthorized',
      'provider_discord_invalid_webhook_token',
    ],
  ] as const)(
    'HTTP %i with Discord code in the body pauses on the first occurrence',
    async (status, body, code, diagnostic) => {
      const { id } = await integration('discord');
      fetchMock.mockResolvedValueOnce(new Response(body, { status }));
      await consume(enqueue('d1', id));
      expect(row('d1')).toMatchObject({
        state: 'dead_lettered',
        last_error: diagnostic,
        last_error_code: code,
      });
      expect(enabled(id)).toBe(0);
    },
  );

  it('a plain 403 does NOT pause: it is retried once more, then stops, never paused', async () => {
    const { id } = await integration('discord');
    fetchMock.mockResolvedValue(new Response('<html>blocked</html>', { status: 403 }));
    const m = enqueue('d1', id);
    expect((await consume(m)).retried).not.toBeNull();
    expect(row('d1')).toMatchObject({ state: 'retrying', last_error: 'provider_discord_http_403' });
    expect(enabled(id)).toBe(1);
    db.raw.prepare("UPDATE deliveries SET next_attempt_at=NULL WHERE id='d1'").run();
    const second = await consume(m, 2);
    // The shared invalid-request budget is not spent a third time.
    expect(second).toMatchObject({ acked: true, retried: null });
    expect(row('d1')).toMatchObject({ state: 'dead_lettered', last_error_code: 'destination_unauthorized' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(enabled(id)).toBe(1);
    expect(
      db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='integration.auto_pause'").get(),
    ).toEqual({ n: 0 });
  });

  it('does not pause a webhook the customer replaced while the failing request was in flight', async () => {
    const { id } = await integration('discord');
    fetchMock.mockImplementationOnce(async () => {
      // The customer pastes a new webhook URL after our request left, before the 404 returns.
      db.raw
        .prepare('UPDATE integrations SET webhook_ciphertext=? WHERE id=?')
        .run(
          await legacySeal('https://discord.com/api/webhooks/223456789012345678/ReplacedToken', K_LEGACY),
          id,
        );
      return new Response('{"code":10015}', { status: 404 });
    });
    await consume(enqueue('d1', id));
    expect(row('d1')).toMatchObject({ state: 'dead_lettered', last_error_code: 'destination_revoked' });
    expect(enabled(id)).toBe(1);
    expect(
      db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='integration.auto_pause'").get(),
    ).toEqual({ n: 0 });
  });

  it('pauses a legacy-format credential, pinned by its ciphertext', async () => {
    const { id } = await integration('discord');
    const before = db.raw.prepare('SELECT webhook_envelope FROM integrations WHERE id=?').get(id) as {
      webhook_envelope: Uint8Array | null;
    };
    expect(before.webhook_envelope).toBeNull(); // legacy row: pinned by its ciphertext
    fetchMock.mockResolvedValueOnce(new Response('{"code":10015}', { status: 404 }));
    await consume(enqueue('d1', id));
    expect(enabled(id)).toBe(0);
    expect(
      db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='integration.auto_pause'").get(),
    ).toEqual({ n: 1 });
  });

  it('429 honours the body retry_after and does not pause; 5xx retries and does not pause', async () => {
    const { id } = await integration('discord');
    fetchMock.mockResolvedValueOnce(
      new Response('{"message":"You are being rate limited.","retry_after":1.5,"global":false}', {
        status: 429,
        headers: { 'retry-after': '99' },
      }),
    );
    const limited = await consume(enqueue('d1', id));
    expect(limited.retried).toEqual({ delaySeconds: 2 });
    expect(row('d1')).toMatchObject({ state: 'retrying', last_error_code: 'destination_rate_limited' });
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    const down = await consume(enqueue('d2', id));
    expect(down.retried).not.toBeNull();
    expect(row('d2').state).toBe('retrying');
    expect(enabled(id)).toBe(1);
  });

  it('a 400 is a permanent rejection of our payload and does not pause the webhook', async () => {
    const { id } = await integration('discord');
    fetchMock.mockResolvedValueOnce(new Response('{"code":50035}', { status: 400 }));
    await consume(enqueue('d1', id));
    expect(row('d1')).toMatchObject({ state: 'dead_lettered', last_error_code: 'render_failed' });
    expect(enabled(id)).toBe(1);
  });

  it('refuses a stored URL that is not a Discord webhook URL', async () => {
    const { id } = await integration('discord', { url: 'https://hooks.example.com/api/webhooks/1/x' });
    await consume(enqueue('d1', id));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(row('d1')).toMatchObject({ last_error: 'destination_not_allowed' });
  });
});

describe('signed customer webhook end to end', () => {
  it('delivers a Standard Webhooks request the receiver can verify, with webhook-id = delivery id', async () => {
    const { id, secret } = await integration('generic_webhook');
    fetchMock.mockResolvedValueOnce(new Response('{"received":true}', { status: 200 }));
    await consume(enqueue('delivery-1', id));
    expect(row('delivery-1')).toMatchObject({ state: 'sent', attempts: 1, last_error_code: null });
    const [url, init] = call();
    expect(url).toBe(GENERIC_URL);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(init.headers['webhook-id']).toBe('delivery-1');
    const key = fromBase64((secret ?? '').slice('whsec_'.length));
    if (!key) throw new Error('key');
    const verdict = await verifyStandardWebhook(
      key,
      {
        id: init.headers['webhook-id'] ?? null,
        timestamp: init.headers['webhook-timestamp'] ?? null,
        signature: init.headers['webhook-signature'] ?? null,
      },
      new TextEncoder().encode(init.body),
      Math.floor(NOW / 1000),
    );
    expect(verdict).toEqual({ ok: true });
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      version: 1,
      type: 'noti.notification',
      id: 'delivery-1',
      workspaceId: 'org-a',
      notification: { title: 'Build failed', eventType: 'workflow_run.failure', status: 'failure' },
    });
    // The signing secret is never part of what is sent.
    expect(init.body).not.toContain(secret ?? 'unreachable');
    expect(JSON.stringify(init.headers)).not.toContain(secret ?? 'unreachable');
  });

  it('keeps webhook-id stable across our own retries', async () => {
    const { id } = await integration('generic_webhook');
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));
    const m = enqueue('delivery-2', id);
    expect((await consume(m)).retried).not.toBeNull();
    expect(row('delivery-2').state).toBe('retrying');
    // The retry is due immediately in this harness (delay elapsed); make it so explicitly.
    db.raw.prepare("UPDATE deliveries SET next_attempt_at=NULL WHERE id='delivery-2'").run();
    await consume(m, 2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(call(0)[1].headers['webhook-id']).toBe('delivery-2');
    expect(call(1)[1].headers['webhook-id']).toBe('delivery-2');
    expect(row('delivery-2').state).toBe('sent');
  });

  it('HTTP 202 is stored as accepted; 2xx is the only evidence we have', async () => {
    const { id } = await integration('generic_webhook');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));
    await consume(enqueue('d1', id));
    expect(row('d1').state).toBe('accepted');
  });

  it('a redirect is permanent and is never followed (the cheapest SSRF bypass)', async () => {
    const { id } = await integration('generic_webhook');
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }),
    );
    await consume(enqueue('d1', id));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(call()[1].redirect).toBe('manual');
    expect(row('d1')).toMatchObject({
      state: 'dead_lettered',
      last_error: 'provider_redirect_302',
      last_error_code: 'destination_url_rejected',
    });
  });

  it.each([
    [400, 'render_failed'],
    [401, 'destination_unauthorized'],
    [404, 'destination_revoked'],
    [405, 'destination_revoked'],
    [409, 'render_failed'],
  ] as const)(
    'HTTP %i is permanent (%s) on the first attempt and does not pause the integration',
    async (status, code) => {
      const { id } = await integration('generic_webhook');
      fetchMock.mockResolvedValueOnce(new Response('<html>hostile body</html>', { status }));
      const msg = await consume(enqueue('d1', id));
      expect(msg).toMatchObject({ acked: true, retried: null });
      expect(row('d1')).toMatchObject({ state: 'dead_lettered', attempts: 1, last_error_code: code });
      expect(row('d1').last_error ?? '').not.toContain('hostile');
      expect(enabled(id)).toBe(1);
    },
  );

  it('429 honours Retry-After', async () => {
    const { id } = await integration('generic_webhook');
    fetchMock.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '45' } }));
    const delay = (await consume(enqueue('d1', id))).retried?.delaySeconds ?? 0;
    // Never earlier than the customer asked; the retry policy may add jitter on top.
    expect(delay).toBeGreaterThanOrEqual(45);
    expect(delay).toBeLessThanOrEqual(60);
  });

  it('re-applies the URL policy at send time: an internal host reaches no network', async () => {
    for (const [i, url] of [
      'https://169.254.169.254/latest/meta-data/',
      'https://localhost/x',
      'https://service.internal/x',
      'http://hooks.example.com/x',
      'https://hooks.example.com:8443/x',
    ].entries()) {
      const { id } = await integration('generic_webhook', { url, id: `int-${i}` });
      await consume(enqueue(`d${i}`, id));
      expect(row(`d${i}`)).toMatchObject({
        state: 'dead_lettered',
        last_error: 'destination_not_allowed',
        last_error_code: 'destination_url_rejected',
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never sends an unsigned request: a row with no signing secret is dead-lettered unsent', async () => {
    const { id } = await integration('generic_webhook', { secret: null });
    await consume(enqueue('d1', id));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(row('d1')).toMatchObject({ state: 'dead_lettered', last_error_code: 'config_invalid' });
  });

  it('a malformed stored secret is never used to sign', async () => {
    const { id } = await integration('generic_webhook', { secret: 'whsec_short' });
    await consume(enqueue('d1', id));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(row('d1').state).toBe('dead_lettered');
  });
});

describe('custom webhook: feature flag, own hosts and tenant-visible reasons (ADR 0014)', () => {
  it('refuses to send to a stored row while the feature is off, with no network call', async () => {
    const { id } = await integration('generic_webhook');
    for (const flag of [undefined, '', 'false', 'TRUE', '1', 'yes']) {
      env = { ...env, GENERIC_WEBHOOK_ENABLED: flag };
      await consume(enqueue(`d-${String(flag)}`, id));
      expect(row(`d-${String(flag)}`)).toMatchObject({
        state: 'dead_lettered',
        last_error: 'destination_type_disabled',
        last_error_code: 'config_invalid',
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('delivers again once the flag is on (redelivery after enabling works)', async () => {
    const { id } = await integration('generic_webhook');
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));
    await consume(enqueue('d1', id));
    expect(row('d1').state).toBe('sent');
  });

  it('the flag does not affect Discord', async () => {
    env = { ...env, GENERIC_WEBHOOK_ENABLED: 'false' };
    const { id } = await integration('discord');
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await consume(enqueue('d1', id));
    expect(row('d1').state).toBe('sent');
  });

  it.each([
    'https://noti.test/webhooks/generic/abc', // APP_ORIGIN host itself
    'https://x.noti.test/x',
    'https://svc.workers.dev/x',
    'https://site.pages.dev/x',
    'https://abc.cfargotunnel.com/x',
  ])('a stored row pointing at %s is refused at send time', async (url) => {
    const { id } = await integration('generic_webhook', { url });
    await consume(enqueue('d1', id));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(row('d1')).toMatchObject({
      last_error: 'destination_not_allowed',
      last_error_code: 'destination_url_rejected',
    });
  });

  it('refuses a stored legacy row whose host was never valid, at send time', async () => {
    const { id } = await integration('generic_webhook', { url: 'https://10.0.0.8/hook' });
    await consume(enqueue('d1', id));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(row('d1').last_error).toBe('destination_not_allowed');
  });

  it('shows every connection failure to the tenant as the same thing', async () => {
    const { id } = await integration('generic_webhook');
    const failures = [
      new DOMException('timed out', 'TimeoutError'),
      new TypeError('connect ECONNREFUSED 10.0.0.8:443'),
      new TypeError('Network connection lost.'),
    ];
    for (const [i, failure] of failures.entries()) {
      fetchMock.mockRejectedValueOnce(failure);
      await consume(enqueue(`u${i}`, id));
      expect(row(`u${i}`)).toMatchObject({
        state: 'retrying',
        last_error: 'destination_unreachable',
        last_error_code: 'destination_unavailable',
      });
    }
  });

  it('keeps HTTP statuses visible: the customer needs them to fix their endpoint', async () => {
    const { id } = await integration('generic_webhook');
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    await consume(enqueue('s1', id));
    expect(row('s1').last_error).toBe('provider_http_503');
  });
});
