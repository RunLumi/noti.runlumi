import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../../src/env';
import { evaluateAlerts } from '../../src/observability/alerts/engine';
import { ALERTS } from '../../src/observability/alerts/registry';
import { collectSignals } from '../../src/observability/alerts/signals';
import type { AlertEvent, AlertSink } from '../../src/observability/alerts/sinks';
import { THRESHOLDS } from '../../src/observability/alerts/thresholds';
import {
  DECRYPT_FAILURES_KEY,
  recentDecryptFailures,
  recordDecryptFailure,
} from '../../src/observability/credential-decrypt';
import { BOOT_ENV } from '../support/boot-env';
import { createFakeD1, type FakeD1 } from '../support/d1';

/**
 * F97 (ADR 0054): credential decrypt failures at send time are counted in `ops_state` (no migration) and raise
 * `credential_decrypt_failures` through the ADR 0024 engine: fire, dedupe, resolve.
 */
const MIN = 60_000;
const WINDOW = THRESHOLDS.decryptFailureWindowMs;

let db: FakeD1;
let events: AlertEvent[];
const recording: AlertSink = {
  name: 'recording',
  notify: (e) => {
    events.push(e);
    return Promise.resolve();
  },
};
const env = (): Pick<Bindings, 'DB'> & Partial<Bindings> => ({ ...BOOT_ENV, DB: db.d1 });
const stored = () =>
  db.raw.prepare('SELECT value FROM ops_state WHERE key=?').get(DECRYPT_FAILURES_KEY) as
    { value: string } | undefined;

beforeEach(() => {
  db = createFakeD1();
  events = [];
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('the decrypt-failure count in ops_state', () => {
  it('reads 0 with no record, counts a burst, and reads 0 once the last failure is older than the window', async () => {
    const t0 = 1_700_000_000_000;
    expect(await recentDecryptFailures(db.d1, t0)).toBe(0);
    await recordDecryptFailure(db.d1, t0);
    await recordDecryptFailure(db.d1, t0 + MIN);
    await recordDecryptFailure(db.d1, t0 + 2 * MIN);
    expect(await recentDecryptFailures(db.d1, t0 + 2 * MIN)).toBe(3);
    expect(JSON.parse(stored()?.value ?? '{}')).toEqual({ since: t0, at: t0 + 2 * MIN, count: 3 });
    expect(await recentDecryptFailures(db.d1, t0 + 2 * MIN + WINDOW)).toBe(3);
    expect(await recentDecryptFailures(db.d1, t0 + 2 * MIN + WINDOW + 1)).toBe(0);
  });

  it('a failure after a quiet gap longer than the window starts a new burst at 1', async () => {
    const t0 = 1_700_000_000_000;
    await recordDecryptFailure(db.d1, t0);
    await recordDecryptFailure(db.d1, t0 + MIN);
    await recordDecryptFailure(db.d1, t0 + MIN + WINDOW + 1);
    expect(JSON.parse(stored()?.value ?? '{}')).toEqual({
      since: t0 + MIN + WINDOW + 1,
      at: t0 + MIN + WINDOW + 1,
      count: 1,
    });
  });

  it('concurrent failures lose no count (one atomic upsert, no read-modify-write)', async () => {
    const t0 = 1_700_000_000_000;
    await Promise.all(Array.from({ length: 25 }, (_, i) => recordDecryptFailure(db.d1, t0 + i)));
    expect(await recentDecryptFailures(db.d1, t0 + 25)).toBe(25);
  });

  it('a stored value that is not JSON is replaced by a fresh burst, and reads 0 until then', async () => {
    const t0 = 1_700_000_000_000;
    db.raw
      .prepare('INSERT INTO ops_state(key,value,updated_at) VALUES(?,?,?)')
      .run(DECRYPT_FAILURES_KEY, 'not json', t0);
    expect(await recentDecryptFailures(db.d1, t0)).toBe(0);
    await recordDecryptFailure(db.d1, t0);
    expect(await recentDecryptFailures(db.d1, t0)).toBe(1);
  });

  it('a failed write is logged and swallowed: counting never fails the delivery', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken = {
      prepare: () => {
        throw new Error('D1_ERROR: no such table');
      },
    } as unknown as D1Database;
    await expect(recordDecryptFailure(broken, Date.now())).resolves.toBeUndefined();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('credential_decrypt_count_failed'))).toBe(true);
  });

  it('holds counts and times only: no tenant, integration, code or key in the record', async () => {
    await recordDecryptFailure(db.d1, 1_700_000_000_000);
    expect(Object.keys(JSON.parse(stored()?.value ?? '{}')).sort()).toEqual(['at', 'count', 'since']);
  });
});

describe('credential_decrypt_failures alert', () => {
  const alertEvents = () => events.filter((e) => e.alertId === 'credential_decrypt_failures');
  const evaluate = (at: number) => evaluateAlerts(env(), at, { sinks: [recording] });

  it('is registered as critical and fires on one failure, with no confirmation tick', () => {
    const def = ALERTS.find((a) => a.id === 'credential_decrypt_failures');
    expect(def).toMatchObject({ severity: 'critical', threshold: 1, confirmTicks: 1, clearTicks: 3 });
  });

  it('fires once, dedupes further failures into the same incident, and resolves after the window', async () => {
    const t0 = Date.now();
    await recordDecryptFailure(db.d1, t0);
    await evaluate(t0);
    expect(alertEvents().map((e) => e.kind)).toEqual(['firing']);
    expect(alertEvents()[0]).toMatchObject({
      value: 1,
      threshold: 1,
      severity: 'critical',
      dedupeKey: `credential_decrypt_failures:${t0}`,
    });

    // More failures while it fires: the same incident, nothing new is sent.
    for (let i = 1; i <= 5; i++) {
      await recordDecryptFailure(db.d1, t0 + i * MIN);
      await evaluate(t0 + i * MIN);
    }
    expect(alertEvents().map((e) => e.kind)).toEqual(['firing']);

    // Still inside the window after the last failure: still firing, no repeat.
    await evaluate(t0 + 5 * MIN + WINDOW);
    expect(alertEvents().map((e) => e.kind)).toEqual(['firing']);

    // Clear once the window has passed, then three clear evaluations: one RESOLVED, same key.
    const clear = t0 + 5 * MIN + WINDOW + 1;
    await evaluate(clear);
    await evaluate(clear + MIN);
    expect(alertEvents().map((e) => e.kind)).toEqual(['firing']);
    await evaluate(clear + 2 * MIN);
    expect(alertEvents().map((e) => e.kind)).toEqual(['firing', 'resolved']);
    expect(alertEvents()[1]?.dedupeKey).toBe(`credential_decrypt_failures:${t0}`);

    // A later failure is a new incident with a new key.
    const later = clear + 10 * MIN;
    await recordDecryptFailure(db.d1, later);
    await evaluate(later);
    expect(alertEvents().map((e) => e.kind)).toEqual(['firing', 'resolved', 'firing']);
    expect(alertEvents()[2]?.dedupeKey).toBe(`credential_decrypt_failures:${later}`);
  });

  it('an unreadable record reads unknown (null), never 0, so a D1 error cannot resolve it', async () => {
    const t0 = Date.now();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const real = db.d1;
    const failing = {
      ...real,
      prepare: (sql: string) => {
        if (sql.includes('FROM ops_state WHERE key=?1')) throw new Error('D1_ERROR: overloaded');
        return real.prepare(sql);
      },
    } as unknown as D1Database;
    const s = await collectSignals({ ...env(), DB: failing }, t0 + WINDOW + MIN);
    expect(s.credentialDecryptFailures).toBeNull();
  });
});
