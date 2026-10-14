import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  BREAKER_FAILURE_THRESHOLD,
  BREAKER_OPEN_MS,
  PROBE_LEASE_MS,
  effectOf,
  gateAttempt,
  paceFromResponse,
  DEFAULT_PACE_MS,
  MAX_PACE_MS,
} from '../../src/delivery/health';
import { listAttempts } from '../../src/delivery/attempts';
import type { Bindings, DeliveryMessage } from '../../src/env';
import { sweepStaleClaims } from '../../src/pipeline/sweep';
import { consumeDeliveries, type ConsumerDeps } from '../../src/pipeline/consumer';
import { PURGE_DELIVERIES_SQL, purgeExpiredRecords } from '../../src/pipeline/retention';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';
import { legacySeal } from '../support/legacy';

/**
 * Delivery ledger depth over the real migrations (ADR 0023): per-attempt rows (F184), the possible
 * duplicate flag (F185), and the circuit breaker and pacing (F183, F187).
 */
const K_LEGACY = 'aa'.repeat(32);
const LARK = 'https://open.larksuite.com/open-apis/bot/v2/hook/ledger-depth-fixture';
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

let db: FakeD1;
let env: Bindings;
let fetchMock: Mock<typeof fetch>;
let clock: number;
let claimTokens: number;

function makeEnv(): Bindings {
  return {
    DB: db.d1,
    DELIVERY_QUEUE: { send: () => Promise.resolve() } as unknown as Queue<DeliveryMessage>,
    GITHUB_WEBHOOK_SECRET: 'unused',
    GITHUB_APP_ID: '777',
    ENCRYPTION_KEY: K_LEGACY,
    KEK_V1: '11'.repeat(32),
    KEK_V2: '',
    KMS_ACTIVE_VERSION: '1',
  } as Bindings;
}

const deps = (): ConsumerDeps => ({
  random: () => 0.999999,
  now: () => clock,
  newClaimToken: () => `claim-${++claimTokens}`,
});

