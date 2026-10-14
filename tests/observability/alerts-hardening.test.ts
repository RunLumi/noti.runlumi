import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../../src/env';
import { evaluateAlerts } from '../../src/observability/alerts/engine';
import type { Signals } from '../../src/observability/alerts/signals';
import { readSinkHealth } from '../../src/observability/alerts/sink-health';
import {
  resolveWebhookTarget,
  webhookSink,
  type AlertEvent,
  type AlertSink,
} from '../../src/observability/alerts/sinks';
import { loadAlertStates } from '../../src/observability/alerts/state';
import { NOTIFY_RETRY_MS, SINK_BUDGET_MS } from '../../src/observability/alerts/thresholds';
import { markMaintenanceSkip, writeHeartbeat } from '../../src/observability/cron';
import { BOOT_ENV } from '../support/boot-env';
import { createFakeD1, type FakeD1 } from '../support/d1';
import { caller, setup, type Harness } from '../sources/harness';

vi.mock('../../src/auth/better-auth', async () => (await import('../sources/harness')).mockAuth());
const { default: worker } = await import('../../src/index');

const MIN = 60_000;
const SLACK_HOOK = 'https://hooks.slack.com/services/T000/B000/AlertFixtureToken';
const QUIET: Signals = {
  jobsStale: 0,
  outboxStalled: 0,
  deadLettersRecent: 0,
  breakersOpen: 0,
  keyConfigFaults: 0,
  credentialsQuarantined: 0,
  oldestPendingAgeMs: 0,
  sourcesDropping: 0,
  heartbeatMaxGapMs: 0,
  deadLetterStuckRows: 0,
};

let db: FakeD1;
let events: AlertEvent[];
const recording: AlertSink = {
  name: 'recording',
  notify: (e) => {
    events.push(e);
    return Promise.resolve();
  },
};
const env = () => ({ ...BOOT_ENV, DB: db.d1 }) as unknown as Pick<Bindings, 'DB'> & Partial<Bindings>;
const quiet = () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  return vi.spyOn(console, 'error').mockImplementation(() => undefined);
};

