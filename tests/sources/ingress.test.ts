import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_BODY_BYTES } from '../../src/connectors/sources/generic/route';
import { SOURCE_INGRESS_LIMIT_PER_MINUTE } from '../../src/security/rate-limit';
import type { DeliveryMessage } from '../../src/env';
import { consumeDeliveries, type ConsumerDeps } from '../../src/pipeline/consumer';
import {
  EVENT,
  LARK,
  SLACK,
  TEAMS,
  caller,
  setup,
  signHeaders,
  type CreatedSource,
  type Harness,
} from './harness';

vi.mock('../../src/auth/better-auth', async () => (await import('./harness')).mockAuth());

const { default: worker } = await import('../../src/index');

let h: Harness;
const call = caller(worker, () => h);

async function createSource(as = 'alice', name = 'CI pipeline'): Promise<CreatedSource> {
  const res = await call('POST', '/api/sources', { as, body: { name } });
  expect(res.status).toBe(201);
  const body = await res.json<{
    source: { id: string; endpointId: string; endpointUrl: string };
    secret: string;
  }>();
  return { ...body.source, secret: body.secret };
}

async function route(
  as: string,
  sourceId: string,
  destination: 'slack' | 'lark' | 'teams' = 'slack',
  extra: Record<string, unknown> = {},
): Promise<string> {
  const url = { slack: SLACK, lark: LARK, teams: TEAMS }[destination];
  const res = await call('POST', '/api/integrations', {
    as,
    body: { name: `to ${destination}`, sourceId, destination, webhookUrl: url, ...extra },
  });
  expect(res.status).toBe(201);
  return (await res.json<{ integration: { id: string } }>()).integration.id;
}

interface PostOptions {
  headers?: Record<string, string>;
  rawBody?: string | Uint8Array;
  contentType?: string | null;
  sign?: boolean;
  id?: string;
  ts?: number;
}

async function post(src: { endpointId: string; secret: string }, body: unknown, o: PostOptions = {}) {
  const text = o.rawBody ?? JSON.stringify(body);
  const signed =
    o.sign === false
      ? {}
      : signHeaders(src.secret, typeof text === 'string' ? text : Buffer.from(text), {
          ...(o.id ? { id: o.id } : {}),
          ...(o.ts !== undefined ? { ts: o.ts } : {}),
        });
  const headers = new Headers({ ...signed, ...o.headers });
  if (o.contentType !== null) headers.set('content-type', o.contentType ?? 'application/json');
  return worker.fetch(
    new Request(`https://noti.test/webhooks/generic/${src.endpointId}`, {
      method: 'POST',
      headers,
      body: text instanceof Uint8Array ? text.slice().buffer : text,
    }),
    h.env,
    { waitUntil: h.waitUntil, passThroughOnException: () => undefined } as unknown as ExecutionContext,
  );
}

const count = (sql: string, ...args: string[]) => (h.db.raw.prepare(sql).get(...args) as { n: number }).n;
const deliveries = () => count('SELECT COUNT(*) AS n FROM deliveries');

beforeEach(() => {
  h = setup();
});
afterEach(() => vi.unstubAllGlobals());

