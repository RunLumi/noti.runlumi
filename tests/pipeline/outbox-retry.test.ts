import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings, DeliveryMessage } from '../../src/env';
import { dispatchOutbox, type DispatchDeps } from '../../src/pipeline/outbox';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

/**
 * D1 write discipline for the outbox dispatcher (F09, ADR 0036, REMAINING 1.4): the claim, reclaim, mark
 * and release writes retry transient D1 failures, with `idempotent` chosen per statement.
 */
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const reset = () => new Error('D1_ERROR: Internal error in D1 DB storage caused object to be reset.');
const lost = () => new Error('D1_ERROR: Network connection lost.');
const overloaded = () => new Error('D1_ERROR: D1 DB is overloaded. Requests queued for too long.');

let db: FakeD1;
let sent: DeliveryMessage[];
let tokens: number;

interface Fault {
  readonly pattern: RegExp;
  readonly error: () => Error;
  /** Run the statement for real, THEN throw: the write committed and only the answer was lost. */
  readonly afterCommit: boolean;
  times: number;
  calls: number;
}

/** A D1 stand-in that fails matching statements a fixed number of times. `.real` lets `batch` unwrap. */
function flaky(fault: Fault): D1Database {
  const wrap = (sql: string, bound: unknown[]): unknown => {
    const real = db.d1.prepare(sql).bind(...bound);
    const run = async (method: 'run' | 'all' | 'first') => {
      if (fault.pattern.test(sql)) {
        fault.calls++;
        if (fault.times > 0) {
          fault.times--;
          if (fault.afterCommit)
            await (real as unknown as Record<string, () => Promise<unknown>>)[method]?.();
          throw fault.error();
        }
      }
      return (real as unknown as Record<string, () => Promise<unknown>>)[method]?.();
    };
    return {
      real,
      bind: (...more: unknown[]) => wrap(sql, more),
      run: () => run('run'),
      all: () => run('all'),
      first: () => run('first'),
    };
  };
  return {
    prepare: (sql: string) => wrap(sql, []),
    batch: async (statements: { real?: unknown }[]) => {
      if (fault.pattern.test('batch')) fault.calls++;
      return db.d1.batch(statements.map((s) => s.real) as D1PreparedStatement[]);
    },
  } as unknown as D1Database;
}

function envWith(database: D1Database, send?: () => Promise<void>): Bindings {
  return {
    DB: database,
    DELIVERY_QUEUE: {
      send:
        send ??
        ((m: DeliveryMessage) => {
          sent.push(m);
          return Promise.resolve();
        }),
    },
  } as unknown as Bindings;
}

const deps = (): DispatchDeps => ({ now: () => NOW, newLeaseToken: () => `lease-${++tokens}` });

function fault(pattern: RegExp, error: () => Error, times = 1, afterCommit = false): Fault {
  return { pattern, error, afterCommit, times, calls: 0 };
}

function enqueue(id: string, payload?: string): void {
  const message: DeliveryMessage = {
    id,
    integrationId: 'int-a',
    organizationId: 'org-a',
    title: 'T',
    url: '',
  };
  db.raw
    .prepare(
      "INSERT INTO deliveries(id,integration_id,organization_id,state,created_at) VALUES(?,?,?,?,'2026')",
    )
    .run(id, 'int-a', 'org-a', 'pending');
  db.raw
    .prepare('INSERT INTO notification_outbox(id,organization_id,payload_json) VALUES(?,?,?)')
    .run(id, 'org-a', payload ?? JSON.stringify(message));
}

const outboxState = (id: string) =>
  (db.raw.prepare('SELECT state FROM notification_outbox WHERE id=?').get(id) as { state: string }).state;

