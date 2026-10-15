import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { INVALID_TRIP, OPEN_MS } from '../../src/delivery/egress-guard';
import type { Bindings, DeliveryMessage } from '../../src/env';
import { consumeDeliveries, type ConsumerDeps } from '../../src/pipeline/consumer';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';
import { legacySeal } from '../support/legacy';

/** The global Discord guard through the real consumer: a tripped guard holds every tenant's delivery. */
const K_LEGACY = 'aa'.repeat(32);
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const URL_A = 'https://discord.com/api/webhooks/123456789012345678/GuardTokenA';

let db: FakeD1;
let env: Bindings;
let fetchMock: Mock<typeof fetch>;
let tokens = 0;

const deps = (): ConsumerDeps => ({
  random: () => 0.9,
  now: () => NOW,
  newClaimToken: () => `c-${++tokens}`,
});

async function seed(org: string, id: string): Promise<DeliveryMessage> {
  seedOrganization(db.raw, org);
  db.raw
    .prepare(
      `INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id) VALUES(?,?,?,?,?,?)`,
    )
    .run(`int-${id}`, 'acme/web', '["issues.opened"]', 'discord', await legacySeal(URL_A, K_LEGACY), org);
  const message: DeliveryMessage = {
    id,
    integrationId: `int-${id}`,
    organizationId: org,
    title: 'T',
    url: 'https://x.test/1',
  };
  db.raw
    .prepare(
      "INSERT INTO deliveries(id,integration_id,organization_id,state,created_at) VALUES(?,?,?,'pending','2026')",
    )
    .run(id, `int-${id}`, org);
  db.raw
    .prepare('INSERT INTO notification_outbox(id,organization_id,payload_json) VALUES(?,?,?)')
    .run(id, org, JSON.stringify(message));
  return message;
}

async function consume(body: unknown) {
  const msg = {
    body,
    attempts: 1,
    acked: false,
    retried: null as { delaySeconds?: number } | null,
    ack() {
      this.acked = true;
    },
    retry(o: { delaySeconds?: number } = {}) {
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

const delivery = (id: string) =>
  db.raw.prepare('SELECT state,attempts,last_error FROM deliveries WHERE id=?').get(id) as {
    state: string;
    attempts: number;
    last_error: string | null;
  };

beforeEach(() => {
  db = createFakeD1();
  env = {
    DB: db.d1,
    DELIVERY_QUEUE: { send: () => Promise.resolve() } as unknown as Queue<DeliveryMessage>,
    GITHUB_WEBHOOK_SECRET: 'unused',
    GITHUB_APP_ID: '777',
    ENCRYPTION_KEY: K_LEGACY,
    KEK_V1: '11'.repeat(32),
    KEK_V2: '',
    KMS_ACTIVE_VERSION: '1',
    APP_ORIGIN: 'https://noti.test',
  } as Bindings;
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Discord global guard in the consumer', () => {
  it('counts a request and its invalid answer', async () => {
    const m = await seed('org-a', 'd1');
    fetchMock.mockResolvedValue(new Response('{"message":"rate limited","retry_after":1}', { status: 429 }));
    await consume(m);
    expect(db.raw.prepare('SELECT requests, invalid FROM egress_guard_buckets').get()).toEqual({
      requests: 1,
      invalid: 1,
    });
  });

  it('a tripped guard holds another tenant too: no request, no attempt spent, nothing dead-lettered', async () => {
    db.raw
      .prepare('INSERT INTO egress_guard_buckets(provider,minute_start,requests,invalid) VALUES(?,?,?,?)')
      .run('discord', Math.floor(NOW / 60_000) * 60_000, INVALID_TRIP, INVALID_TRIP);
    const m = await seed('org-b', 'other-tenant');
    const msg = await consume(m);
    expect(fetchMock).not.toHaveBeenCalled();
    const row = delivery('other-tenant');
    expect(row).toEqual({ state: 'retrying', attempts: 0, last_error: 'platform_paused' });
    expect(msg.retried ?? msg.acked).toBeTruthy();
    const attempt = db.raw
      .prepare('SELECT outcome, reason, error_code FROM delivery_attempts WHERE delivery_id=?')
      .get('other-tenant') as { outcome: string; reason: string };
    expect(attempt.outcome).toBe('deferred');
    expect(attempt.reason).toBe('platform_paused');
    // The delivery waits until the guard closes.
    const next = db.raw.prepare('SELECT next_attempt_at FROM deliveries WHERE id=?').get('other-tenant') as {
      next_attempt_at: number;
    };
    expect(next.next_attempt_at).toBeGreaterThanOrEqual(NOW + OPEN_MS - 1000);
  });

  it('a guard fault fails open: the delivery is still attempted', async () => {
    const m = await seed('org-a', 'open');
    db.raw.exec('DROP TABLE egress_guard_state');
    fetchMock.mockResolvedValue(new Response('{"id":"1"}', { status: 200 }));
    await consume(m);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(delivery('open').state).toBe('sent');
  });
});