describe('accepted events', () => {
  it('verifies, persists one delivery and one outbox row, and acknowledges with 202', async () => {
    const src = await createSource();
    const integration = await route('alice', src.id);
    const res = await post(src, EVENT);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, persisted: 1 });
    expect(h.waitUntil).toHaveBeenCalledTimes(1);

    const d = h.db.raw.prepare('SELECT * FROM deliveries').get() as Record<string, unknown>;
    expect(d).toMatchObject({ integration_id: integration, organization_id: 'org-a', state: 'pending' });
    const outbox = h.db.raw.prepare('SELECT payload_json FROM notification_outbox').get() as {
      payload_json: string;
    };
    expect(JSON.parse(outbox.payload_json)).toMatchObject({
      integrationId: integration,
      organizationId: 'org-a',
      title: EVENT.title,
      url: EVENT.url,
      actor: 'deploy-bot',
      status: 'failure',
      eventType: 'deploy.failed',
      summary: 'Exit code 1\nenv: prod',
    });
    const touched = h.db.raw.prepare('SELECT last_received_at FROM sources WHERE id=?').get(src.id) as {
      last_received_at: string | null;
    };
    expect(touched.last_received_at).not.toBeNull();
  });

  it('accepts a content type with parameters and several signatures (rotation overlap)', async () => {
    const src = await createSource();
    await route('alice', src.id);
    const signed = signHeaders(src.secret, JSON.stringify(EVENT));
    const withDecoy = {
      ...signed,
      'webhook-signature': `v1,${Buffer.alloc(32, 7).toString('base64')} ${signed['webhook-signature']}`,
    };
    const res = await post(src, EVENT, {
      contentType: 'application/json; charset=utf-8',
      headers: withDecoy,
      sign: false,
    });
    expect(res.status).toBe(202);
  });

  it('acknowledges an event for a source with no integrations and persists nothing', async () => {
    const src = await createSource();
    const res = await post(src, EVENT);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, persisted: 0 });
    expect(deliveries()).toBe(0);
  });

  it('routes to every enabled integration of the source and only those', async () => {
    const src = await createSource();
    const other = await createSource('alice', 'Other');
    const a = await route('alice', src.id, 'slack');
    const b = await route('alice', src.id, 'lark');
    const paused = await route('alice', src.id, 'teams');
    await route('alice', other.id, 'slack');
    await call('PATCH', `/api/integrations/${paused}`, { as: 'alice', body: { enabled: false } });
    // A GitHub-style integration is never selected by a generic event.
    h.db.raw
      .prepare(
        `INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id,enabled)
         VALUES('gh','acme/web','["issues.opened"]','slack','x','org-a',1)`,
      )
      .run();
    const res = await post(src, EVENT);
    expect(await res.json()).toMatchObject({ persisted: 2 });
    const ids = (
      h.db.raw.prepare('SELECT integration_id FROM deliveries').all() as { integration_id: string }[]
    )
      .map((r) => r.integration_id)
      .sort();
    expect(ids).toEqual([a, b].sort());
  });
});

describe('end to end through the destination adapters', () => {
  const deps: ConsumerDeps = {
    random: () => 0.5,
    now: () => Date.now(),
    newClaimToken: () => crypto.randomUUID(),
  };

  async function deliver() {
    const rows = h.db.raw.prepare('SELECT payload_json FROM notification_outbox ORDER BY rowid').all() as {
      payload_json: string;
    }[];
    for (const r of rows) {
      const msg = {
        body: JSON.parse(r.payload_json) as DeliveryMessage,
        attempts: 1,
        ack: vi.fn(),
        retry: vi.fn(),
      };
      await consumeDeliveries(
        { messages: [msg], retryAll: () => undefined } as unknown as MessageBatch<unknown>,
        h.env,
        deps,
      );
      expect(msg.ack).toHaveBeenCalled();
    }
  }

  it.each([
    ['slack', SLACK, 'hooks.slack.com'],
    ['lark', LARK, 'open.larksuite.com'],
    ['teams', TEAMS, 'logic.azure.com'],
  ] as const)('renders and sends a generic event to %s', async (kind, url, host) => {
    const src = await createSource();
    await route('alice', src.id, kind);
    expect((await post(src, EVENT)).status).toBe(202);
    h.fetchMock.mockClear();
    h.fetchMock.mockResolvedValue(
      kind === 'lark'
        ? new Response(JSON.stringify({ code: 0 }), { status: 200 })
        : kind === 'teams'
          ? new Response(null, { status: 202 })
          : new Response('ok', { status: 200 }),
    );
    await deliver();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = h.fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(target).toBe(url);
    expect(new URL(target).hostname.endsWith(host)).toBe(true);
    expect(init.body).toContain('Deploy failed on production');
    expect(init.body).toContain('deploy-bot');
    expect(init.body).toContain('https://ci.example.com/runs/42');
    const state = h.db.raw.prepare('SELECT state FROM deliveries').get() as { state: string };
    expect(['sent', 'accepted']).toContain(state.state);
  });
});