beforeEach(() => {
  db = createFakeD1();
  seedOrganization(db.raw, 'org-a');
  sent = [];
  tokens = 0;
  // Full jitter with a zero draw: the retry sleeps 0 ms, so the suite stays fast.
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('the claim', () => {
  it('is retried after a failure that means it did not run, and the row is dispatched once', async () => {
    enqueue('d1');
    const f = fault(/SET state = 'claimed'/, reset);
    const report = await dispatchOutbox(envWith(flaky(f)), deps());
    expect(f.calls).toBe(2);
    expect(report).toMatchObject({ dispatched: 1, lostRace: 0 });
    expect(sent.map((m) => m.id)).toEqual(['d1']);
    expect(outboxState('d1')).toBe('dispatched');
  });

  it('is NOT retried after "Network connection lost": the claim may have committed and a repeat would lose its own row', async () => {
    enqueue('d1');
    const f = fault(/SET state = 'claimed'/, lost, 1, true);
    await expect(dispatchOutbox(envWith(flaky(f)), deps())).rejects.toThrow(/Network connection lost/);
    expect(f.calls).toBe(1);
    // It did commit: the row is `claimed` under a lease nobody holds, and the reconciler reclaims it.
    expect(outboxState('d1')).toBe('claimed');
    expect(sent).toEqual([]);
  });

  it('is never retried on overload, and says so in the log', async () => {
    enqueue('d1');
    const f = fault(/SET state = 'claimed'/, overloaded, 3);
    await expect(dispatchOutbox(envWith(flaky(f)), deps())).rejects.toThrow(/overloaded/);
    expect(f.calls).toBe(1);
    const warned = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(warned.some((l) => l.includes('d1_write_shed') && l.includes('outbox_claim'))).toBe(true);
    expect(outboxState('d1')).toBe('pending');
  });

  it('gives up after a bounded number of attempts and surfaces the last error', async () => {
    enqueue('d1');
    const f = fault(/SET state = 'claimed'/, reset, 99);
    await expect(dispatchOutbox(envWith(flaky(f)), deps())).rejects.toThrow(/reset/);
    expect(f.calls).toBe(3);
    expect(outboxState('d1')).toBe('pending');
  });
});

describe('the expired-lease reclaim', () => {
  it('is retried on a failure that did not run, then the row is dispatched', async () => {
    enqueue('d1');
    db.raw
      .prepare(
        "UPDATE notification_outbox SET state='claimed', lease_token='old', claimed_at=?, lease_expires_at=? WHERE id='d1'",
      )
      .run(NOW - 120_000, NOW - 60_000);
    const f = fault(/SET state = 'pending', claimed_at = NULL/, reset);
    const report = await dispatchOutbox(envWith(flaky(f)), deps());
    expect(f.calls).toBe(2);
    expect(report).toMatchObject({ reclaimed: 1, dispatched: 1 });
    expect(sent.map((m) => m.id)).toEqual(['d1']);
  });
});

describe('marking a row dispatched', () => {
  it('is retried before it commits, and the row ends dispatched', async () => {
    enqueue('d1');
    const f = fault(/SET state = 'dispatched'/, lost);
    const report = await dispatchOutbox(envWith(flaky(f)), deps());
    expect(f.calls).toBe(2);
    expect(report.dispatched).toBe(1);
    expect(outboxState('d1')).toBe('dispatched');
    expect(sent).toHaveLength(1);
  });

  it('is retried after it committed with the answer lost: the repeat changes nothing and nothing is sent twice', async () => {
    enqueue('d1');
    const f = fault(/SET state = 'dispatched'/, lost, 1, true);
    const report = await dispatchOutbox(envWith(flaky(f)), deps());
    expect(f.calls).toBe(2);
    expect(report.dispatched).toBe(1);
    expect(outboxState('d1')).toBe('dispatched');
    expect(sent).toHaveLength(1);
    // A second pass finds nothing to do.
    expect(await dispatchOutbox(envWith(flaky(fault(/never/, reset, 0))), deps())).toMatchObject({
      dispatched: 0,
    });
    expect(sent).toHaveLength(1);
  });
});

describe('releasing a claim after a failed send', () => {
  it('is retried, so the row goes back to pending with its error and a back-off', async () => {
    enqueue('d1');
    const f = fault(/SET state = 'pending', last_error_code/, lost, 1, true);
    const failingQueue = () => Promise.reject(new Error('queue down'));
    const report = await dispatchOutbox(envWith(flaky(f), failingQueue), deps());
    expect(f.calls).toBe(2);
    expect(report.released).toBe(1);
    const row = db.raw
      .prepare('SELECT state,last_error_code,not_before,lease_token FROM notification_outbox WHERE id=?')
      .get('d1') as {
      state: string;
      last_error_code: string;
      not_before: number;
      lease_token: string | null;
    };
    expect(row).toMatchObject({ state: 'pending', last_error_code: 'internal_error', lease_token: null });
    expect(row.not_before).toBeGreaterThan(NOW);
  });
});

describe('retiring an unreadable payload', () => {
  it('retries the batch that marks the row invalid and dead-letters its delivery together', async () => {
    enqueue('bad', 'not json');
    let batches = 0;
    const real = db.d1;
    const database = {
      prepare: real.prepare.bind(real),
      batch: (statements: D1PreparedStatement[]) => {
        batches++;
        // The first attempt fails before anything is applied; a batch is one transaction.
        if (batches === 1) throw reset();
        return real.batch(statements);
      },
    } as unknown as D1Database;
    const report = await dispatchOutbox(envWith(database), deps());
    expect(batches).toBe(2);
    expect(report.invalid).toBe(1);
    expect(outboxState('bad')).toBe('invalid');
    const delivery = db.raw.prepare("SELECT state FROM deliveries WHERE id='bad'").get() as { state: string };
    expect(delivery.state).toBe('dead_lettered');
  });
});
