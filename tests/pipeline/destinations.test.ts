import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Bindings, DeliveryMessage } from '../../src/env';
import { consumeDeliveries, toNotification, type ConsumerDeps } from '../../src/pipeline/consumer';
import { parseDeliveryMessage } from '../../src/pipeline/outbox';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';
import { legacySeal } from '../support/legacy';

/**
 * Slice 5 wiring: the destination adapters (render, URL policy, classify, send) running
 * inside the slice 4 delivery path, over the real migrations and the fake D1.
 * No real provider is contacted; every response below is a fixture.
 */
const K_LEGACY = 'aa'.repeat(32);
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const URLS = {
  lark: 'https://open.larksuite.com/open-apis/bot/v2/hook/dest-fixture',
  slack: 'https://hooks.slack.com/services/T000/B000/DestFixtureToken',
  teams:
    'https://prod-12.westus.logic.azure.com/workflows/abc123/triggers/manual/paths/invoke?sig=DestFixtureSig',
} as const;
type Kind = keyof typeof URLS;

let db: FakeD1;
let env: Bindings;
let fetchMock: Mock<typeof fetch>;
let claimTokens = 0;

const deps = (random = 0.999999): ConsumerDeps => ({
  random: () => random,
  now: () => NOW,
  newClaimToken: () => `claim-${++claimTokens}`,
});

async function integration(kind: Kind, id = `int-${kind}`, secret?: string): Promise<void> {
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
      await legacySeal(URLS[kind], K_LEGACY),
      secret ? await legacySeal(secret, K_LEGACY) : null,
      'org-a',
    );
}

const FULL: Partial<DeliveryMessage> = {
  repo: 'acme/web',
  actor: 'octocat',
  status: 'failure',
  eventType: 'workflow_run.failure',
  summary: 'main · failure',
};

function enqueue(id: string, kind: Kind, extra: Partial<DeliveryMessage> = FULL): DeliveryMessage {
  const message: DeliveryMessage = {
    id,
    integrationId: `int-${kind}`,
    organizationId: 'org-a',
    title: 'Build failed',
    url: 'https://github.com/acme/web/actions/runs/1',
    ...extra,
  };
  db.raw
    .prepare(
      "INSERT INTO deliveries(id,integration_id,organization_id,state,created_at) VALUES(?,?,?,?,'2026')",
    )
    .run(id, message.integrationId, 'org-a', 'pending');
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

async function consume(body: unknown, attempts = 1, random?: number): Promise<FakeMessage> {
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
    deps(random),
  );
  return msg;
}

function row(id: string) {
  return db.raw
    .prepare('SELECT state,attempts,last_error,last_error_code FROM deliveries WHERE id=?')
    .get(id) as {
    state: string;
    attempts: number;
    last_error: string | null;
    last_error_code: string | null;
  };
}

/** The JSON body the adapter put on the wire for the n-th provider call. */
function sentBody(n = 0): string {
  return (fetchMock.mock.calls[n]?.[1] as { body: string }).body;
}

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
  } as Bindings;
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('delivered vs accepted (F99, F100)', () => {
  it('Slack: HTTP 200 "ok" is delivered, and the card carries the canonical fields', async () => {
    await integration('slack');
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    expect((await consume(enqueue('d1', 'slack'))).acked).toBe(true);
    expect(row('d1')).toMatchObject({ state: 'sent', attempts: 1, last_error_code: null });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(URLS.slack);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', redirect: 'manual' });
    const body = sentBody();
    for (const text of [
      'Build failed',
      'acme/web',
      'octocat',
      'https://github.com/acme/web/actions/runs/1',
    ]) {
      expect(body).toContain(text);
    }
  });

  it('Lark: code 0 is delivered, and a configured signing secret signs the request', async () => {
    await integration('lark', 'int-lark', 'lark-signing-fixture');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 0 }), { status: 200 }));
    await consume(enqueue('d1', 'lark'));
    expect(row('d1')).toMatchObject({ state: 'sent', last_error_code: null });
    const payload = JSON.parse(sentBody()) as Record<string, unknown>;
    expect(payload).toMatchObject({ msg_type: 'interactive' });
    expect(typeof payload.sign).toBe('string');
    expect(typeof payload.timestamp).toBe('string');
    expect(sentBody()).not.toContain('lark-signing-fixture');
  });

  it('Teams: HTTP 202 is stored as accepted, never as sent', async () => {
    await integration('teams');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));
    const msg = await consume(enqueue('d1', 'teams'));
    expect(msg).toMatchObject({ acked: true, retried: null });
    expect(row('d1')).toMatchObject({
      state: 'accepted',
      attempts: 1,
      last_error: null,
      last_error_code: null,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(URLS.teams);
    expect(JSON.parse(sentBody())).toMatchObject({ type: 'message' });
  });

  it('a redelivered message for an accepted delivery makes no second call', async () => {
    await integration('teams');
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    const m = enqueue('d1', 'teams');
    await consume(m);
    await consume(m);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(row('d1').state).toBe('accepted');
  });
});

