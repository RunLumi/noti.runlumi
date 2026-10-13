import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import {
  MARK_DISPATCHED_SQL,
  RELEASE_BACKOFF_MS,
  SELECT_DUE_WORKSPACES_SQL,
  markDispatchedParams,
} from '../../src/delivery/claim';
import { dedupKey, deliveryId } from '../../src/delivery/ids';
import { redeliver } from '../../src/delivery/redeliver';
import type { Bindings, DeliveryMessage } from '../../src/env';
import {
  KEYRING_RETRY_DELAY_SECONDS,
  QUEUE_MAX_RETRIES,
  consumeDeliveries,
  type ConsumerDeps,
} from '../../src/pipeline/consumer';
import { DEAD_LETTER_QUEUE, QUEUE_EXHAUSTED, consumeDeadLetters } from '../../src/pipeline/dead-letter';
import { dispatchOutbox, purgeOutbox, type DispatchDeps } from '../../src/pipeline/outbox';
import { sweepStaleClaims } from '../../src/pipeline/sweep';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';
import { legacySeal } from '../support/legacy';

/**
 * Slice 4 — delivery reliability over the real migrations (F172–F184, D4, D10, D11).
 */
const K_LEGACY = 'aa'.repeat(32);
const LARK = 'https://open.larksuite.com/open-apis/bot/v2/hook/reliability-fixture';
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const HOUR_MS = 3_600_000;
/** Synthetic signing fixture, assembled at runtime like delivery-path.test.ts. */
const HMAC_FIXTURE = ['reliability', 'hmac', 'fixture'].join('-');

let db: FakeD1;
let sent: DeliveryMessage[];
let env: Bindings;
let fetchMock: ReturnType<typeof vi.fn>;
let clock: number;
let tokens: number;

function makeEnv(send?: (m: DeliveryMessage) => Promise<void>): Bindings {
  return {
    DB: db.d1,
    DELIVERY_QUEUE: {
      send:
        send ??
        ((m: DeliveryMessage) => {
          sent.push(m);
          return Promise.resolve();
        }),
    } as unknown as Queue<DeliveryMessage>,
    GITHUB_WEBHOOK_SECRET: 'unused',
    GITHUB_APP_ID: '777',
    ENCRYPTION_KEY: K_LEGACY,
    KEK_V1: '11'.repeat(32),
    KEK_V2: '',
    KMS_ACTIVE_VERSION: '1',
  } as Bindings;
}

const dispatchDeps = (): DispatchDeps => ({ now: () => clock, newLeaseToken: () => `lease-${++tokens}` });
let claimTokens = 0;
const consumerDeps = (random = 0.999999): ConsumerDeps => ({
  random: () => random,
  now: () => clock,
  newClaimToken: () => `claim-${++claimTokens}`,
});

/** A D1 whose `prepare` runs `hook` first for statements matching `pattern`. */
function hookedDb(pattern: RegExp, hook: () => void, times = 1): D1Database {
  let remaining = times;
  return {
    ...db.d1,
    batch: db.d1.batch.bind(db.d1),
    prepare: (sql: string) => {
      if (remaining > 0 && pattern.test(sql)) {
        remaining--;
        hook();
      }
      return db.d1.prepare(sql);
    },
  } as D1Database;
}

async function integration(id: string, org = 'org-a'): Promise<void> {
  db.raw
    .prepare(
      `INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id)
       VALUES(?,?,?,?,?,?)`,
    )
    .run(id, 'acme/web', '["issues.opened"]', 'lark', await legacySeal(LARK, K_LEGACY), org);
}

