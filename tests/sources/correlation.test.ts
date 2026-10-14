import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeliveryMessage } from '../../src/env';
import { consumeDeliveries, type ConsumerDeps } from '../../src/pipeline/consumer';
import { consumeDeadLetters } from '../../src/pipeline/dead-letter';
import { parseDeliveryMessage } from '../../src/pipeline/outbox';
import { EVENT, SLACK, caller, setup, signHeaders, type CreatedSource, type Harness } from './harness';

vi.mock('../../src/auth/better-auth', async () => (await import('./harness')).mockAuth());

const { default: worker } = await import('../../src/index');

/**
 * F193: the correlation id minted at ingress travels onto D1 rows, the queue message, the consumer's
 * log lines and the delivery API, and can be used to find the delivery again (workspace-scoped).
 */
let h: Harness;
const call = caller(worker, () => h);

async function createSource(as = 'alice'): Promise<CreatedSource> {
  const res = await call('POST', '/api/sources', { as, body: { name: 'CI pipeline' } });
  expect(res.status).toBe(201);
  const body = await res.json<{
    source: { id: string; endpointId: string; endpointUrl: string };
    secret: string;
  }>();
  return { ...body.source, secret: body.secret };
}

async function route(as: string, sourceId: string): Promise<string> {
  const res = await call('POST', '/api/integrations', {
    as,
    body: { name: 'to slack', sourceId, destination: 'slack', webhookUrl: SLACK },
  });
  expect(res.status).toBe(201);
  return (await res.json<{ integration: { id: string } }>()).integration.id;
}

async function post(src: CreatedSource, eventId: string, extraHeaders: Record<string, string> = {}) {
  const text = JSON.stringify(EVENT);
  const headers = new Headers({
    ...signHeaders(src.secret, text, { id: eventId }),
    'content-type': 'application/json',
    ...extraHeaders,
  });
  return worker.fetch(
    new Request(`https://noti.test/webhooks/generic/${src.endpointId}`, {
      method: 'POST',
      headers,
      body: text,
    }),
    h.env,
    { waitUntil: h.waitUntil, passThroughOnException: () => undefined } as unknown as ExecutionContext,
  );
}

const deps: ConsumerDeps = {
  random: () => 0.5,
  now: () => Date.now(),
  newClaimToken: () => crypto.randomUUID(),
};