beforeEach(() => {
  db = createFakeD1();
  events = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('H1: a maintenance window is not a missed cron', () => {
  const gapOf = () => db.raw.prepare("SELECT value FROM ops_state WHERE key='cron_gap'").get();

  it('ten minutes of skipped ticks under MAINTENANCE_MODE, then a normal tick: no gap, no alert', async () => {
    const info = quiet();
    expect(info).toBeDefined();
    const e = { ...BOOT_ENV, DB: db.d1 } as unknown as Bindings;
    await worker.scheduled({} as ScheduledEvent, e).catch(() => undefined); // a healthy tick first
    for (let i = 1; i <= 10; i++) {
      vi.setSystemTime(Date.now() + MIN);
      await worker.scheduled({} as ScheduledEvent, { ...e, MAINTENANCE_MODE: 'true' });
    }
    vi.setSystemTime(Date.now() + MIN);
    await worker.scheduled({} as ScheduledEvent, e).catch(() => undefined);
    expect(gapOf()).toBeUndefined();
    vi.setSystemTime(Date.now() + MIN);
    await worker.scheduled({} as ScheduledEvent, e).catch(() => undefined);
    const firing = db.raw.prepare("SELECT alert_id FROM alert_state WHERE state='firing'").all();
    expect(firing).toEqual([]);
  });

  it('the same ten-minute silence WITHOUT a maintenance marker is recorded as a gap and the alert fires', async () => {
    quiet();
    const e = { ...BOOT_ENV, DB: db.d1 } as unknown as Bindings;
    await worker.scheduled({} as ScheduledEvent, e).catch(() => undefined);
    vi.setSystemTime(Date.now() + 10 * MIN);
    await worker.scheduled({} as ScheduledEvent, e).catch(() => undefined);
    expect(JSON.parse((gapOf() as { value: string }).value)).toMatchObject({ gapMs: 10 * MIN });
    vi.setSystemTime(Date.now() + MIN);
    await worker.scheduled({} as ScheduledEvent, e).catch(() => undefined);
    expect(
      db.raw.prepare("SELECT state FROM alert_state WHERE alert_id='cron_heartbeat_missing'").get(),
    ).toEqual({
      state: 'firing',
    });
  });

  it('a maintenance skip long after another starts a new window; consecutive skips extend one', async () => {
    const t = Date.now();
    await markMaintenanceSkip(db.d1, t);
    await markMaintenanceSkip(db.d1, t + MIN);
    await markMaintenanceSkip(db.d1, t + 2 * MIN);
    const read = () =>
      JSON.parse(
        (
          db.raw.prepare("SELECT value FROM ops_state WHERE key='cron_maintenance'").get() as {
            value: string;
          }
        ).value,
      ) as { from: number; to: number };
    expect(read()).toEqual({ from: t, to: t + 2 * MIN });
    await markMaintenanceSkip(db.d1, t + 60 * MIN);
    expect(read()).toEqual({ from: t + 60 * MIN, to: t + 60 * MIN });
  });

  it('writeHeartbeat: a normal cadence and a short gap record nothing', async () => {
    const t = Date.now();
    await writeHeartbeat(db.d1, t);
    await writeHeartbeat(db.d1, t + MIN);
    await writeHeartbeat(db.d1, t + 4 * MIN);
    expect(gapOf()).toBeUndefined();
  });

  it('a marker from an OLDER window does not explain a later gap', async () => {
    const t = Date.now();
    await markMaintenanceSkip(db.d1, t);
    await writeHeartbeat(db.d1, t + MIN);
    await writeHeartbeat(db.d1, t + 20 * MIN);
    expect(JSON.parse((gapOf() as { value: string }).value)).toMatchObject({ gapMs: 19 * MIN });
  });
});

describe('M1: hysteresis stops a flapping signal from flapping the channel', () => {
  it('a signal alternating around its threshold sends one FIRING and no RESOLVED until it stays clear', async () => {
    const t0 = Date.now();
    const hot = { ...QUIET, outboxStalled: 3 };
    const run = (s: Signals, at: number) => evaluateAlerts(env(), at, { sinks: [recording], signals: s });
    await run(hot, t0);
    for (let i = 1; i <= 12; i++) await run(i % 2 === 0 ? hot : QUIET, t0 + i * MIN);
    expect(events.map((e) => e.kind)).toEqual(['firing']);
    // Now three clear evaluations in a row.
    await run(QUIET, t0 + 13 * MIN);
    await run(QUIET, t0 + 14 * MIN);
    expect(events.map((e) => e.kind)).toEqual(['firing']);
    await run(QUIET, t0 + 15 * MIN);
    expect(events.map((e) => e.kind)).toEqual(['firing', 'resolved']);
  });
});

describe('M2: sink health, re-sent kinds and the shared budget', () => {
  const broken: AlertSink = {
    name: 'webhook',
    notify: () => Promise.reject(new Error('alert_webhook_retryable:network_error')),
  };
  const working: AlertSink = { name: 'webhook', notify: () => Promise.resolve() };

  it('records the last success, last failure and consecutive failures in ops_state', async () => {
    quiet();
    const t0 = Date.now();
    const hot = { ...QUIET, keyConfigFaults: 1 };
    await evaluateAlerts(env(), t0, { sinks: [broken], signals: hot });
    await evaluateAlerts(env(), t0 + NOTIFY_RETRY_MS, { sinks: [broken], signals: hot });
    expect(await readSinkHealth(db.d1)).toEqual({
      lastSuccessAt: null,
      lastFailureAt: t0 + NOTIFY_RETRY_MS,
      consecutiveFailures: 2,
    });
    await evaluateAlerts(env(), t0 + 2 * NOTIFY_RETRY_MS, { sinks: [working], signals: hot });
    expect(await readSinkHealth(db.d1)).toMatchObject({
      lastSuccessAt: t0 + 2 * NOTIFY_RETRY_MS,
      consecutiveFailures: 0,
    });
  });

  it('a failed RESOLVED is retried as RESOLVED, and a firing that failed then cleared sends only the resolve', async () => {
    quiet();
    const t0 = Date.now();
    const hot = { ...QUIET, keyConfigFaults: 1 };
    const sent: string[] = [];
    let up = false;
    const flaky: AlertSink = {
      name: 'webhook',
      notify: (e) => {
        if (!up) return Promise.reject(new Error('down'));
        sent.push(e.kind);
        return Promise.resolve();
      },
    };
    up = true;
    await evaluateAlerts(env(), t0, { sinks: [flaky], signals: hot });
    up = false;
    for (let i = 1; i <= 3; i++)
      await evaluateAlerts(env(), t0 + i * MIN, { sinks: [flaky], signals: QUIET });
    expect(sent).toEqual(['firing']);
    expect((await loadAlertStates(db.d1)).get('key_config_fault')).toMatchObject({
      state: 'resolved',
      unsent: 'resolved',
      notifyFailures: 1,
    });
    up = true;
    await evaluateAlerts(env(), t0 + 3 * MIN + NOTIFY_RETRY_MS, { sinks: [flaky], signals: QUIET });
    expect(sent).toEqual(['firing', 'resolved']);

    // A FIRING that never got through, then the signal clears before the retry: the resolve replaces it.
    up = false;
    const t1 = t0 + 60 * MIN;
    await evaluateAlerts(env(), t1, { sinks: [flaky], signals: { ...QUIET, breakersOpen: 9 } });
    up = true;
    for (let i = 1; i <= 3; i++)
      await evaluateAlerts(env(), t1 + i * MIN, { sinks: [flaky], signals: QUIET });
    expect(sent).toEqual(['firing', 'resolved', 'resolved']);
  });

  it('gives up on a notice after the retry budget, and logs that it did', async () => {
    const err = quiet();
    const t0 = Date.now();
    const hot = { ...QUIET, keyConfigFaults: 1 };
    for (let i = 0; i < 6; i++)
      await evaluateAlerts(env(), t0 + i * NOTIFY_RETRY_MS, { sinks: [broken], signals: hot });
    expect(err.mock.calls.some((c) => String(c[0]).includes('alert_notice_dropped'))).toBe(true);
    expect((await loadAlertStates(db.d1)).get('key_config_fault')?.unsent).toBeNull();
  });

  it('a hung webhook cannot hold the tick: a call is bounded by what is left of the shared budget', async () => {
    const target = resolveWebhookTarget(SLACK_HOOK);
    if (!target) throw new Error('fixture');
    const hangs = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'TimeoutError')));
        }),
    );
    const started = performance.now();
    const outcome = await webhookSink(target, { fetch: hangs })
      .notify(
        {
          kind: 'firing',
          alertId: 'job_stale',
          severity: 'critical',
          summary: 's',
          value: 1,
          threshold: 1,
          unit: 'count',
          dedupeKey: 'k',
          firingForMs: 0,
          environment: 'production',
        },
        { timeoutMs: 40 },
      )
      .then(
        () => 'ok',
        (e: Error) => e.message,
      );
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(outcome).toMatch(/^alert_webhook_/);
  });

  it('once the budget is spent, later webhook notices are skipped (and retried later), the log still runs', async () => {
    const err = quiet();
    const t0 = Date.now();
    const slow: AlertSink = {
      name: 'webhook',
      notify: () => {
        vi.setSystemTime(Date.now() + SINK_BUDGET_MS + 1);
        return Promise.reject(new Error('alert_webhook_retryable:provider_timeout'));
      },
    };
    const report = await evaluateAlerts(env(), t0, {
      sinks: [{ ...recording, name: 'log' }, slow],
      signals: { ...QUIET, keyConfigFaults: 1, breakersOpen: 9, oldestPendingAgeMs: 99 * MIN },
    });
    expect(report.fired).toBe(3);
    expect(events).toHaveLength(3); // the log-like sink ran for every alert
    expect(err.mock.calls.some((c) => String(c[0]).includes('budget_exhausted'))).toBe(true);
    const states = await loadAlertStates(db.d1);
    expect([...states.values()].filter((r) => r.unsent === 'firing')).toHaveLength(3);
  });
});