describe('verification', () => {
  it('rejects a bad signature, tampered body, missing headers and wrong secret with an identical 401', async () => {
    const src = await createSource();
    await route('alice', src.id);
    const other = await createSource('alice', 'Other');
    const good = signHeaders(src.secret, JSON.stringify(EVENT));
    const responses = [
      await post(src, EVENT, { sign: false }),
      await post(src, EVENT, { sign: false, headers: { ...good, 'webhook-signature': 'v1,AAAA' } }),
      await post(src, EVENT, {
        sign: false,
        headers: good,
        rawBody: JSON.stringify({ ...EVENT, title: 'tampered' }),
      }),
      await post({ ...src, secret: other.secret }, EVENT),
      await post(src, EVENT, {
        sign: false,
        headers: { ...good, 'webhook-signature': `v1a,${(good['webhook-signature'] ?? '').slice(3)}` },
      }),
    ];
    for (const r of responses) expect(r.status).toBe(401);
    const bodies = await Promise.all(responses.map((r) => r.text()));
    expect(new Set(bodies)).toEqual(new Set(['Unauthorized']));
    expect(deliveries()).toBe(0);
  });

  it('enforces the 5 minute replay window and accepts the edge', async () => {
    const src = await createSource();
    await route('alice', src.id);
    const now = Math.floor(Date.now() / 1000);
    expect((await post(src, EVENT, { ts: now - 301 })).status).toBe(401);
    expect((await post(src, EVENT, { ts: now + 301 })).status).toBe(401);
    expect((await post(src, EVENT, { ts: now - 290 })).status).toBe(202);
    expect((await post(src, EVENT, { ts: now + 290 })).status).toBe(202);
  });

  it('rejects a webhook-id containing a dot before any HMAC, even when correctly signed', async () => {
    const src = await createSource();
    await route('alice', src.id);
    expect((await post(src, EVENT, { id: 'evt.1' })).status).toBe(401);
    expect(deliveries()).toBe(0);
  });

  it('rejects an unsigned event even when the JSON is invalid (verify before parse)', async () => {
    const src = await createSource();
    const res = await post(src, null, { rawBody: '{not json', sign: false });
    expect(res.status).toBe(401);
  });

  it('verifies over the raw bytes: re-serialised JSON with the same meaning does not verify', async () => {
    const src = await createSource();
    await route('alice', src.id);
    const pretty = JSON.stringify(EVENT, null, 2);
    const headers = signHeaders(src.secret, pretty);
    expect((await post(src, EVENT, { rawBody: pretty, sign: false, headers })).status).toBe(202);
    expect((await post(src, EVENT, { rawBody: JSON.stringify(EVENT), sign: false, headers })).status).toBe(
      401,
    );
  });

  it('does not count unauthenticated calls against the source flood budget (limit runs after verify)', async () => {
    const src = await createSource();
    h.db.raw
      .prepare('INSERT INTO api_rate_limits(key,window_start,count) VALUES(?,?,?)')
      .run(
        `ingress:source:${src.id}`,
        Math.floor(Date.now() / 60_000) * 60_000,
        SOURCE_INGRESS_LIMIT_PER_MINUTE,
      );
    // Bad signature: 401, and the counter does not move.
    expect((await post(src, EVENT, { sign: false })).status).toBe(401);
    const row = () =>
      (
        h.db.raw.prepare('SELECT count FROM api_rate_limits WHERE key=?').get(`ingress:source:${src.id}`) as {
          count: number;
        }
      ).count;
    expect(row()).toBe(SOURCE_INGRESS_LIMIT_PER_MINUTE);
    // Authenticated call over the budget: 429 with Retry-After.
    const limited = await post(src, EVENT);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(deliveries()).toBe(0);
  });
});