describe('rendering', () => {
  it.each(['slack', 'teams', 'lark'] as const)(
    '%s: an oversized title is truncated, not rejected',
    async (kind) => {
      await integration(kind);
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          kind === 'lark'
            ? new Response(JSON.stringify({ code: 0 }), { status: 200 })
            : new Response(kind === 'slack' ? 'ok' : null, { status: kind === 'slack' ? 200 : 202 }),
        ),
      );
      const longTitle = `${'A'.repeat(290)}END-OF-TITLE`;
      await consume(enqueue('d1', kind, { ...FULL, title: longTitle, summary: 'S'.repeat(280) }));
      expect(row('d1').state).toBe(kind === 'teams' ? 'accepted' : 'sent');
      expect(sentBody()).not.toContain('END-OF-TITLE');
      expect(new TextEncoder().encode(sentBody()).length).toBeLessThan(kind === 'lark' ? 20_000 : 28_000);
    },
  );

  it('a message written before slice 5 (no canonical fields) still delivers, with defaults', async () => {
    await integration('slack');
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await consume(enqueue('d1', 'slack', {}));
    expect(row('d1').state).toBe('sent');
    expect(sentBody()).toContain('Build failed');
  });

  it('hostile text is neutralised per destination (no live mention reaches the wire)', async () => {
    await integration('slack');
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await consume(enqueue('d1', 'slack', { ...FULL, title: 'hi <!channel> <@U123>', actor: '<!here>' }));
    // Only mrkdwn parses mentions; `plain_text` blocks display them inertly.
    const payload = JSON.parse(sentBody()) as {
      text: string;
      blocks: { type: string; text?: { type: string; text: string } }[];
    };
    expect(payload.text).not.toMatch(/<!channel>|<!here>|<@U123>/);
    const mrkdwn = payload.blocks.flatMap((b) => (b.text?.type === 'mrkdwn' ? [b.text.text] : []));
    expect(mrkdwn.join('\n')).not.toMatch(/<!channel>|<!here>|<@U123>/);
  });
});