describe('M3: the webhook secret', () => {
  it('is trimmed: a pasted trailing newline or space still resolves', () => {
    expect(resolveWebhookTarget(`${SLACK_HOOK}\n`)?.url).toBe(SLACK_HOOK);
    expect(resolveWebhookTarget(`  ${SLACK_HOOK} `)?.url).toBe(SLACK_HOOK);
    expect(resolveWebhookTarget('   ')).toBeNull();
  });

  it('set but unusable: a warning every tick, the log sink still runs, nothing is sent', async () => {
    quiet();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const e = { ...env(), ALERT_WEBHOOK_URL: 'https://evil.example.com/x' };
    for (let i = 0; i < 2; i++)
      await evaluateAlerts(e, Date.now() + i * MIN, { signals: { ...QUIET, keyConfigFaults: 1 } });
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('alert_webhook_unusable'))).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the summary: operational detail is for admins', () => {
  let h: Harness;
  const call = caller(worker, () => h);
  beforeEach(() => {
    h = setup();
    h.db.raw
      .prepare(
        "INSERT INTO job_state(job,first_seen_at,last_started_at,last_finished_at,last_outcome,last_healthy_at) VALUES('dedup_purge',1,1,1,'ok',1)",
      )
      .run();
    h.db.raw
      .prepare("INSERT INTO ops_state(key,value,updated_at) VALUES('alert_sink_health',?,1)")
      .run(JSON.stringify({ lastSuccessAt: 5, lastFailureAt: 9, consecutiveFailures: 2 }));
  });

  it('an admin sees the job list and the webhook health; no URL ever', async () => {
    const res = await call('GET', '/api/observability/summary', { as: 'alice', org: 'org-a' });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.jobsStatus).toBe('degraded');
    expect(
      (body.jobs as { name: string; stale: boolean }[]).find((j) => j.name === 'dedup_purge')?.stale,
    ).toBe(true);
    expect(body.alerting).toEqual({
      webhookConfigured: false,
      lastSuccessAt: 5,
      lastFailureAt: 9,
      consecutiveFailures: 2,
    });
    expect(JSON.stringify(body)).not.toMatch(/hooks\.slack|https?:\/\//);
  });

  it('a member gets only a coarse verdict', async () => {
    const res = await call('GET', '/api/observability/summary', { as: 'bob', org: 'org-a' });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.jobsStatus).toBe('degraded');
    expect(body).not.toHaveProperty('jobs');
    expect(body).not.toHaveProperty('alerting');
  });
});