/** Write a delivery + outbox row the way ingress does, under an explicit id. */
function enqueue(id: string, integrationId = 'int-a', org = 'org-a', state = 'pending'): DeliveryMessage {
  const message: DeliveryMessage = {
    id,
    integrationId,
    organizationId: org,
    title: 'T',
    url: 'https://x.test/1',
  };
  db.raw
    .prepare(
      "INSERT INTO deliveries(id,integration_id,organization_id,state,created_at) VALUES(?,?,?,?,'2026')",
    )
    .run(id, integrationId, org, state);
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

async function consume(msg: FakeMessage, random?: number): Promise<FakeMessage> {
  const batch = { messages: [msg], retryAll: () => undefined } as unknown as MessageBatch<unknown>;
  await consumeDeliveries(batch, env, consumerDeps(random));
  return msg;
}

type Row = {
  state: string;
  attempts: number;
  last_error: string | null;
  last_error_code: string | null;
  next_attempt_at: number | null;
  dead_lettered_at: number | null;
  replay_of: string | null;
};

function row(id: string): Row | undefined {
  return db.raw
    .prepare(
      'SELECT state,attempts,last_error,last_error_code,next_attempt_at,dead_lettered_at,replay_of FROM deliveries WHERE id=?',
    )
    .get(id) as Row | undefined;
}

function outbox(id: string): { state: string; not_before: number | null; lease_token: string | null } {
  return db.raw
    .prepare('SELECT state,not_before,lease_token FROM notification_outbox WHERE id=?')
    .get(id) as {
    state: string;
    not_before: number | null;
    lease_token: string | null;
  };
}

const ok = (): Response => new Response(JSON.stringify({ code: 0 }), { status: 200 });

beforeEach(async () => {
  db = createFakeD1();
  sent = [];
  clock = NOW;
  tokens = 0;
  seedOrganization(db.raw, 'org-a');
  seedOrganization(db.raw, 'org-b');
  env = makeEnv();
  fetchMock = vi.fn(() => Promise.resolve(ok()));
  vi.stubGlobal('fetch', fetchMock);
  await integration('int-a');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('atomic outbox claim (F172, D4)', () => {
  it('two_concurrent_dispatchers_claim_each_row_exactly_one_time', async () => {
    enqueue('d1');
    enqueue('d2');
    const [a, b] = await Promise.all([
      dispatchOutbox(env, dispatchDeps()),
      dispatchOutbox(env, dispatchDeps()),
    ]);
    expect(sent.map((m) => m.id).sort()).toEqual(['d1', 'd2']);
    expect(a.dispatched + b.dispatched).toBe(2);
    expect(a.lostRace + b.lostRace).toBe(2);
    expect(outbox('d1').state).toBe('dispatched');
  });

  it('a send failure releases the row for the reconciler', async () => {
    enqueue('d1');
    env = makeEnv(() => Promise.reject(new Error('Too Many Requests')));
    const report = await dispatchOutbox(env, dispatchDeps());
    expect(report.released).toBe(1);
    expect(outbox('d1')).toEqual({
      state: 'pending',
      not_before: NOW + RELEASE_BACKOFF_MS,
      lease_token: null,
    });
  });

  it('crashed_claim_is_reclaimed_after_lease_expiry, and the stale holder is fenced out', async () => {
    enqueue('d1');
    db.raw
      .prepare(
        "UPDATE notification_outbox SET state='claimed',lease_token='dead',lease_expires_at=? WHERE id='d1'",
      )
      .run(NOW - 1);
    enqueue('d2');
    db.raw
      .prepare(
        "UPDATE notification_outbox SET state='claimed',lease_token='live',lease_expires_at=? WHERE id='d2'",
      )
      .run(NOW + 60_000);

    const report = await dispatchOutbox(env, dispatchDeps());
    expect(report).toMatchObject({ reclaimed: 1, dispatched: 1 });
    expect(sent.map((m) => m.id)).toEqual(['d1']);
    expect(outbox('d2').state).toBe('claimed');

    const stale = await db.d1
      .prepare(MARK_DISPATCHED_SQL)
      .bind(...markDispatchedParams('org-a', 'd2', { token: 'dead', claimedAtMs: 0, expiresAtMs: 0 }, 'now'))
      .run();
    expect(stale.meta.changes).toBe(0);
  });

  it('marks an unparseable or foreign payload invalid instead of retrying it forever', async () => {
    enqueue('d1');
    db.raw.prepare("UPDATE notification_outbox SET payload_json='nope' WHERE id='d1'").run();
    enqueue('d2');
    db.raw
      .prepare('UPDATE notification_outbox SET payload_json=? WHERE id=?')
      .run(JSON.stringify({ id: 'd2', integrationId: 'int-a', organizationId: 'org-b' }), 'd2');
    expect((await dispatchOutbox(env, dispatchDeps())).invalid).toBe(2);
    expect(sent).toEqual([]);
  });

  it('never routes a row that has no tenant', async () => {
    db.raw
      .prepare("INSERT INTO notification_outbox(id,payload_json) VALUES('orphan',?)")
      .run(JSON.stringify({ id: 'orphan', integrationId: 'int-a', organizationId: 'org-a' }));
    expect((await dispatchOutbox(env, dispatchDeps())).workspaces).toBe(0);
  });
});

describe('consumer retry policy (F175–F180, D11)', () => {
  it('delivers once and records the attempt', async () => {
    const m = enqueue('d1');
    const msg = await consume(message(m));
    expect(msg.acked).toBe(true);
    expect(row('d1')).toMatchObject({ state: 'sent', attempts: 1, last_error_code: null });
  });

  it('walks the Tier 1 ladder with the injected random source', async () => {
    const m = enqueue('d1');
    fetchMock.mockImplementation(() => Promise.resolve(new Response('', { status: 503 })));
    const delays: (number | undefined)[] = [];
    for (let attempt = 1; attempt < QUEUE_MAX_RETRIES; attempt++) {
      clock = row('d1')?.next_attempt_at ?? clock;
      const msg = await consume(message(m, attempt));
      delays.push(msg.retried?.delaySeconds);
    }
    // random → 1⁻ gives the full-jitter ceiling min(900, 2·2^attempt).
    expect(delays).toEqual([4, 8, 16, 32]);
    expect(row('d1')).toMatchObject({
      state: 'retrying',
      attempts: 4,
      last_error: 'provider_http_503',
      last_error_code: 'destination_unavailable',
      next_attempt_at: NOW + (4 + 8 + 16 + 32) * 1000,
    });
  });

  it('parks a retry on the outbox once queue retries are spent, and redispatches when due', async () => {
    const m = enqueue('d1');
    db.raw.prepare("UPDATE notification_outbox SET state='dispatched' WHERE id='d1'").run();
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    const msg = await consume(message(m, QUEUE_MAX_RETRIES), 0);
    expect(msg.acked).toBe(true);
    expect(msg.retried).toBeNull();
    expect(outbox('d1')).toMatchObject({ state: 'pending', not_before: NOW });

    clock = NOW - 1;
    db.raw.prepare("UPDATE notification_outbox SET not_before=? WHERE id='d1'").run(NOW + HOUR_MS);
    expect((await dispatchOutbox(env, dispatchDeps())).dispatched).toBe(0);
    clock = NOW + HOUR_MS;
    expect((await dispatchOutbox(env, dispatchDeps())).dispatched).toBe(1);
    await consume(message(sent[0]));
    expect(row('d1')).toMatchObject({ state: 'sent', attempts: 2 });
  });

  it('uses the Tier 2 ladder via the D1 schedule for long waits', async () => {
    const m = enqueue('d1');
    db.raw.prepare("UPDATE deliveries SET attempts=9 WHERE id='d1'").run();
    fetchMock.mockResolvedValueOnce(new Response('', { status: 502 }));
    const msg = await consume(message(m), 0);
    // Attempt 10 failed: the next rung is +48 h, beyond the 24 h queue maximum.
    expect(msg.acked).toBe(true);
    expect(row('d1')?.next_attempt_at).toBe(NOW + 48 * HOUR_MS);
    expect(outbox('d1').not_before).toBe(NOW + 48 * HOUR_MS);
  });

  it('retry_after_overrides_computed_backoff', async () => {
    const m = enqueue('d1');
    fetchMock.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '120' } }));
    const msg = await consume(message(m), 0);
    expect(msg.retried).toEqual({ delaySeconds: 120 });
    expect(row('d1')).toMatchObject({ state: 'retrying', last_error_code: 'destination_rate_limited' });
  });

  it('exhausted_delivery_reaches_a_terminal_dead_letter_state', async () => {
    const m = enqueue('d1');
    db.raw.prepare("UPDATE deliveries SET attempts=12 WHERE id='d1'").run();
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    const msg = await consume(message(m));
    expect(msg.acked).toBe(true);
    expect(row('d1')).toMatchObject({
      state: 'dead_lettered',
      attempts: 13,
      last_error_code: 'destination_unavailable',
      dead_lettered_at: NOW,
      next_attempt_at: null,
    });
  });

  it.each([
    [404, 'destination_revoked'],
    [410, 'destination_revoked'],
    [403, 'destination_unauthorized'],
    [413, 'payload_too_large'],
  ])(
    'a permanent HTTP %i dead-letters on the first attempt as %s and is never retried',
    async (status, code) => {
      const m = enqueue('d1');
      fetchMock.mockResolvedValueOnce(new Response('', { status }));
      expect((await consume(message(m))).acked).toBe(true);
      expect(row('d1')).toMatchObject({ state: 'dead_lettered', attempts: 1, last_error_code: code });
      await consume(message(m));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('classifies Lark reply codes (F179)', async () => {
    const m1 = enqueue('d1');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 19021 }), { status: 200 }));
    await consume(message(m1));
    expect(row('d1')).toMatchObject({ state: 'dead_lettered', last_error: 'provider_lark_19021' });

    const m2 = enqueue('d2');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 99991400 }), { status: 200 }));
    expect((await consume(message(m2))).retried).not.toBeNull();
    expect(row('d2')).toMatchObject({ state: 'retrying', last_error_code: 'destination_rate_limited' });
  });

  it('a timeout is transient', async () => {
    const m = enqueue('d1');
    fetchMock.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    await consume(message(m));
    expect(row('d1')).toMatchObject({ state: 'retrying', last_error: 'provider_timeout' });
  });

  it('a duplicate message for a retry not yet due waits out the remainder (M1)', async () => {
    const m = enqueue('d1', 'int-a', 'org-a', 'retrying');
    db.raw.prepare("UPDATE deliveries SET next_attempt_at=? WHERE id='d1'").run(NOW + 120_500);
    const early = await consume(message(m));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(early.retried).toEqual({ delaySeconds: 121 });

    // On the message's last queue retry it parks the outbox row instead.
    db.raw.prepare("UPDATE notification_outbox SET state='dispatched' WHERE id='d1'").run();
    const last = await consume(message(m, QUEUE_MAX_RETRIES));
    expect(last).toMatchObject({ acked: true, retried: null });
    expect(outbox('d1')).toMatchObject({ state: 'pending', not_before: NOW + 120_500 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('on its last queue retry, a duplicate during a live claim is acknowledged (H1)', async () => {
    const m = enqueue('d1');
    db.raw.prepare("UPDATE deliveries SET state='claimed',claimed_at=? WHERE id='d1'").run(NOW - 1000);
    const msg = await consume(message(m, QUEUE_MAX_RETRIES));
    expect(msg).toMatchObject({ acked: true, retried: null });
  });

  it('takes the attempt number from the claim, not the earlier read (M2)', async () => {
    const m = enqueue('d1');
    env = {
      ...env,
      DB: hookedDb(/SET state='claimed'/, () => {
        db.raw.prepare("UPDATE deliveries SET attempts=5 WHERE id='d1'").run();
      }),
    };
    await consume(message(m));
    expect(row('d1')).toMatchObject({ state: 'sent', attempts: 6 });
  });

  it('an unexpected throw after the claim releases it through the retry path (H1)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const m = enqueue('d1');
    env = {
      ...env,
      DB: hookedDb(/FROM integrations/, () => {
        throw new Error('D1 hiccup');
      }),
    };
    const msg = await consume(message(m));
    expect(msg.retried).not.toBeNull();
    expect(row('d1')).toMatchObject({
      state: 'retrying',
      attempts: 1,
      last_error: 'consumer_error',
      last_error_code: 'internal_error',
    });
  });

  it('a lost claim neither retries nor parks (H2, fenced write)', async () => {
    const steal = () => {
      db.raw.prepare("UPDATE deliveries SET claim_token='someone-else' WHERE id='d1'").run();
    };
    const m = enqueue('d1');
    db.raw.prepare("UPDATE notification_outbox SET state='dispatched' WHERE id='d1'").run();
    fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    env = { ...env, DB: hookedDb(/SET state=\?4/, steal) };
    const queued = await consume(message(m));
    expect(queued).toMatchObject({ acked: true, retried: null });
    expect(row('d1')).toMatchObject({ state: 'claimed', attempts: 0 });

    // Park path: the guarded schedule must not move the outbox row either.
    db.raw.prepare("UPDATE deliveries SET state='pending',claim_token=NULL WHERE id='d1'").run();
    env = { ...env, DB: hookedDb(/SET state=\?4/, steal) };
    const parked = await consume(message(m, QUEUE_MAX_RETRIES));
    expect(parked.acked).toBe(true);
    expect(outbox('d1')).toMatchObject({ state: 'dispatched', not_before: null });
  });

  it('a redirect is permanent and is never followed', async () => {
    const m = enqueue('d1');
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://x.test' } }),
    );
    await consume(message(m));
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    expect(row('d1')).toMatchObject({
      state: 'dead_lettered',
      last_error: 'provider_redirect_302',
      last_error_code: 'destination_url_rejected',
    });
  });

  it('an unreadable 2xx Lark body is recorded as accepted, not retried', async () => {
    const m = enqueue('d1');
    fetchMock.mockResolvedValueOnce(new Response('<html>ok</html>', { status: 200 }));
    const msg = await consume(message(m));
    expect(msg).toMatchObject({ acked: true, retried: null });
    expect(row('d1')).toMatchObject({ state: 'accepted', last_error: 'provider_reply_unreadable' });
  });

  it('backs off a whole batch for a minute when the key ring is unusable', async () => {
    const m = enqueue('d1');
    const calls: unknown[] = [];
    const batch = {
      messages: [message(m)],
      retryAll: (o: unknown) => calls.push(o),
    } as unknown as MessageBatch<unknown>;
    await consumeDeliveries(batch, { ...env, KEK_V1: 'bad' }, consumerDeps());
    expect(calls).toEqual([{ delaySeconds: KEYRING_RETRY_DELAY_SECONDS }]);
  });

  it('a duplicate message during a live claim is retried later, not sent twice', async () => {
    const m = enqueue('d1');
    db.raw.prepare("UPDATE deliveries SET state='claimed',claimed_at=? WHERE id='d1'").run(NOW - 1000);
    const msg = await consume(message(m));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(msg.retried).toEqual({ delaySeconds: 300 });
  });

  it('a claim abandoned by a crashed consumer is taken over after the lease', async () => {
    const m = enqueue('d1');
    db.raw.prepare("UPDATE deliveries SET state='claimed',claimed_at=? WHERE id='d1'").run(NOW - 10 * 60_000);
    await consume(message(m));
    expect(row('d1')?.state).toBe('sent');
  });

  it('a claim stranded by a ledger outage is released by the cron backstop (H1)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const m = enqueue('d1');
    db.raw.prepare("UPDATE notification_outbox SET state='dispatched' WHERE id='d1'").run();
    env = {
      ...env,
      DB: hookedDb(/SET state=\?4/, () => {
        throw new Error('D1 down');
      }),
    };
    const msg = await consume(message(m));
    expect(msg.retried).toEqual({});
    expect(row('d1')?.state).toBe('claimed');

    env = makeEnv();
    expect(await sweepStaleClaims(env, NOW + 60_000)).toBe(0); // lease still live
    clock = NOW + 6 * 60_000;
    expect(await sweepStaleClaims(env, clock)).toBe(1);
    expect(row('d1')).toMatchObject({ state: 'retrying', attempts: 1, last_error: 'claim_expired' });
    expect(outbox('d1')).toMatchObject({ state: 'pending', not_before: clock });

    expect((await dispatchOutbox(env, dispatchDeps())).dispatched).toBe(1);
    await consume(message(sent[0]));
    expect(row('d1')).toMatchObject({ state: 'sent', attempts: 2 });
  });

  it('the backstop dead-letters a stranded claim whose budget is spent', async () => {
    enqueue('d1');
    db.raw.prepare("UPDATE notification_outbox SET state='dispatched' WHERE id='d1'").run();
    db.raw.prepare("UPDATE deliveries SET state='claimed',claimed_at=1,attempts=12 WHERE id='d1'").run();
    expect(await sweepStaleClaims(env, NOW)).toBe(1);
    expect(row('d1')).toMatchObject({ state: 'dead_lettered', attempts: 13, dead_lettered_at: NOW });
    expect(outbox('d1').state).toBe('dispatched');
  });

  it('a ledger failure retries the message instead of losing it', async () => {
    const m = enqueue('d1');
    const msg = message(m);
    const broken = {
      ...env,
      DB: { prepare: () => ({ bind: () => ({ first: () => Promise.reject(new Error('D1 down')) }) }) },
    };
    const batch = { messages: [msg], retryAll: () => undefined } as unknown as MessageBatch<unknown>;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await consumeDeliveries(batch, broken as unknown as Bindings, consumerDeps());
    expect(msg.retried).toEqual({});
    expect(errors).toHaveBeenCalledOnce();
  });

  it('never logs the destination URL', async () => {
    const lines: string[] = [];
    const capture = (...data: unknown[]): void => {
      lines.push(data.map(String).join(' '));
    };
    vi.spyOn(console, 'info').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
    const m = enqueue('d1');
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed for ${LARK}`));
    await consume(message(m));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('reliability-fixture');
  });
});

describe('outbox sweep hygiene (M3, M6, M7)', () => {
  it('stamps each row with its own clock reading', async () => {
    enqueue('d1');
    enqueue('d2');
    let tick = NOW;
    await dispatchOutbox(env, { now: () => (tick += 1000), newLeaseToken: () => `lease-${++tokens}` });
    const stamps = db.raw.prepare('SELECT dispatched_at FROM notification_outbox ORDER BY id').all() as {
      dispatched_at: string;
    }[];
    expect(new Set(stamps.map((r) => r.dispatched_at)).size).toBe(2);
  });

  it('serves the workspace with the oldest work first', async () => {
    enqueue('new', 'int-a', 'org-a');
    db.raw.prepare("UPDATE notification_outbox SET created_at='2026-10-13 10:00:00' WHERE id='new'").run();
    enqueue('old', 'int-a', 'org-b');
    db.raw.prepare("UPDATE notification_outbox SET created_at='2026-10-01 10:00:00' WHERE id='old'").run();
    const due = await db.d1.prepare(SELECT_DUE_WORKSPACES_SQL).bind(NOW, 1).all();
    expect(due.results).toEqual([{ organization_id: 'org-b' }]);
  });

  it('a released row waits out a back-off before the next send', async () => {
    enqueue('d1');
    env = makeEnv(() => Promise.reject(new Error('queue full')));
    expect((await dispatchOutbox(env, dispatchDeps())).released).toBe(1);
    env = makeEnv();
    expect((await dispatchOutbox(env, dispatchDeps())).dispatched).toBe(0);
    clock = NOW + RELEASE_BACKOFF_MS;
    expect((await dispatchOutbox(env, dispatchDeps())).dispatched).toBe(1);
  });

  it('an invalid outbox row dead-letters its delivery in the same transaction (M7)', async () => {
    enqueue('d1');
    db.raw.prepare("UPDATE notification_outbox SET payload_json='nope' WHERE id='d1'").run();
    await dispatchOutbox(env, dispatchDeps());
    expect(outbox('d1').state).toBe('invalid');
    expect(row('d1')).toMatchObject({
      state: 'dead_lettered',
      last_error_code: 'config_invalid',
      last_error: 'outbox_payload_invalid',
    });
  });

  it('purges old rows of successful deliveries but keeps what replay needs (M6)', async () => {
    const old = '2026-09-01 00:00:00';
    for (const [id, state] of [
      ['ok', 'sent'],
      ['dead', 'dead_lettered'],
      ['fresh', 'sent'],
    ] as const) {
      enqueue(id, 'int-a', 'org-a', state);
      db.raw.prepare("UPDATE notification_outbox SET state='dispatched' WHERE id=?").run(id);
    }
    db.raw.prepare("UPDATE notification_outbox SET created_at=? WHERE id IN ('ok','dead')").run(old);
    expect(await purgeOutbox(env, NOW)).toBe(1);
    const left = (
      db.raw.prepare('SELECT id FROM notification_outbox ORDER BY id').all() as { id: string }[]
    ).map((r) => r.id);
    expect(left).toEqual(['dead', 'fresh']);
  });
});

describe('ids and legacy rows (F170, F184, D10)', () => {
  it('ingress derives the hashed delivery id from (dedup key, destination)', async () => {
    db.raw
      .prepare(
        `INSERT INTO github_installations(id,organization_id,installation_id,app_id,account_login,account_type,repository_selection)
         VALUES('gi','org-a','100','777','acme','Organization','all')`,
      )
      .run();
    await integration('int-b');
    const res = await postGithub('gh-1');
    expect(await res.json()).toEqual({ accepted: true, persisted: 2 });
    const key = await dedupKey({ orgId: 'org-a', connectionId: '100', source: 'github', eventId: 'gh-1' });
    const expected = await Promise.all(
      ['int-a', 'int-b'].map(async (i) => (await deliveryId(key.hex, i)).hex),
    );
    const ids = db.raw.prepare('SELECT id,dedup_key FROM deliveries ORDER BY id').all() as {
      id: string;
      dedup_key: string;
    }[];
    expect(ids.map((r) => r.id).sort()).toEqual(expected.sort());
    expect(ids.every((r) => r.dedup_key === key.hex)).toBe(true);
  });

  it('a GitHub redelivery of an event stored under a legacy id is not accepted again', async () => {
    db.raw
      .prepare(
        `INSERT INTO github_installations(id,organization_id,installation_id,app_id,account_login,account_type,repository_selection)
         VALUES('gi','org-a','100','777','acme','Organization','all')`,
      )
      .run();
    enqueue('gh-legacy:int-a', 'int-a', 'org-a', 'sent');
    const res = await postGithub('gh-legacy');
    expect(await res.json()).toEqual({ accepted: true, persisted: 0 });
  });

  it('legacy-id rows are still dispatched, delivered and updated', async () => {
    enqueue('gh-old:int-a');
    await dispatchOutbox(env, dispatchDeps());
    expect(sent.map((m) => m.id)).toEqual(['gh-old:int-a']);
    await consume(message(sent[0]));
    expect(row('gh-old:int-a')).toMatchObject({ state: 'sent', attempts: 1 });
  });
});

describe('manual redelivery (F182)', () => {
  async function deadLettered(): Promise<void> {
    const m = enqueue('d1');
    await dispatchOutbox(env, dispatchDeps());
    sent = [];
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    await consume(message(m));
    expect(row('d1')?.state).toBe('dead_lettered');
  }

  it('replay_creates_one_new_row_and_preserves_history', async () => {
    await deadLettered();
    const [a, b] = await Promise.all([
      redeliver(db.d1, { organizationId: 'org-a', deliveryId: 'd1' }),
      redeliver(db.d1, { organizationId: 'org-a', deliveryId: 'd1' }),
    ]);
    if (!a.ok || !b.ok) throw new Error('replay refused');
    expect(a.deliveryId).toBe(b.deliveryId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(row(a.deliveryId)).toMatchObject({ state: 'pending', attempts: 0, replay_of: 'd1' });
    expect(row('d1')?.state).toBe('dead_lettered');

    await dispatchOutbox(env, dispatchDeps());
    expect(sent.map((m) => m.id)).toEqual([a.deliveryId]);
    await consume(message(sent[0]));
    expect(row(a.deliveryId)?.state).toBe('sent');
  });

  it('a second replay after the first is a new sequence, not a duplicate', async () => {
    await deadLettered();
    const first = await redeliver(db.d1, { organizationId: 'org-a', deliveryId: 'd1' });
    const second = await redeliver(db.d1, { organizationId: 'org-a', deliveryId: 'd1' });
    expect(first.ok && second.ok && first.deliveryId !== second.deliveryId).toBe(true);
  });

  it('replay_of_a_successful_delivery_is_refused', async () => {
    const m = enqueue('d1');
    await consume(message(m));
    expect(await redeliver(db.d1, { organizationId: 'org-a', deliveryId: 'd1' })).toEqual({
      ok: false,
      error: 'already_delivered',
    });
  });

  it('is tenant-scoped', async () => {
    await deadLettered();
    expect(await redeliver(db.d1, { organizationId: 'org-b', deliveryId: 'd1' })).toEqual({
      ok: false,
      error: 'not_found',
    });
  });

  it('refuses when the stored message is gone or is not ours', async () => {
    await deadLettered();
    db.raw.prepare("UPDATE notification_outbox SET payload_json='[]' WHERE id='d1'").run();
    expect(await redeliver(db.d1, { organizationId: 'org-a', deliveryId: 'd1' })).toEqual({
      ok: false,
      error: 'payload_unavailable',
    });
    db.raw.prepare("DELETE FROM notification_outbox WHERE id='d1'").run();
    expect((await redeliver(db.d1, { organizationId: 'org-a', deliveryId: 'd1' })).ok).toBe(false);
  });
});

describe('dead-letter queue consumer (F180)', () => {
  async function deadLetter(body: unknown, queue = DEAD_LETTER_QUEUE): Promise<FakeMessage> {
    const msg = message(body);
    const batch = { queue, messages: [msg], retryAll: () => undefined } as unknown as MessageBatch<unknown>;
    await worker.queue(batch, env);
    return msg;
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('moves a never-attempted delivery to a terminal dead_lettered state', async () => {
    const m = enqueue('d1');
    const msg = await deadLetter(m);
    expect(msg.acked).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(row('d1')).toMatchObject({
      state: 'dead_lettered',
      last_error: QUEUE_EXHAUSTED,
      last_error_code: 'internal_error',
    });
    expect(row('d1')?.dead_lettered_at).toEqual(expect.any(Number));
  });

  it('keeps the error code of a retrying delivery', async () => {
    const m = enqueue('d1', 'int-a', 'org-a', 'retrying');
    db.raw
      .prepare(
        "UPDATE deliveries SET last_error='provider_http_503',last_error_code='destination_unavailable' WHERE id='d1'",
      )
      .run();
    await deadLetter(m);
    expect(row('d1')).toMatchObject({
      state: 'dead_lettered',
      last_error: 'provider_http_503',
      last_error_code: 'destination_unavailable',
    });
  });

  it('leaves terminal rows alone and dead-letters a claim of any age (H1)', async () => {
    const sentMsg = enqueue('d1', 'int-a', 'org-a', 'sent');
    await deadLetter(sentMsg);
    expect(row('d1')?.state).toBe('sent');

    // The queue has given up on this message, so even a fresh claim is not waited on: a
    // holder that is somehow still alive writes nothing, because its write is fenced.
    const live = enqueue('d2');
    db.raw.prepare("UPDATE deliveries SET state='claimed',claimed_at=? WHERE id='d2'").run(Date.now());
    await deadLetter(live);
    expect(row('d2')?.state).toBe('dead_lettered');

    const stale = enqueue('d3');
    db.raw.prepare("UPDATE deliveries SET state='claimed',claimed_at=? WHERE id='d3'").run(1);
    await deadLetter(stale);
    expect(row('d3')?.state).toBe('dead_lettered');
  });

  it('is tenant-scoped: a message naming another workspace changes nothing', async () => {
    const m = enqueue('d1');
    expect((await deadLetter({ ...m, organizationId: 'org-b' })).acked).toBe(true);
    expect(row('d1')?.state).toBe('pending');
  });

  it('acknowledges an unparseable message', async () => {
    expect((await deadLetter({ nonsense: true })).acked).toBe(true);
  });

  it('retries the DLQ message when the ledger write fails', async () => {
    const msg = message(enqueue('d1'));
    const broken = {
      ...env,
      DB: { prepare: () => ({ bind: () => ({ run: () => Promise.reject(new Error('down')) }) }) },
    };
    const batch = { queue: DEAD_LETTER_QUEUE, messages: [msg] } as unknown as MessageBatch<unknown>;
    await consumeDeadLetters(batch, broken as unknown as Bindings);
    expect(msg.retried).toEqual({});
    expect(msg.acked).toBe(false);
  });
});

describe('configuration', () => {
  const config = readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8');

  it('QUEUE_MAX_RETRIES mirrors max_retries on the delivery consumer in wrangler.jsonc', () => {
    expect(config).toMatch(
      new RegExp(`"queue": "noti-deliveries",[\\s\\S]*?"max_retries":\\s*${QUEUE_MAX_RETRIES}\\b`),
    );
  });

  it('delivery_queue_batch_size_is_small (F176)', () => {
    const size = /"queue": "noti-deliveries",[\s\S]*?"max_batch_size":\s*(\d+)/.exec(config)?.[1];
    expect(Number(size)).toBeGreaterThanOrEqual(1);
    expect(Number(size)).toBeLessThanOrEqual(5);
  });

  it('the dead-letter queue has a consumer (F180)', () => {
    expect(config).toContain(`"dead_letter_queue": "${DEAD_LETTER_QUEUE}"`);
    expect(config).toMatch(new RegExp(`"consumers"[\\s\\S]*"queue": "${DEAD_LETTER_QUEUE}"`));
  });
});

async function postGithub(deliveryHeader: string): Promise<Response> {
  const body = JSON.stringify({
    action: 'opened',
    installation: { id: 100, app_id: 777 },
    repository: { full_name: 'acme/web', html_url: 'https://github.com/acme/web' },
    issue: { title: 'T', html_url: 'https://github.com/acme/web/issues/1' },
  });
  const secret = HMAC_FIXTURE;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  const signature = 'sha256=' + Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
  const waits: Promise<unknown>[] = [];
  const res = await worker.fetch(
    new Request('https://noti.test/webhooks/github', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-event': 'issues',
        'x-github-delivery': deliveryHeader,
      },
    }),
    { ...env, GITHUB_WEBHOOK_SECRET: secret },
    { waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as ExecutionContext,
  );
  await Promise.all(waits);
  return res;
}