describe('failure classification onto the slice 4 retry policy', () => {
  it('honours Retry-After: the queue retry is delayed by the provider value (F178)', async () => {
    await integration('slack');
    fetchMock.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '90' } }));
    const msg = await consume(enqueue('d1', 'slack'), 1, 0);
    expect(msg.retried).toEqual({ delaySeconds: 90 });
    expect(row('d1')).toMatchObject({
      state: 'retrying',
      last_error: 'provider_http_429',
      last_error_code: 'destination_rate_limited',
    });
  });

  it('Lark rate-limit code in a 200 body is retried, with the minted diagnostic', async () => {
    await integration('lark');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 11232 }), { status: 200 }));
    const msg = await consume(enqueue('d1', 'lark'));
    expect(msg.retried).not.toBeNull();
    expect(row('d1')).toMatchObject({
      state: 'retrying',
      last_error: 'provider_lark_11232',
      last_error_code: 'destination_rate_limited',
    });
  });

  it.each([
    ['slack', 404, 'no_service', 'destination_revoked'],
    ['slack', 400, 'invalid_payload', 'render_failed'],
    ['lark', 200, JSON.stringify({ code: 19021 }), 'destination_credentials_invalid'],
    ['lark', 200, JSON.stringify({ code: 230028 }), 'render_failed'],
    ['teams', 404, '', 'destination_revoked'],
    ['teams', 401, '', 'destination_unauthorized'],
  ] as const)(
    '%s HTTP %i %s is permanent: dead_lettered as %s on the first attempt',
    async (kind, status, body, code) => {
      await integration(kind);
      fetchMock.mockResolvedValueOnce(new Response(body, { status }));
      const m = enqueue('d1', kind);
      const msg = await consume(m);
      expect(msg).toMatchObject({ acked: true, retried: null });
      expect(row('d1')).toMatchObject({ state: 'dead_lettered', attempts: 1, last_error_code: code });
      await consume(m);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['slack', 'teams', 'lark'] as const)(
    '%s: a redirect is permanent and never followed',
    async (kind) => {
      await integration(kind);
      fetchMock.mockResolvedValueOnce(
        new Response(null, { status: 307, headers: { location: 'http://169.254.169.254/' } }),
      );
      await consume(enqueue('d1', kind));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
      expect(row('d1')).toMatchObject({
        state: 'dead_lettered',
        last_error: 'provider_redirect_307',
        last_error_code: 'destination_url_rejected',
      });
    },
  );

  it('flags an unmapped provider response in the delivery log (F13 metric)', async () => {
    const lines: string[] = [];
    const capture = (...data: unknown[]): void => {
      lines.push(data.map(String).join(' '));
    };
    vi.spyOn(console, 'info').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    await integration('slack');
    fetchMock.mockResolvedValueOnce(new Response('teapot', { status: 418 }));
    await consume(enqueue('d1', 'slack'));
    expect(row('d1')).toMatchObject({ state: 'retrying', last_error_code: 'internal_error' });
    const attempt = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.msg === 'delivery_attempt');
    expect(attempt).toMatchObject({ unmapped_provider_error: true, error_code: 'internal_error' });
  });

  it('an unreadable 2xx from Slack is recorded as accepted, not retried into a duplicate', async () => {
    await integration('slack');
    fetchMock.mockResolvedValueOnce(new Response('<html>proxy</html>', { status: 200 }));
    await consume(enqueue('d1', 'slack'));
    expect(row('d1')).toMatchObject({ state: 'accepted', last_error: 'provider_reply_unreadable' });
  });

  it('a timeout and a network fault are transient, and carry no platform text', async () => {
    await integration('teams');
    fetchMock.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    await consume(enqueue('d1', 'teams'));
    expect(row('d1')).toMatchObject({ state: 'retrying', last_error: 'provider_timeout' });
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed for ${URLS.teams}`));
    await consume(enqueue('d2', 'teams'));
    expect(row('d2')).toMatchObject({ state: 'retrying', last_error: 'transient_error' });
  });
});

describe('write-time policy is re-applied before every send', () => {
  it('refuses a stored URL that is not a documented host for its destination kind', async () => {
    await integration('teams');
    // A Teams row whose ciphertext was swapped for a Slack URL must never reach the network.
    db.raw
      .prepare('UPDATE integrations SET webhook_ciphertext=? WHERE id=?')
      .run(await legacySeal(URLS.slack, K_LEGACY), 'int-teams');
    await consume(enqueue('d1', 'teams'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(row('d1')).toMatchObject({
      state: 'dead_lettered',
      last_error: 'destination_not_allowed',
      last_error_code: 'destination_url_rejected',
    });
  });
});

describe('canonical message parsing', () => {
  const base = { id: 'a', integrationId: 'i', organizationId: 'o', title: 't', url: 'u' };

  it('keeps the new optional fields and bounds them', () => {
    const m = parseDeliveryMessage({
      ...base,
      repo: 'acme/web',
      actor: 'octocat',
      status: 'failure',
      eventType: 'workflow_run.failure',
      summary: 'x'.repeat(500),
    });
    expect(m).toMatchObject({ repo: 'acme/web', actor: 'octocat', status: 'failure' });
    expect(m?.summary).toHaveLength(280);
  });

  it('drops unknown or malformed optional fields instead of refusing the message', () => {
    expect(parseDeliveryMessage({ ...base, status: 'exploded', repo: 7, actor: '' })).toEqual(base);
  });

  it('never forwards unknown fields, such as legacy ciphertext', () => {
    expect(parseDeliveryMessage({ ...base, ciphertext: 'secret' })).toEqual(base);
  });

  it('maps a legacy message to a notification with a default event type', () => {
    expect(toNotification(base as DeliveryMessage)).toEqual({
      title: 't',
      eventType: 'notification',
      url: 'u',
    });
  });
});