async function integration(id: string, org = 'org-a'): Promise<void> {
  db.raw
    .prepare(
      `INSERT INTO integrations(id,repo,event_types,destination,destination_host,webhook_ciphertext,organization_id)
       VALUES(?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      'acme/web',
      '["issues.opened"]',
      'lark',
      'open.larksuite.com',
      await legacySeal(LARK, K_LEGACY),
      org,
    );
}

function enqueue(id: string, integrationId = 'int-a', org = 'org-a', isTest = 0): DeliveryMessage {
  const message: DeliveryMessage = {
    id,
    integrationId,
    organizationId: org,
    title: 'T',
    url: 'https://x.test/1',
  };
  db.raw
    .prepare(
      "INSERT INTO deliveries(id,integration_id,organization_id,state,created_at,is_test) VALUES(?,?,?,'pending','2026',?)",
    )
    .run(id, integrationId, org, isTest);
  db.raw
    .prepare('INSERT INTO notification_outbox(id,organization_id,payload_json) VALUES(?,?,?)')
    .run(id, org, JSON.stringify(message));
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

function message(body: unknown, attempts = 1): FakeMessage {
  return {
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
}

async function consume(body: unknown, attempts = 1): Promise<FakeMessage> {
  const msg = message(body, attempts);
  await consumeDeliveries(
    { messages: [msg], retryAll: () => undefined } as unknown as MessageBatch<unknown>,
    env,
    deps(),
  );
  return msg;
}

/** Enqueue a fresh delivery and consume it. */
async function send(id: string, integrationId = 'int-a', org = 'org-a', isTest = 0): Promise<FakeMessage> {
  return consume(enqueue(id, integrationId, org, isTest));
}

const delivery = (id: string) =>
  db.raw
    .prepare(
      'SELECT state,attempts,last_error,last_error_code,next_attempt_at,possible_duplicate,first_attempt_at FROM deliveries WHERE id=?',
    )
    .get(id) as {
    state: string;
    attempts: number;
    last_error: string | null;
    last_error_code: string | null;
    next_attempt_at: number | null;
    possible_duplicate: number;
    first_attempt_at: number | null;
  };

const attemptRows = (id: string) =>
  db.raw
    .prepare(
      'SELECT attempt,outcome,error_code,reason,status_class,retry_after_ms,possible_duplicate,started_at,finished_at FROM delivery_attempts WHERE delivery_id=? ORDER BY rowid',
    )
    .all(id) as {
    attempt: number;
    outcome: string;
    error_code: string | null;
    reason: string | null;
    status_class: string;
    retry_after_ms: number | null;
    possible_duplicate: number;
    started_at: number;
    finished_at: number;
  }[];

const health = (integrationId = 'int-a', org = 'org-a') =>
  db.raw
    .prepare('SELECT * FROM destination_health WHERE organization_id=? AND integration_id=?')
    .get(org, integrationId) as
    | {
        state: string;
        consecutive_failures: number;
        open_until: number | null;
        probe_until: number | null;
        paused_until: number | null;
        opened_count: number;
        last_failure_code: string | null;
        destination_host: string | null;
      }
    | undefined;

const ok = (): Response => new Response(JSON.stringify({ code: 0 }), { status: 200 });
const unavailable = (): Response => new Response('', { status: 503 });

beforeEach(async () => {
  db = createFakeD1();
  clock = NOW;
  claimTokens = 0;
  seedOrganization(db.raw, 'org-a');
  seedOrganization(db.raw, 'org-b');
  env = makeEnv();
  fetchMock = vi.fn(() => Promise.resolve(ok()));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await integration('int-a');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('delivery attempts (F184)', () => {
  it('ledger_records_every_attempt: a delivered send leaves one row with the status class', async () => {
    await send('d1');
    expect(delivery('d1').state).toBe('sent');
    expect(attemptRows('d1')).toEqual([
      {
        attempt: 1,
        outcome: 'delivered',
        error_code: null,
        reason: null,
        status_class: '2xx',
        retry_after_ms: null,
        possible_duplicate: 0,
        started_at: NOW,
        finished_at: NOW,
      },
    ]);
  });

  it('a retried delivery records each attempt in order, with the minted reason and code only', async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(unavailable()));
    const body = enqueue('d1');
    const first = await consume(body);
    expect(first.retried).not.toBeNull();
    expect(delivery('d1')).toMatchObject({ state: 'retrying', attempts: 1 });
    clock += 60_000;
    await consume(body);
    expect(delivery('d1')).toMatchObject({ state: 'sent', attempts: 2 });
    const rows = attemptRows('d1');
    expect(rows.map((r) => [r.attempt, r.outcome, r.status_class])).toEqual([
      [1, 'retry_scheduled', '5xx'],
      [2, 'delivered', '2xx'],
    ]);
    expect(rows[0]).toMatchObject({ error_code: 'destination_unavailable', reason: 'provider_http_503' });
  });

  it('a permanent failure is one dead_lettered attempt', async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response('', { status: 404 })));
    await send('d1');
    const row = delivery('d1');
    expect(row.state).toBe('dead_lettered');
    expect(attemptRows('d1').map((r) => r.outcome)).toEqual(['dead_lettered']);
  });

  it('stores nothing from the provider or the destination: no URL, host path, body or header text', async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(new Response('secret-body https://open.larksuite.com/hook/x', { status: 500 })),
    );
    await send('d1');
    const dump = JSON.stringify(db.raw.prepare('SELECT * FROM delivery_attempts').all());
    expect(dump).not.toContain('ledger-depth-fixture');
    expect(dump).not.toContain('secret-body');
    expect(dump).not.toContain('https://');
  });

  it('a double-consumed message records one attempt and sends once', async () => {
    const body = enqueue('d1');
    await Promise.all([consume(body), consume(body)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(attemptRows('d1')).toHaveLength(1);
  });

  it('a consumer that lost its claim records no attempt and leaves the health row alone', async () => {
    const body = enqueue('d1');
    fetchMock.mockImplementationOnce(() => {
      // The claim is taken over mid-send (lease expiry elsewhere).
      db.raw.prepare("UPDATE deliveries SET claim_token='someone-else' WHERE id='d1'").run();
      return Promise.resolve(unavailable());
    });
    await consume(body);
    expect(attemptRows('d1')).toEqual([]);
    expect(health()).toBeUndefined();
  });

  it('is tenant scoped: another workspace cannot read the attempts', async () => {
    await send('d1');
    expect(await listAttempts(db.d1, 'org-b', 'd1')).toEqual([]);
    expect(await listAttempts(db.d1, 'org-a', 'd1')).toHaveLength(1);
  });

  it('retention deletes the attempts with their delivery and never strands them', async () => {
    await send('d1');
    await send('d2');
    // Both deliveries are old and terminal; only d1 is past retention.
    db.raw.prepare("UPDATE deliveries SET created_at='2020-01-01 00:00:00' WHERE id='d1'").run();
    db.raw.prepare("UPDATE deliveries SET created_at='2026-10-14 11:00:00' WHERE id='d2'").run();
    db.raw.prepare("UPDATE delivery_attempts SET started_at=1000 WHERE delivery_id='d1'").run();
    const report = await purgeExpiredRecords(
      { DB: db.d1, DELIVERY_RETENTION_DAYS: '90', AUDIT_RETENTION_DAYS: '365' },
      NOW,
    );
    expect(report).toMatchObject({ deliveries: 1, attempts: 1 });
    expect(attemptRows('d1')).toEqual([]);
    expect(attemptRows('d2')).toHaveLength(1);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE id='d1'").get()).toEqual({ n: 0 });
  });

  it('a delivery is not purged while attempt rows remain', async () => {
    await send('d1');
    db.raw.prepare("UPDATE deliveries SET created_at='2020-01-01 00:00:00' WHERE id='d1'").run();
    const res = await db.d1.prepare(PURGE_DELIVERIES_SQL).bind('2026-01-01 00:00:00', NOW, 500).run();
    expect(res.meta.changes).toBe(0);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE id='d1'").get()).toEqual({ n: 1 });
  });
});

describe('possible duplicate (F185)', () => {
  it('flags a retry that follows an unconfirmed attempt, and keeps the flag after delivery', async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(unavailable()));
    const body = enqueue('d1');
    await consume(body);
    expect(delivery('d1').possible_duplicate).toBe(1);
    expect(attemptRows('d1')[0]?.possible_duplicate).toBe(1);
    clock += 60_000;
    await consume(body);
    expect(delivery('d1')).toMatchObject({ state: 'sent', possible_duplicate: 1 });
  });

  it('a provider that says it did NOT process the request (4xx) is not a possible duplicate', async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '30' } })),
    );
    await send('d1');
    expect(delivery('d1')).toMatchObject({ state: 'retrying', possible_duplicate: 0 });
  });

  it('an attempt abandoned mid-send (claim expired, swept) may have reached the provider', async () => {
    enqueue('d1');
    db.raw
      .prepare("UPDATE deliveries SET state='claimed',claim_token='dead',claimed_at=? WHERE id='d1'")
      .run(NOW - 10 * 60_000);
    expect(await sweepStaleClaims(env, NOW)).toBe(1);
    expect(delivery('d1')).toMatchObject({ state: 'retrying', attempts: 1, possible_duplicate: 1 });
  });

  it('a timeout or a dropped connection is unconfirmed too', async () => {
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError('network down')));
    await send('d1');
    expect(delivery('d1').possible_duplicate).toBe(1);
    expect(attemptRows('d1')[0]).toMatchObject({ status_class: 'network' });
  });
});

describe('circuit breaker (F183)', () => {
  async function failNTimes(n: number, start = 0): Promise<void> {
    for (let i = 0; i < n; i++) {
      fetchMock.mockImplementationOnce(() => Promise.resolve(unavailable()));
      await send(`f${start + i}`);
    }
  }

  it('breaker_opens_after_five_consecutive_terminal_failures', async () => {
    await failNTimes(BREAKER_FAILURE_THRESHOLD - 1);
    expect(health()).toMatchObject({ state: 'closed', consecutive_failures: BREAKER_FAILURE_THRESHOLD - 1 });
    await failNTimes(1, 99);
    expect(health()).toMatchObject({
      state: 'open',
      opened_count: 1,
      open_until: NOW + BREAKER_OPEN_MS,
      last_failure_code: 'destination_unavailable',
      destination_host: 'open.larksuite.com',
    });
  });

  it('a success in between resets the count', async () => {
    await failNTimes(3);
    await send('ok1');
    expect(health()).toMatchObject({ state: 'closed', consecutive_failures: 0 });
  });

  it('breaker_fails_fast_without_retaining_the_invocation: no request, no attempt spent, nothing dead-lettered', async () => {
    await failNTimes(BREAKER_FAILURE_THRESHOLD);
    fetchMock.mockClear();
    clock += 1_000;
    const msg = await send('later');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(delivery('later')).toMatchObject({
      state: 'retrying',
      attempts: 0,
      last_error: 'circuit_open',
      last_error_code: 'destination_unavailable',
      first_attempt_at: null,
      next_attempt_at: NOW + BREAKER_OPEN_MS,
    });
    expect(msg.retried).toEqual({ delaySeconds: Math.ceil((BREAKER_OPEN_MS - 1_000) / 1000) });
    expect(attemptRows('later')).toMatchObject([
      {
        outcome: 'deferred',
        reason: 'circuit_open',
        error_code: 'destination_unavailable',
        status_class: 'none',
      },
    ]);
  });

  it('a deferral far beyond the queue retries parks the outbox row instead of retrying', async () => {
    await failNTimes(BREAKER_FAILURE_THRESHOLD);
    const body = enqueue('late');
    const msg = message(body, 5);
    await consumeDeliveries(
      { messages: [msg], retryAll: () => undefined } as unknown as MessageBatch<unknown>,
      env,
      deps(),
    );
    expect(msg.retried).toBeNull();
    expect(msg.acked).toBe(true);
    expect(db.raw.prepare("SELECT state,not_before FROM notification_outbox WHERE id='late'").get()).toEqual({
      state: 'pending',
      not_before: NOW + BREAKER_OPEN_MS,
    });
  });

  it('two gates racing for the probe: one wins', async () => {
    await failNTimes(BREAKER_FAILURE_THRESHOLD);
    const at = NOW + BREAKER_OPEN_MS;
    const gates = await Promise.all([
      gateAttempt(db.d1, { organizationId: 'org-a', integrationId: 'int-a' }, at),
      gateAttempt(db.d1, { organizationId: 'org-a', integrationId: 'int-a' }, at),
    ]);
    expect(gates.filter((g) => g.action === 'proceed' && g.probe)).toHaveLength(1);
    expect(gates.filter((g) => g.action === 'defer')).toHaveLength(1);
    expect(health()).toMatchObject({ state: 'half_open', probe_until: at + PROBE_LEASE_MS });
  });

  it('a successful probe closes the breaker', async () => {
    await failNTimes(BREAKER_FAILURE_THRESHOLD);
    clock = NOW + BREAKER_OPEN_MS;
    await send('probe');
    expect(delivery('probe').state).toBe('sent');
    expect(health()).toMatchObject({
      state: 'closed',
      consecutive_failures: 0,
      open_until: null,
      probe_until: null,
    });
  });

  it('a failed probe reopens it for another full period', async () => {
    await failNTimes(BREAKER_FAILURE_THRESHOLD);
    clock = NOW + BREAKER_OPEN_MS;
    fetchMock.mockImplementationOnce(() => Promise.resolve(unavailable()));
    await send('probe');
    expect(health()).toMatchObject({
      state: 'open',
      opened_count: 2,
      open_until: NOW + 2 * BREAKER_OPEN_MS,
    });
  });

  it('a probe that proved nothing (our own fault) releases the slot for the next consumer', async () => {
    await failNTimes(BREAKER_FAILURE_THRESHOLD);
    clock = NOW + BREAKER_OPEN_MS;
    db.raw
      .prepare("UPDATE integrations SET enabled=1,credentials_quarantined_at=NULL WHERE id='int-a'")
      .run();
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error('should not be reached')));
    // Make the target unresolvable so the attempt fails before any request (neutral).
    db.raw.prepare("UPDATE integrations SET webhook_ciphertext='garbage' WHERE id='int-a'").run();
    await send('probe');
    const h = health();
    expect(h?.state).toBe('open');
    expect(h?.open_until).toBe(NOW + BREAKER_OPEN_MS);
    expect(h?.probe_until).toBeNull();
  });

  it('breaker_never_auto_disables_a_destination', async () => {
    await failNTimes(BREAKER_FAILURE_THRESHOLD + 3);
    expect(db.raw.prepare("SELECT enabled FROM integrations WHERE id='int-a'").get()).toEqual({ enabled: 1 });
  });

  it('never opens on answers that are not health failures: 4xx and rate limits reset the count', async () => {
    await failNTimes(3);
    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response('', { status: 404 })));
    await send('perm');
    expect(health()).toMatchObject({ state: 'closed', consecutive_failures: 0 });
  });

  it('one workspace opening its breaker never affects another workspace on the same host', async () => {
    await integration('int-b', 'org-b');
    await failNTimes(BREAKER_FAILURE_THRESHOLD);
    fetchMock.mockClear();
    clock += 1_000;
    await send('other', 'int-b', 'org-b');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(delivery('other').state).toBe('sent');
    expect(health('int-b', 'org-b')).toBeUndefined();
  });

  it('a test notification neither reads nor changes the breaker', async () => {
    await failNTimes(BREAKER_FAILURE_THRESHOLD);
    fetchMock.mockClear();
    clock += 1_000;
    await send('t1', 'int-a', 'org-a', 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(delivery('t1').state).toBe('sent');
    expect(health()).toMatchObject({ state: 'open', consecutive_failures: BREAKER_FAILURE_THRESHOLD });
    // And a failing test does not count either.
    fetchMock.mockImplementationOnce(() => Promise.resolve(unavailable()));
    await send('t2', 'int-a', 'org-a', 1);
    expect(health()?.consecutive_failures).toBe(BREAKER_FAILURE_THRESHOLD);
  });

  it('breaker state is rebuildable: a cold start with no rows begins closed', async () => {
    expect(await gateAttempt(db.d1, { organizationId: 'org-a', integrationId: 'int-a' }, NOW)).toEqual({
      action: 'proceed',
      probe: false,
      known: false,
    });
  });

  it('a health table that cannot be read never stops deliveries (fails open)', async () => {
    db.raw.exec('ALTER TABLE destination_health RENAME TO destination_health_gone');
    await send('d1');
    expect(delivery('d1').state).toBe('sent');
    db.raw.exec('ALTER TABLE destination_health_gone RENAME TO destination_health');
  });
});

describe('outbound pacing (F187)', () => {
  it('a 429 with Retry-After pauses the destination, and the next delivery waits without a request', async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '30' } })),
    );
    await send('d1');
    expect(health()).toMatchObject({ state: 'closed', consecutive_failures: 0, paused_until: NOW + 30_000 });
    fetchMock.mockClear();
    clock += 5_000;
    await send('d2');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(delivery('d2')).toMatchObject({
      state: 'retrying',
      attempts: 0,
      last_error: 'destination_paced',
      last_error_code: 'destination_rate_limited',
      next_attempt_at: NOW + 30_000,
    });
    expect(attemptRows('d2')[0]).toMatchObject({ outcome: 'deferred', reason: 'destination_paced' });
    clock = NOW + 31_000;
    await send('d3');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('x-ratelimit-remaining: 0 on a SUCCESS paces the next send by the reset header', async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 0 }), {
          status: 200,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '2.5' },
        }),
      ),
    );
    await send('d1');
    expect(delivery('d1').state).toBe('sent');
    expect(health()).toMatchObject({ paused_until: NOW + 2_500 });
    fetchMock.mockClear();
    await send('d2');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a healthy destination with no rate-limit signal writes no health row at all', async () => {
    await send('d1');
    await send('d2');
    expect(health()).toBeUndefined();
  });

  it('an open breaker and a pacing hold both defer to the later of the two', async () => {
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) {
      fetchMock.mockImplementationOnce(() => Promise.resolve(unavailable()));
      await send(`f${i}`);
    }
    db.raw.prepare('UPDATE destination_health SET paused_until=?').run(NOW + 20 * 60_000);
    const gate = await gateAttempt(db.d1, { organizationId: 'org-a', integrationId: 'int-a' }, NOW + 1_000);
    expect(gate).toEqual({ action: 'defer', untilMs: NOW + 20 * 60_000, reason: 'destination_paced' });
  });
});

describe('breaker and pacing helpers', () => {
  it('parses rate-limit headers, never hard-coding a provider limit', () => {
    const h = (m: Record<string, string>) => new Headers(m);
    expect(paceFromResponse(h({}), undefined, false, NOW)).toBeNull();
    expect(paceFromResponse(h({ 'x-ratelimit-remaining': '3' }), undefined, false, NOW)).toBeNull();
    expect(paceFromResponse(h({ 'x-ratelimit-remaining': '0' }), undefined, false, NOW)).toBe(
      DEFAULT_PACE_MS,
    );
    expect(
      paceFromResponse(
        h({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '1.2' }),
        undefined,
        false,
        NOW,
      ),
    ).toBe(1_200);
    expect(
      paceFromResponse(
        h({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(NOW / 1000) + 7) }),
        undefined,
        false,
        NOW,
      ),
    ).toBeGreaterThan(5_000);
    // A hostile reset cannot park a destination for days.
    expect(
      paceFromResponse(
        h({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '999999' }),
        undefined,
        false,
        NOW,
      ),
    ).toBe(MAX_PACE_MS);
    expect(paceFromResponse(null, 45_000, true, NOW)).toBe(45_000);
    expect(paceFromResponse(h({ 'x-ratelimit-remaining': 'abc' }), undefined, false, NOW)).toBeNull();
  });

  it('classifies what an attempt says about the destination', () => {
    expect(effectOf({ kind: 'delivered' }, '2xx')).toBe('success');
    expect(effectOf({ kind: 'failed', code: 'destination_unavailable' }, '5xx')).toBe('failure');
    expect(effectOf({ kind: 'failed', code: 'destination_timeout' }, 'timeout')).toBe('failure');
    expect(effectOf({ kind: 'failed', code: 'destination_rate_limited' }, '4xx')).toBe('success');
    expect(effectOf({ kind: 'failed', code: 'destination_revoked' }, '4xx')).toBe('success');
    expect(effectOf({ kind: 'failed', code: 'internal_error' }, 'none')).toBe('neutral');
  });
});

describe('waits are folded, bounded and never hide the outcome (H2, M1, M7)', () => {
  const pause = (untilMs: number) =>
    db.raw
      .prepare(
        `INSERT INTO destination_health(organization_id,integration_id,state,paused_until,updated_at)
         VALUES('org-a','int-a','closed',?,?)
         ON CONFLICT(organization_id,integration_id) DO UPDATE SET paused_until=excluded.paused_until, updated_at=excluded.updated_at`,
      )
      .run(untilMs, clock);

  it('thousands of identical waits are one row, counted, not thousands of rows', async () => {
    const body = enqueue('d1');
    for (let i = 0; i < 2_000; i++) {
      pause(clock + 1_000);
      await consume(body);
      clock += 1_000;
    }
    const rows = attemptRows('d1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'deferred', reason: 'destination_paced' });
    const stored = db.raw
      .prepare('SELECT repeat_count,started_at,finished_at FROM delivery_attempts')
      .get() as { repeat_count: number; started_at: number; finished_at: number };
    expect(stored.repeat_count).toBe(1_999);
    expect(stored.finished_at).toBeGreaterThan(stored.started_at);
    // And the delivery has still not spent an attempt.
    expect(delivery('d1')).toMatchObject({ state: 'retrying', attempts: 0 });
  });

  it('a wait does not take the number of the next real attempt, and a real attempt starts a new run', async () => {
    const body = enqueue('d1');
    pause(clock + 1_000);
    await consume(body);
    expect(attemptRows('d1')[0]).toMatchObject({ attempt: 0, outcome: 'deferred' });
    clock += 2_000;
    fetchMock.mockImplementationOnce(() => Promise.resolve(unavailable()));
    await consume(body);
    clock += 60_000;
    pause(clock + 1_000);
    await consume(body);
    expect(attemptRows('d1').map((r) => [r.attempt, r.outcome])).toEqual([
      [0, 'deferred'],
      [1, 'retry_scheduled'],
      // After one real attempt the next wait records the attempts already spent.
      [1, 'deferred'],
    ]);
  });

  it('a different reason is a new row', async () => {
    const body = enqueue('d1');
    pause(clock + 1_000);
    await consume(body);
    db.raw
      .prepare(
        "UPDATE destination_health SET state='open', open_until=?, paused_until=0 WHERE integration_id='int-a'",
      )
      .run(clock + 120_000);
    clock += 2_000;
    await consume(body);
    expect(attemptRows('d1').map((r) => r.reason)).toEqual(['destination_paced', 'circuit_open']);
  });

  it('listAttempts keeps the NEWEST rows, so the final outcome is never the one cut off', async () => {
    enqueue('d1');
    const insert = db.raw.prepare(
      `INSERT INTO delivery_attempts(id,organization_id,delivery_id,integration_id,attempt,started_at,finished_at,outcome,status_class)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    );
    for (let i = 0; i < 80; i++)
      insert.run(`a${i}`, 'org-a', 'd1', 'int-a', i % 13, 1000 + i, 1000 + i, 'deferred', 'none');
    insert.run('last', 'org-a', 'd1', 'int-a', 13, 9000, 9001, 'dead_lettered', '5xx');
    const rows = await listAttempts(db.d1, 'org-a', 'd1');
    expect(rows).toHaveLength(50);
    expect(rows.at(-1)).toMatchObject({ outcome: 'dead_lettered', attempt: 13 });
    expect(rows[0]?.startedAtMs).toBeLessThan(rows.at(-1)?.startedAtMs ?? 0);
  });

  it('a delivery held back for more than a day is dead-lettered, replayable, with its reason', async () => {
    const body = enqueue('d1');
    pause(clock + 1_000);
    await consume(body);
    expect(delivery('d1').state).toBe('retrying');
    clock += 25 * 3_600_000;
    pause(clock + 1_000);
    const msg = await consume(body);
    expect(msg.acked).toBe(true);
    expect(delivery('d1')).toMatchObject({
      state: 'dead_lettered',
      attempts: 0,
      last_error_code: 'destination_unavailable',
      last_error: 'destination_paced_timeout',
    });
    expect(attemptRows('d1').at(-1)).toMatchObject({
      outcome: 'dead_lettered',
      reason: 'destination_paced_timeout',
    });
    // Replayable: the outbox message is still there.
    expect(db.raw.prepare("SELECT state FROM notification_outbox WHERE id='d1'").get()).toBeDefined();
  });

  it('a real attempt in between resets the clock: no timeout while the destination answers', async () => {
    const body = enqueue('d1');
    pause(clock + 1_000);
    await consume(body);
    clock += 23 * 3_600_000;
    fetchMock.mockImplementationOnce(() => Promise.resolve(unavailable()));
    await consume(body);
    expect(delivery('d1').state).toBe('retrying');
    clock += 23 * 3_600_000;
    pause(clock + 1_000);
    await consume(body);
    expect(delivery('d1').state).toBe('retrying');
  });
});

describe('abandoned attempts are in the log too (M6)', () => {
  it('a swept claim writes an attempt row and flags a possible duplicate (an upper bound)', async () => {
    enqueue('d1');
    db.raw
      .prepare(
        "UPDATE deliveries SET state='claimed',claim_token='dead',claimed_at=?,last_attempt_at=NULL WHERE id='d1'",
      )
      .run(NOW - 10 * 60_000);
    await sweepStaleClaims(env, NOW);
    expect(attemptRows('d1')).toMatchObject([
      {
        attempt: 1,
        outcome: 'retry_scheduled',
        reason: 'claim_expired',
        error_code: 'internal_error',
        possible_duplicate: 1,
      },
    ]);
  });
});