async function consume(body: unknown): Promise<void> {
  const msg = { body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
  await consumeDeliveries(
    { messages: [msg], retryAll: () => undefined } as unknown as MessageBatch<unknown>,
    h.env,
    deps,
  );
}

function outboxMessages(): DeliveryMessage[] {
  return (
    h.db.raw.prepare('SELECT payload_json FROM notification_outbox ORDER BY rowid').all() as {
      payload_json: string;
    }[]
  ).map((r) => JSON.parse(r.payload_json) as DeliveryMessage);
}

function logLines(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return (spy.mock.calls as unknown[][]).map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
}

beforeEach(() => {
  h = setup();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ingress to rows to queue to consumer log', () => {
  it('carries the id the sender got back as x-request-id onto every row, the message and the consumer log', async () => {
    const src = await createSource();
    await route('alice', src.id);
    const res = await post(src, 'evt_1');
    expect(res.status).toBe(202);
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    expect(h.db.raw.prepare('SELECT correlation_id AS c FROM deliveries').get()).toEqual({ c: id });
    expect(h.db.raw.prepare('SELECT correlation_id AS c FROM notification_outbox').get()).toEqual({ c: id });
    const [message] = outboxMessages();
    expect(message?.correlationId).toBe(id);

    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    h.fetchMock.mockClear();
    await consume(message);
    const attempt = logLines(info).find((l) => l.msg === 'delivery_attempt');
    expect(attempt?.correlation_id).toBe(id);
    expect(h.db.raw.prepare('SELECT correlation_id AS c FROM delivery_attempts').get()).toEqual({ c: id });
  });

  it('never takes the id from the sender: x-request-id is recorded as external, ours is minted', async () => {
    const src = await createSource();
    await route('alice', src.id);
    const res = await post(src, 'evt_2', { 'x-request-id': 'attacker-chosen-1' });
    const id = res.headers.get('x-request-id');
    expect(id).not.toBe('attacker-chosen-1');
    expect(h.db.raw.prepare('SELECT correlation_id AS c FROM deliveries').get()).toEqual({ c: id });
  });

  it('a legacy message with no id still delivers, and its log lines carry none', async () => {
    const src = await createSource();
    await route('alice', src.id);
    await post(src, 'evt_3');
    const { correlationId: _dropped, ...legacy } = outboxMessages()[0] as DeliveryMessage;
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await consume(legacy);
    const attempt = logLines(info).find((l) => l.msg === 'delivery_attempt');
    expect(attempt).toBeDefined();
    expect(attempt).not.toHaveProperty('correlation_id');
    expect(h.db.raw.prepare("SELECT state FROM deliveries WHERE state<>'suppressed'").get()).toEqual({
      state: 'sent',
    });
  });

  it('drops a malformed id from a queue message instead of repairing it', () => {
    const base = { id: 'd', integrationId: 'i', organizationId: 'o' };
    expect(parseDeliveryMessage({ ...base, correlationId: 'ok-id-1234' })?.correlationId).toBe('ok-id-1234');
    for (const bad of ['', 'abc', 'x'.repeat(65), 'has space 1234', 'new\nline-1234', 42, { a: 1 }]) {
      expect(parseDeliveryMessage({ ...base, correlationId: bad })).not.toHaveProperty('correlationId');
    }
  });

  it('the dead-letter consumer logs under the id of the message it moves', async () => {
    const src = await createSource();
    await route('alice', src.id);
    const res = await post(src, 'evt_4');
    const id = res.headers.get('x-request-id');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const msg = { body: outboxMessages()[0], attempts: 6, ack: vi.fn(), retry: vi.fn() };
    await consumeDeadLetters({ messages: [msg] } as unknown as MessageBatch<unknown>, h.env);
    expect(msg.ack).toHaveBeenCalled();
    expect(logLines(warn).find((l) => l.msg === 'delivery_dead_lettered_by_queue')?.correlation_id).toBe(id);
    const run = h.db.raw.prepare("SELECT value FROM ops_state WHERE key='dlq_consumer'").get() as {
      value: string;
    };
    expect(JSON.parse(run.value)).toMatchObject({ seen: 1, moved: 1 });
  });
});

describe('lookup by correlation id', () => {
  async function ingest(): Promise<{ id: string; deliveryId: string }> {
    const src = await createSource();
    await route('alice', src.id);
    const res = await post(src, `evt_${Math.random().toString(36).slice(2)}`);
    const id = res.headers.get('x-request-id') ?? '';
    const row = h.db.raw.prepare('SELECT id FROM deliveries WHERE correlation_id=?').get(id) as {
      id: string;
    };
    return { id, deliveryId: row.id };
  }

  it('finds the delivery, for an admin and for a member, and shows the id in the list and the detail', async () => {
    const { id, deliveryId } = await ingest();
    for (const as of ['alice', 'bob']) {
      const list = await call('GET', `/api/deliveries?correlationId=${id}`, { as, org: 'org-a' });
      expect(list.status).toBe(200);
      const body = await list.json<{ deliveries: { id: string; correlationId: string }[] }>();
      expect(body.deliveries.map((d) => [d.id, d.correlationId])).toEqual([[deliveryId, id]]);
    }
    const detail = await call('GET', `/api/deliveries/${deliveryId}`, { as: 'alice', org: 'org-a' });
    expect((await detail.json<{ delivery: { correlationId: string } }>()).delivery.correlationId).toBe(id);
  });

  it('is workspace-scoped: another workspace finds nothing, and the id reveals nothing about the row', async () => {
    const { id } = await ingest();
    const other = await call('GET', `/api/deliveries?correlationId=${id}`, { as: 'mallory', org: 'org-b' });
    expect(other.status).toBe(200);
    expect(await other.json()).toMatchObject({ deliveries: [] });
    const unknown = await call('GET', '/api/deliveries?correlationId=00000000-0000-4000-8000-000000000000', {
      as: 'alice',
      org: 'org-a',
    });
    expect(await unknown.json()).toMatchObject({ deliveries: [] });
  });

  it('refuses a malformed id with a field error, not an empty list', async () => {
    const res = await call('GET', '/api/deliveries?correlationId=%27%20OR%201%3D1', {
      as: 'alice',
      org: 'org-a',
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ fields: [{ field: 'correlationId' }] });
  });

  it('the API list query for a correlation id seeks deliveries_org_correlation, never a workspace walk', async () => {
    const { buildListQuery } = await import('../../src/api/delivery-queries');
    const q = buildListQuery('org-a', {
      state: null,
      integrationId: null,
      correlationId: 'c0ffee00-0000-4000-8000-000000000000',
      from: null,
      to: null,
      cursor: null,
      limit: 25,
    });
    const plan = (
      h.db.raw.prepare(`EXPLAIN QUERY PLAN ${q.sql.replace(/\?/g, "'x'")}`).all() as { detail: string }[]
    ).map((p) => p.detail);
    const text = plan.join('\n');
    expect(text).toMatch(/deliveries_org_correlation/);
    expect(text).not.toMatch(/deliveries_org_updated/);
    expect(plan.filter((d) => /^SCAN (TABLE )?deliveries\b/.test(d))).toEqual([]);
    // The operator's cross-workspace lookup uses the id-first index.
    const operator = h.db.raw
      .prepare("EXPLAIN QUERY PLAN SELECT id FROM deliveries WHERE correlation_id = 'c'")
      .all() as { detail: string }[];
    expect(operator.map((p) => p.detail).join('\n')).toMatch(/deliveries_correlation\b/);
  });

  it('a replay carries the id of the replay request, never the original ingress id', async () => {
    const { id, deliveryId } = await ingest();
    h.db.raw
      .prepare(
        "UPDATE deliveries SET state='dead_lettered', dead_lettered_at=1, last_error_code='destination_unavailable' WHERE id=?",
      )
      .run(deliveryId);
    const res = await call('POST', `/api/deliveries/${deliveryId}/replay`, { as: 'alice', org: 'org-a' });
    expect(res.status).toBeLessThan(300);
    const replayId = res.headers.get('x-request-id');
    expect(replayId).not.toBe(id);
    const replay = h.db.raw
      .prepare('SELECT correlation_id AS c FROM deliveries WHERE replay_of=?')
      .get(deliveryId) as { c: string };
    expect(replay.c).toBe(replayId);
    const message = outboxMessages().find((m) => m.correlationId === replayId);
    expect(message).toBeDefined();
  });
});