describe('request shape limits', () => {
  it('rejects a non-JSON content type with 415 before reading further', async () => {
    const src = await createSource();
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'application/jsonx', null])
      expect((await post(src, EVENT, { contentType })).status).toBe(415);
  });

  it('rejects an oversize body by header and by actual bytes', async () => {
    const src = await createSource();
    await route('alice', src.id);
    const big = JSON.stringify({ ...EVENT, summary: 'x'.repeat(MAX_BODY_BYTES) });
    expect((await post(src, EVENT, { rawBody: big })).status).toBe(413);
    // Declared length lies: the bytes actually read are still capped.
    const lie = await post(src, EVENT, { rawBody: big, headers: { 'content-length': '10' } });
    expect(lie.status).toBe(413);
    // Exactly at the cap is still read (and then fails validation, not size).
    const edge = 'a'.repeat(MAX_BODY_BYTES);
    expect((await post(src, EVENT, { rawBody: edge })).status).toBe(400);
  });

  it('answers 400 with field names (never values) for an invalid but authentic event', async () => {
    const src = await createSource();
    await route('alice', src.id);
    const res = await post(src, { ...EVENT, url: 'http://SECRETHOST.test/x', severity: 'fatal', bogus: 1 });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: 'Invalid event' });
    expect(text).not.toContain('SECRETHOST');
    for (const f of ['url', 'severity', 'bogus']) expect(text).toContain(`"${f}"`);
    expect((await post(src, null, { rawBody: '{broken' })).status).toBe(400);
    expect((await post(src, null, { rawBody: new Uint8Array([0x7b, 0xff, 0x7d]) })).status).toBe(400);
    expect(deliveries()).toBe(0);
  });

  it('only accepts POST', async () => {
    const src = await createSource();
    const res = await worker.fetch(
      new Request(`https://noti.test/webhooks/generic/${src.endpointId}`),
      h.env,
      {
        waitUntil: () => undefined,
      } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(404);
  });
});

describe('unknown, malformed and disabled endpoints', () => {
  async function snapshot(res: Response) {
    return {
      status: res.status,
      body: await res.text(),
      headers: [...(res.headers as unknown as Iterable<[string, string]>)]
        .filter(([k]) => k !== 'x-correlation-id' && k !== 'x-request-id')
        .sort(),
    };
  }

  it('answers every non-live endpoint with one identical 404, signed or not', async () => {
    const live = await createSource();
    const disabled = await createSource('alice', 'Off');
    await call('PATCH', `/api/sources/${disabled.id}`, { as: 'alice', body: { enabled: false } });
    const variants = [
      { endpointId: 'A'.repeat(24), secret: live.secret },
      { endpointId: 'short', secret: live.secret },
      { endpointId: `${live.endpointId}x`, secret: live.secret },
      {
        endpointId:
          live.endpointId.toLowerCase() === live.endpointId
            ? live.endpointId.toUpperCase()
            : live.endpointId.toLowerCase(),
        secret: live.secret,
      },
      disabled,
    ];
    const results = [];
    for (const v of variants) {
      results.push(await snapshot(await post(v, EVENT)));
      results.push(await snapshot(await post(v, EVENT, { sign: false })));
      results.push(
        await snapshot(await post(v, EVENT, { headers: { 'webhook-signature': 'garbage' }, sign: false })),
      );
    }
    for (const r of results) expect(r).toEqual(results[0]);
    expect(results[0]?.status).toBe(404);
    expect(deliveries()).toBe(0);
    // And a disabled source never touches the flood counter.
    expect(count('SELECT COUNT(*) AS n FROM api_rate_limits WHERE key LIKE ?', 'ingress:%')).toBe(0);
  });

  it('does equivalent verification work for a dead endpoint (decoy HMAC runs)', async () => {
    const spy = vi.spyOn(crypto.subtle, 'verify');
    const src = await createSource();
    spy.mockClear();
    await post({ endpointId: 'Z'.repeat(24), secret: src.secret }, EVENT);
    const dead = spy.mock.calls.length;
    spy.mockClear();
    await post(src, EVENT);
    expect(dead).toBeGreaterThan(0);
    expect(dead).toBe(spy.mock.calls.length);
    spy.mockRestore();
  });
});

