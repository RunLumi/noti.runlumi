import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyD1Error, withD1Retry } from '../../src/db/retry';
import { EVENT, caller, setup, signHeaders, type Harness } from '../sources/harness';

vi.mock('../../src/auth/better-auth', async () => (await import('../sources/harness')).mockAuth());

const { default: worker } = await import('../../src/index');

const lost = () => new Error('D1_ERROR: Network connection lost.');
const reset = () => new Error('D1_ERROR: Internal error in D1 DB storage caused object to be reset.');
const overloaded = () => new Error('D1_ERROR: D1 DB is overloaded. Requests queued for too long.');

describe('classifyD1Error (messages from the D1 error list, read 2026-10-14)', () => {
  it.each([
    ['D1 DB reset because its code was updated.', 'retry'],
    ['D1_ERROR: Internal error while starting up D1 DB storage caused object to be reset.', 'retry'],
    ['D1_ERROR: Internal error in D1 DB storage caused object to be reset.', 'retry'],
    ['D1_ERROR: Network connection lost.', 'retry_if_idempotent'],
    ['D1_ERROR: Replica disconnected from primary.', 'retry_if_idempotent'],
    ['D1_ERROR: Cannot resolve D1 DB due to transient issue on remote node.', 'retry_if_idempotent'],
    ['D1_ERROR: D1 DB is overloaded. Requests queued for too long.', 'shed'],
    ['D1_ERROR: D1 DB is overloaded. Too many requests queued.', 'shed'],
    ['D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.', 'shed'],
    ['D1_ERROR: D1 DB exceeded its CPU time limit and was reset.', 'shed'],
    ['D1_ERROR: UNIQUE constraint failed: deliveries.id: SQLITE_CONSTRAINT', 'permanent'],
    ['D1_ERROR: no such table: nope: SQLITE_ERROR', 'permanent'],
    ['something else', 'permanent'],
  ] as const)('%s → %s', (message, expected) => {
    expect(classifyD1Error(new Error(message))).toBe(expected);
  });

  it('treats a non-Error throw as permanent', () => {
    expect(classifyD1Error(undefined)).toBe('permanent');
    expect(classifyD1Error('Network connection lost')).toBe('retry_if_idempotent');
  });
});

describe('withD1Retry', () => {
  const noSleep = () => Promise.resolve();

  it('returns the first success without sleeping', async () => {
    const sleep = vi.fn(noSleep);
    const fn = vi.fn(() => Promise.resolve('ok'));
    expect(await withD1Retry(fn, { idempotent: true, sleep })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a retryable write error and then succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(lost()).mockRejectedValueOnce(reset()).mockResolvedValue('done');
    expect(await withD1Retry(fn, { idempotent: true, sleep: noSleep })).toBe('done');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a constraint violation or any unknown error: surface it', async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(new Error('D1_ERROR: UNIQUE constraint failed: x.id: SQLITE_CONSTRAINT'));
    await expect(withD1Retry(fn, { idempotent: true, sleep: noSleep })).rejects.toThrow(/UNIQUE/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry overload or timeout (Cloudflare: reduce load, do not retry)', async () => {
    const fn = vi.fn().mockRejectedValue(overloaded());
    await expect(withD1Retry(fn, { idempotent: true, sleep: noSleep })).rejects.toThrow(/overloaded/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a possibly-committed error is retried only when the caller says the write is idempotent', async () => {
    const unsafe = vi.fn().mockRejectedValue(lost());
    await expect(withD1Retry(unsafe, { idempotent: false, sleep: noSleep })).rejects.toThrow(
      /connection lost/,
    );
    expect(unsafe).toHaveBeenCalledTimes(1);
    // An error that means "did not run" is safe either way.
    const safe = vi.fn().mockRejectedValueOnce(reset()).mockResolvedValue('ok');
    expect(await withD1Retry(safe, { idempotent: false, sleep: noSleep })).toBe('ok');
  });

  it('is bounded: gives up after `attempts` and rethrows the last error unchanged', async () => {
    const error = lost();
    const fn = vi.fn().mockRejectedValue(error);
    await expect(withD1Retry(fn, { idempotent: true, attempts: 4, sleep: noSleep })).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(4);
    // Never more than the documented example's five, whatever is asked.
    const many = vi.fn().mockRejectedValue(lost());
    await expect(withD1Retry(many, { idempotent: true, attempts: 50, sleep: noSleep })).rejects.toThrow();
    expect(many).toHaveBeenCalledTimes(5);
  });

  it('uses full jitter: uniform in [0, min(cap, base * 2^attempt))', async () => {
    const sleeps: number[] = [];
    const sleep = (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    const fn = vi.fn().mockRejectedValue(lost());
    await expect(
      withD1Retry(fn, { idempotent: true, attempts: 5, baseMs: 50, capMs: 300, sleep }, () => 0.999),
    ).rejects.toThrow();
    // attempt 1..4 → ceilings 100, 200, 300 (capped), 300
    expect(sleeps).toEqual([99, 199, 299, 299]);
    const zero: number[] = [];
    await expect(
      withD1Retry(
        fn,
        { idempotent: true, attempts: 3, sleep: (ms) => (zero.push(ms), Promise.resolve()) },
        () => 0,
      ),
    ).rejects.toThrow();
    expect(zero).toEqual([0, 0]);
  });
});

describe('ingress write retry (the whole batch, never half)', () => {
  let h: Harness;
  const call = caller(worker, () => h);
  const quiet = () => {
    for (const level of ['info', 'warn', 'error'] as const)
      vi.spyOn(console, level).mockImplementation(() => undefined);
  };

  beforeEach(() => {
    h = setup();
    quiet();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function setupSource(): Promise<{ endpointId: string; secret: string }> {
    const src = await (
      await call('POST', '/api/sources', { as: 'alice', body: { name: 'CI' } })
    ).json<{
      source: { id: string; endpointId: string };
      secret: string;
    }>();
    const res = await call('POST', '/api/integrations', {
      as: 'alice',
      body: {
        name: 's',
        sourceId: src.source.id,
        destination: 'slack',
        webhookUrl: 'https://hooks.slack.com/services/T000/B000/RetryFixtureToken',
      },
    });
    expect(res.status).toBe(201);
    return { endpointId: src.source.endpointId, secret: src.secret };
  }

  async function ingest(src: { endpointId: string; secret: string }): Promise<Response> {
    const body = JSON.stringify(EVENT);
    return worker.fetch(
      new Request(`https://noti.test/webhooks/generic/${src.endpointId}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signHeaders(src.secret, body, { id: 'evt-retry' }),
        },
        body,
      }),
      h.env,
      { waitUntil: h.waitUntil, passThroughOnException: () => undefined } as unknown as ExecutionContext,
    );
  }

  /** Make the delivery+outbox batch fail on its first `failures` runs, optionally AFTER committing. */
  function flakyBatch(failures: number, commitFirst: boolean): { attempts: () => number } {
    const real = h.env.DB;
    let seen = 0;
    h.env = {
      ...h.env,
      DB: new Proxy(real, {
        get(target, prop) {
          if (prop !== 'batch') return Reflect.get(target, prop) as unknown;
          return async (statements: D1PreparedStatement[]) => {
            const isIngress = statements.some((s) =>
              /INSERT INTO notification_outbox/.test((s as unknown as { sql: string }).sql),
            );
            if (!isIngress) return target.batch(statements);
            seen++;
            if (seen <= failures) {
              if (commitFirst) await target.batch(statements);
              throw new Error('D1_ERROR: Network connection lost.');
            }
            return target.batch(statements);
          };
        },
      }),
    };
    return { attempts: () => seen };
  }

  const rows = (table: string) =>
    (
      h.db.raw
        // A retry after a commit we did not see looks like a repeat to the ledger and is recorded as one
        // (`suppressed`, ADR 0023): real deliveries are what must be exactly one.
        .prepare(
          `SELECT COUNT(*) AS n FROM ${table === 'deliveries' ? "deliveries WHERE state != 'suppressed'" : 'notification_outbox'}`,
        )
        .get() as {
        n: number;
      }
    ).n;

  it('a transient failure before the commit is retried and the event is accepted once', async () => {
    const src = await setupSource();
    const flaky = flakyBatch(2, false);
    const res = await ingest(src);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, persisted: 1 });
    expect(flaky.attempts()).toBe(3);
    expect(rows('deliveries')).toBe(1);
    expect(rows('outbox')).toBe(1);
  });

  it('a connection lost AFTER the commit still yields exactly one delivery and one outbox row', async () => {
    const src = await setupSource();
    const flaky = flakyBatch(1, true);
    const res = await ingest(src);
    expect(res.status).toBe(202);
    expect(flaky.attempts()).toBe(2);
    expect(rows('deliveries')).toBe(1);
    expect(rows('outbox')).toBe(1);
    // The retry changed nothing, so no prompt dispatch was scheduled: the outbox reconciler owns it.
    expect(await res.json()).toEqual({ accepted: true, persisted: 0, duplicate: true });
  });

  it('gives up after the bounded attempts and answers 5xx, so the provider retries', async () => {
    const src = await setupSource();
    flakyBatch(100, false);
    const res = await ingest(src);
    expect(res.status).toBe(500);
    expect(rows('deliveries')).toBe(0);
  });

  it('does not retry a non-transient error', async () => {
    const src = await setupSource();
    const real = h.env.DB;
    let calls = 0;
    h.env = {
      ...h.env,
      DB: new Proxy(real, {
        get(target, prop) {
          if (prop !== 'batch') return Reflect.get(target, prop) as unknown;
          return () => {
            calls++;
            return Promise.reject(
              new Error('D1_ERROR: UNIQUE constraint failed: deliveries.id: SQLITE_CONSTRAINT'),
            );
          };
        },
      }),
    };
    expect((await ingest(src)).status).toBe(500);
    expect(calls).toBe(1);
  });
});