describe('idempotency', () => {
  it('accepts a repeated webhook-id once: the retry is a 202 duplicate with nothing new queued', async () => {
    const src = await createSource();
    await route('alice', src.id);
    expect(await (await post(src, EVENT, { id: 'evt_1' })).json()).toEqual({ accepted: true, persisted: 1 });
    const again = await post(src, EVENT, { id: 'evt_1', ts: Math.floor(Date.now() / 1000) - 10 });
    expect(await again.json()).toEqual({ accepted: true, persisted: 0, duplicate: true });
    expect(deliveries()).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM notification_outbox')).toBe(1);
  });

  it('first writer wins when a webhook-id is reused with a different body', async () => {
    const src = await createSource();
    await route('alice', src.id);
    await post(src, EVENT, { id: 'evt_2' });
    await post(src, { ...EVENT, title: 'Different' }, { id: 'evt_2' });
    const out = h.db.raw.prepare('SELECT payload_json FROM notification_outbox').all() as {
      payload_json: string;
    }[];
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]?.payload_json ?? '{}')).toMatchObject({ title: EVENT.title });
  });

  it('distinct webhook-ids are distinct deliveries, and a new integration gets its own', async () => {
    const src = await createSource();
    await route('alice', src.id, 'slack');
    await post(src, EVENT, { id: 'evt_3' });
    await post(src, EVENT, { id: 'evt_4' });
    expect(deliveries()).toBe(2);
    await route('alice', src.id, 'lark');
    expect(await (await post(src, EVENT, { id: 'evt_3' })).json()).toMatchObject({ persisted: 1 });
    expect(deliveries()).toBe(3);
  });

  it('the same webhook-id in two sources (two tenants) never collides', async () => {
    const a = await createSource('alice');
    const b = await createSource('mallory');
    await route('alice', a.id);
    await route('mallory', b.id);
    expect(await (await post(a, EVENT, { id: 'same' })).json()).toMatchObject({ persisted: 1 });
    expect(await (await post(b, EVENT, { id: 'same' })).json()).toMatchObject({ persisted: 1 });
    expect(deliveries()).toBe(2);
  });
});

describe('tenant isolation', () => {
  it('routes only within the source’s own workspace', async () => {
    const a = await createSource('alice');
    const b = await createSource('mallory');
    const ia = await route('alice', a.id);
    const ib = await route('mallory', b.id);
    await post(a, EVENT);
    const rows = h.db.raw.prepare('SELECT integration_id,organization_id FROM deliveries').all();
    expect(rows).toEqual([{ integration_id: ia, organization_id: 'org-a' }]);
    expect(ib).not.toBe(ia);
  });

  it('refuses to bind an integration to another workspace’s source (API and database)', async () => {
    const a = await createSource('alice');
    const res = await call('POST', '/api/integrations', {
      as: 'mallory',
      body: { name: 'steal', sourceId: a.id, destination: 'slack', webhookUrl: SLACK },
    });
    expect(res.status).toBe(422);
    expect(() =>
      h.db.raw
        .prepare(
          `INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id,source_id)
           VALUES('x','source:y','[]','slack','x','org-b',?)`,
        )
        .run(a.id),
    ).toThrow(/same organization/);
    await post(a, EVENT);
    expect(deliveries()).toBe(0);
  });
});

describe('credential faults', () => {
  it('answers 5xx (retryable) when the stored secret cannot be opened, without leaking detail', async () => {
    const src = await createSource();
    await route('alice', src.id);
    h.db.raw.prepare('UPDATE sources SET secret_envelope=? WHERE id=?').run(new Uint8Array(40), src.id);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await post(src, EVENT);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('Temporarily unavailable');
    const logged = err.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('generic_source_secret_unavailable');
    expect(logged).not.toContain(src.secret);
    err.mockRestore();
    expect(deliveries()).toBe(0);
  });

  it('a secret sealed for one source does not open under another source’s id (AAD binding)', async () => {
    const a = await createSource();
    const b = await createSource('alice', 'B');
    const rowA = h.db.raw.prepare('SELECT secret_envelope FROM sources WHERE id=?').get(a.id) as {
      secret_envelope: Uint8Array;
    };
    h.db.raw.prepare('UPDATE sources SET secret_envelope=? WHERE id=?').run(rowA.secret_envelope, b.id);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await post(b, EVENT)).status).toBe(500);
    err.mockRestore();
  });
});
