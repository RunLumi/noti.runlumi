import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../../src/env';
import { evaluateAlerts } from '../../src/observability/alerts/engine';
import { ALERTS, ALERT_IDS, type AlertId } from '../../src/observability/alerts/registry';
import { collectSignals, type Signals } from '../../src/observability/alerts/signals';
import {
  ALERT_WEBHOOK_TIMEOUT_MS,
  formatAlertText,
  logSink,
  resolveWebhookTarget,
  sinksFromEnv,
  webhookSink,
  type AlertEvent,
  type AlertSink,
} from '../../src/observability/alerts/sinks';
import { decideAlert, loadAlertStates } from '../../src/observability/alerts/state';
import { NOTIFY_RETRY_MS, RENOTIFY_MS, THRESHOLDS } from '../../src/observability/alerts/thresholds';
import { assessConfig } from '../../src/platform/config';
import { sqliteTimestamp } from '../../src/delivery/claim';
import { BOOT_ENV } from '../support/boot-env';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

vi.mock('../../src/auth/better-auth', () => ({ createAuth: () => ({ handler: () => new Response(null) }) }));

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
const env = (): Pick<Bindings, 'DB'> & Partial<Bindings> => ({ ...BOOT_ENV, DB: db.d1 });

beforeEach(() => {
  db = createFakeD1();
  events = [];
});
afterEach(() => vi.restoreAllMocks());

const input = (o: Partial<Parameters<typeof decideAlert>[1]> = {}) => ({
  id: 'a',
  breached: true as boolean | null,
  value: 5,
  nowMs: 1_000_000,
  renotifyMs: 60 * MIN,
  confirmTicks: 1,
  ...o,
});

describe('alert state machine (pure)', () => {
  it('fires once on entry with an incident key, stays quiet while firing, and re-notifies on the cadence', () => {
    const fired = decideAlert(null, input());
    expect(fired.action).toBe('fire');
    expect(fired.next).toMatchObject({ state: 'firing', since: 1_000_000, dedupeKey: 'a:1000000' });
    const quiet = decideAlert(fired.next, input({ nowMs: 1_000_000 + 59 * MIN }));
    expect(quiet.action).toBe('none');
    expect(quiet.next).toBe(fired.next); // untouched: a long incident costs no D1 writes
    const again = decideAlert(fired.next, input({ nowMs: 1_000_000 + 60 * MIN }));
    expect(again.action).toBe('renotify');
    expect(again.next?.dedupeKey).toBe('a:1000000'); // same incident, same key
  });

  it('resolves once when the signal clears, and a new breach is a new incident', () => {
    const fired = decideAlert(null, input()).next;
    const resolved = decideAlert(fired, input({ breached: false, nowMs: 2_000_000 }));
    expect(resolved.action).toBe('resolve');
    expect(resolved.next).toMatchObject({ state: 'resolved', breaches: 0 });
    expect(decideAlert(resolved.next, input({ breached: false, nowMs: 3_000_000 })).action).toBe('none');
    const refired = decideAlert(resolved.next, input({ nowMs: 4_000_000 }));
    expect(refired.action).toBe('fire');
    expect(refired.next?.dedupeKey).toBe('a:4000000');
  });

  it('an unreadable signal changes nothing, whether firing or quiet', () => {
    const fired = decideAlert(null, input()).next;
    expect(decideAlert(fired, input({ breached: null }))).toEqual({ action: 'none', next: fired });
    expect(decideAlert(null, input({ breached: null }))).toEqual({ action: 'none', next: null });
  });

  it('confirmTicks: needs consecutive breaches, and a clear tick in between resets the count', () => {
    const first = decideAlert(null, input({ confirmTicks: 2 }));
    expect(first.action).toBe('none');
    expect(first.next).toMatchObject({ state: 'resolved', breaches: 1 });
    const reset = decideAlert(first.next, input({ confirmTicks: 2, breached: false }));
    expect(reset.next?.breaches).toBe(0);
    const stillOne = decideAlert(reset.next, input({ confirmTicks: 2 }));
    expect(stillOne.action).toBe('none');
    expect(decideAlert(stillOne.next, input({ confirmTicks: 2 })).action).toBe('fire');
  });
});

describe('the registry', () => {
  it('has the ten alerts, unique, each with a threshold, a severity, a cadence and a signal', () => {
    expect(ALERTS.map((a) => a.id)).toEqual([...ALERT_IDS]);
    expect(new Set(ALERT_IDS).size).toBe(ALERT_IDS.length);
    for (const a of ALERTS) {
      expect(a.threshold, a.id).toBeGreaterThan(0);
      expect(['critical', 'warning']).toContain(a.severity);
      expect(a.renotifyMs).toBe(RENOTIFY_MS[a.severity]);
      expect(a.summary.length).toBeGreaterThan(20);
      expect(a.read(QUIET), a.id).toBe(0);
    }
  });

  it('fires each alert from its own signal and no other', () => {
    for (const a of ALERTS) {
      const hot: Signals = Object.fromEntries(Object.keys(QUIET).map((k) => [k, 0])) as unknown as Signals;
      const others = ALERTS.filter((o) => o.id !== a.id);
      // Find the key this alert reads by probing: raise every signal, one at a time.
      const reads = Object.keys(QUIET).filter((k) => {
        const probe = { ...hot, [k]: a.threshold };
        return a.read(probe) === a.threshold;
      });
      expect(reads, a.id).toHaveLength(1);
      const probe = { ...hot, [reads[0] as string]: a.threshold };
      for (const o of others)
        expect(o.read(probe) ?? 0, `${a.id} must not move ${o.id}`).toBeLessThan(o.threshold);
    }
  });
});

describe('the engine over D1', () => {
  const hot = (id: AlertId, value: number): Signals => {
    const key = (Object.keys(QUIET) as (keyof Signals)[]).find(
      (k) => ALERTS.find((a) => a.id === id)?.read({ ...QUIET, [k]: 1 }) === 1,
    ) as keyof Signals;
    return { ...QUIET, [key]: value };
  };

  it('fires, dedupes, re-notifies on the cadence and resolves, persisting alert_state each time', async () => {
    const t0 = Date.now();
    const run = (signals: Signals, at: number) => evaluateAlerts(env(), at, { sinks: [recording], signals });

    expect((await run(hot('outbox_stall', 2), t0)).fired).toBe(1);
    expect(events.map((e) => e.kind)).toEqual(['firing']);
    const row = db.raw.prepare("SELECT * FROM alert_state WHERE alert_id='outbox_stall'").get() as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({
      state: 'firing',
      since: t0,
      last_notified: t0,
      last_value: 2,
      dedupe_key: `outbox_stall:${t0}`,
    });

    // Dedupe: the same breach a minute and 59 minutes later says nothing and writes nothing.
    const writes = vi.spyOn(db.d1, 'prepare');
    await run(hot('outbox_stall', 2), t0 + MIN);
    await run(hot('outbox_stall', 3), t0 + 59 * MIN);
    expect(events).toHaveLength(1);
    expect(writes.mock.calls.some((c) => /INSERT INTO alert_state/.test(String(c[0])))).toBe(false);

    // Renotify at the cadence, same incident key.
    await run(hot('outbox_stall', 3), t0 + 60 * MIN);
    expect(events.map((e) => e.kind)).toEqual(['firing', 'renotify']);
    expect(events[1]?.dedupeKey).toBe(events[0]?.dedupeKey);
    expect(events[1]?.firingForMs).toBe(60 * MIN);

    // Resolve once.
    const resolved = await run(QUIET, t0 + 61 * MIN);
    expect(resolved.resolved).toBe(1);
    await run(QUIET, t0 + 62 * MIN);
    expect(events.map((e) => e.kind)).toEqual(['firing', 'renotify', 'resolved']);
    expect((await loadAlertStates(db.d1)).get('outbox_stall')).toMatchObject({ state: 'resolved' });

    // A later breach is a new incident with a new key.
    await run(hot('outbox_stall', 2), t0 + 90 * MIN);
    expect(events[3]?.dedupeKey).toBe(`outbox_stall:${t0 + 90 * MIN}`);
  });

  it('job_stale waits for a second consecutive breach, so one post-maintenance tick never notifies', async () => {
    const t0 = Date.now();
    const run = (s: Signals, at: number) => evaluateAlerts(env(), at, { sinks: [recording], signals: s });
    await run(hot('job_stale', 5), t0);
    expect(events).toHaveLength(0);
    await run(QUIET, t0 + MIN);
    await run(hot('job_stale', 5), t0 + 2 * MIN);
    expect(events).toHaveLength(0);
    await run(hot('job_stale', 5), t0 + 3 * MIN);
    expect(events.map((e) => e.alertId)).toEqual(['job_stale']);
  });

  it('a sink that throws never fails the evaluation or starves the other sinks, and is retried soon', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken: AlertSink = {
      name: 'broken',
      notify: () => Promise.reject(new Error('https://hook.example/secret')),
    };
    const t0 = Date.now();
    const report = await evaluateAlerts(env(), t0, {
      sinks: [broken, recording],
      signals: hot('key_config_fault', 1),
    });
    expect(report.notifyFailures).toBe(1);
    expect(events).toHaveLength(1); // the sink after the broken one still ran
    const failedLine = err.mock.calls.map((c) => String(c[0])).find((l) => l.includes('alert_sink_failed'));
    expect(failedLine).toBeDefined();
    expect(failedLine).not.toContain('hook.example');
    // Retried NOTIFY_RETRY_MS after the failure, not at the one-hour cadence and not on the next tick.
    await evaluateAlerts(env(), t0 + NOTIFY_RETRY_MS - MIN, {
      sinks: [recording],
      signals: hot('key_config_fault', 1),
    });
    expect(events).toHaveLength(1);
    await evaluateAlerts(env(), t0 + NOTIFY_RETRY_MS, {
      sinks: [recording],
      signals: hot('key_config_fault', 1),
    });
    expect(events.map((e) => e.kind)).toEqual(['firing', 'renotify']);
  });

  it('an alert_state write failure is logged and the other alerts are still evaluated', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const rows = db.raw.prepare('SELECT 1').all();
    expect(rows).toBeDefined();
    const flaky = new Proxy(db.d1, {
      get(target, prop) {
        if (prop !== 'prepare') return Reflect.get(target, prop) as unknown;
        return (sql: string) => {
          if (/INSERT INTO alert_state/.test(sql)) throw new Error('D1_ERROR: boom');
          return target.prepare(sql);
        };
      },
    });
    const report = await evaluateAlerts({ ...env(), DB: flaky }, Date.now(), {
      sinks: [recording],
      signals: { ...QUIET, outboxStalled: 1, breakersOpen: 9 },
    });
    expect(report.fired).toBe(2);
    expect(events.map((e) => e.alertId).sort()).toEqual(['breaker_open_many', 'outbox_stall']);
  });

  it('an unreadable signal neither fires nor resolves', async () => {
    const t0 = Date.now();
    await evaluateAlerts(env(), t0, { sinks: [recording], signals: hot('outbox_stall', 1) });
    const report = await evaluateAlerts(env(), t0 + MIN, {
      sinks: [recording],
      signals: { ...QUIET, outboxStalled: null },
    });
    expect(report.unknown).toBe(1);
    expect(events.map((e) => e.kind)).toEqual(['firing']);
    expect((await loadAlertStates(db.d1)).get('outbox_stall')?.state).toBe('firing');
  });
});

describe('signals from D1 and the boot report', () => {
  const seedDelivery = (state: string, createdAt: number, extra: Record<string, unknown> = {}) =>
    db.raw
      .prepare(
        'INSERT INTO deliveries(id,integration_id,organization_id,state,created_at,claimed_at,next_attempt_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        typeof extra.id === 'string' ? extra.id : crypto.randomUUID(),
        'i',
        'org-a',
        state,
        sqliteTimestamp(createdAt),
        (extra.claimedAt as number | undefined) ?? null,
        (extra.nextAttemptAt as number | undefined) ?? null,
      );

  beforeEach(() => seedOrganization(db.raw, 'org-a'));

  it('reads every signal as a number from a healthy empty database', async () => {
    const now = Date.now();
    const s = await collectSignals(env(), now);
    for (const [k, v] of Object.entries(s)) expect(v, k).toEqual(expect.any(Number));
    expect(s.keyConfigFaults).toBe(0);
  });

  it('measures backlog age, dead-letter stuck rows, breakers, drops, quarantine and heartbeat gaps', async () => {
    const now = Date.now();
    seedDelivery('pending', now - 20 * MIN);
    seedDelivery('pending', now - 7 * 60 * MIN); // old enough for the DLQ proxy too
    seedDelivery('claimed', now - 8 * 60 * MIN, { claimedAt: now - 7 * 60 * MIN });
    seedDelivery('retrying', now - 9 * 60 * MIN, { nextAttemptAt: now - 7 * 60 * MIN });
    seedDelivery('retrying', now - 9 * 60 * MIN, { nextAttemptAt: now + 60 * MIN }); // waiting by design
    db.raw
      .prepare(
        "INSERT INTO destination_health(organization_id,integration_id,state,updated_at) VALUES('org-a','i1','open',1),('org-a','i2','half_open',1),('org-a','i3','closed',1)",
      )
      .run();
    db.raw
      .prepare(
        "INSERT INTO delivery_attempts(id,organization_id,delivery_id,integration_id,attempt,started_at,finished_at,outcome) VALUES('a1','org-a','d','i',1,?,?,'dead_lettered'),('a2','org-a','d','i',2,?,?,'dead_lettered')",
      )
      .run(now - MIN, now - MIN, now - 60 * MIN, now - 60 * MIN);
    for (const t of [0, 1, 2, 7, 20]) {
      db.raw
        .prepare(
          "INSERT INTO job_runs(job,started_at,finished_at,outcome,healthy) VALUES('heartbeat',?,?,'ok',1)",
        )
        .run(now - t * MIN, now - t * MIN);
    }
    const s = await collectSignals(env(), now);
    expect(s.oldestPendingAgeMs).toBeGreaterThanOrEqual(7 * 60 * MIN);
    expect(s.deadLetterStuckRows).toBe(3); // old pending, old claim, overdue retry; not the future retry
    expect(s.breakersOpen).toBe(2);
    expect(s.deadLettersRecent).toBe(1); // only the attempt inside the window
    expect(s.heartbeatMaxGapMs).toBe(13 * MIN); // 7 -> 20 minutes ago
  });

  it('counts a boot-report fault as key_config_fault', async () => {
    const s = await collectSignals({ ...env(), KEK_V1: 'not-hex' }, Date.now());
    expect(s.keyConfigFaults).toBeGreaterThanOrEqual(THRESHOLDS.keyConfigFaults);
  });

  it('a signal whose query fails is null (unknown), not 0', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    db.raw.exec('DROP TABLE destination_health');
    const s = await collectSignals(env(), Date.now());
    expect(s.breakersOpen).toBeNull();
    expect(s.outboxStalled).toBe(0);
  });

  it('counts quarantined integrations', async () => {
    const now = Date.now();
    db.raw
      .prepare(
        "INSERT INTO integrations(id,organization_id,repo,event_types,destination,webhook_ciphertext,name,credentials_quarantined_at) VALUES('q1','org-a','r','[]','slack','c','n','2026-10-01 00:00:00')",
      )
      .run();
    const s = await collectSignals(env(), now);
    expect(s.credentialsQuarantined).toBe(1);
  });
});

describe('sinks', () => {
  const event = (o: Partial<AlertEvent> = {}): AlertEvent => ({
    kind: 'firing',
    alertId: 'outbox_stall',
    severity: 'critical',
    summary: 'Deliveries are not moving.',
    value: 4,
    threshold: 1,
    unit: 'count',
    dedupeKey: 'outbox_stall:1',
    firingForMs: 0,
    environment: 'production',
    ...o,
  });

  it('the log sink always logs one structured line, at error for firing and info for resolved', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await logSink.notify(event());
    await logSink.notify(event({ kind: 'resolved' }));
    const line = JSON.parse(String(err.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(line).toMatchObject({
      msg: 'alert_firing',
      alert: 'outbox_stall',
      severity: 'critical',
      incident: 'outbox_stall:1',
    });
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({ msg: 'alert_resolved' });
  });

  it('alert text carries ids and numbers only, with the runbook anchor and the incident key', () => {
    const text = formatAlertText(event());
    expect(text).toContain('FIRING outbox_stall (critical)');
    expect(text).toContain('docs/RUNBOOK.md#alert-outbox_stall');
    expect(text).toContain('Key outbox_stall:1');
    expect(formatAlertText(event({ kind: 'resolved', firingForMs: 7 * MIN }))).toContain('RESOLVED');
    expect(formatAlertText(event({ value: 20 * MIN, unit: 'ms' }))).toContain('Value 20 min');
  });

  it('accepts only Slack, Discord, Lark and Teams webhook URLs, through the destination URL policy', () => {
    expect(resolveWebhookTarget(SLACK_HOOK)?.kind).toBe('slack');
    expect(resolveWebhookTarget('https://open.larksuite.com/open-apis/bot/v2/hook/abc')?.kind).toBe('lark');
    expect(
      resolveWebhookTarget(
        'https://prod-1.westus.logic.azure.com/workflows/a/triggers/manual/paths/invoke?sig=x',
      )?.kind,
    ).toBe('teams');
    expect(resolveWebhookTarget('https://discord.com/api/webhooks/123456789012345678/tok-en_1')?.kind).toBe(
      'discord',
    );
    for (const bad of [
      'https://evil.example.com/hook',
      'http://hooks.slack.com/services/T000/B000/x',
      'https://hooks.slack.com.evil.example/services/T000/B000/x',
      'https://user:pw@hooks.slack.com/services/T000/B000/x',
      'https://hooks.slack.com:8443/services/T000/B000/x',
      'https://169.254.169.254/latest',
      'https://localhost/hook',
      '',
      undefined,
    ])
      expect(resolveWebhookTarget(bad), String(bad)).toBeNull();
  });

  it('without a valid URL the log sink is the only sink; with one the webhook is added', () => {
    expect(sinksFromEnv({}).map((s) => s.name)).toEqual(['log']);
    expect(sinksFromEnv({ ALERT_WEBHOOK_URL: 'https://evil.example.com/x' }).map((s) => s.name)).toEqual([
      'log',
    ]);
    expect(sinksFromEnv({ ALERT_WEBHOOK_URL: SLACK_HOOK }).map((s) => s.name)).toEqual(['log', 'webhook']);
  });

  it('posts Slack-compatible JSON once, with the policy timeout, and never follows a redirect', async () => {
    const target = resolveWebhookTarget(SLACK_HOOK);
    if (!target) throw new Error('fixture');
    const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(new Response('ok', { status: 200 })),
    );
    await webhookSink(target, { fetch: fetchMock }).notify(event());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(SLACK_HOOK);
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(ALERT_WEBHOOK_TIMEOUT_MS).toBe(10_000);
    expect(JSON.parse(init?.body as string)).toEqual({
      text: expect.stringContaining('FIRING outbox_stall'),
    });
  });

  it.each([
    ['https://discord.com/api/webhooks/123456789012345678/tok-en_1', 'content'],
    ['https://open.larksuite.com/open-apis/bot/v2/hook/abc', 'msg_type'],
    ['https://prod-1.westus.logic.azure.com/workflows/a/triggers/manual/paths/invoke?sig=x', 'attachments'],
  ])('formats the body for %s', async (url, key) => {
    const target = resolveWebhookTarget(url);
    if (!target) throw new Error('fixture');
    const answers = {
      lark: () => new Response(JSON.stringify({ code: 0 }), { status: 200 }),
      teams: () => new Response('', { status: 202 }),
      discord: () => new Response(null, { status: 204 }),
      slack: () => new Response('ok', { status: 200 }),
    };
    const fetchMock = vi.fn((_u: string, _i: RequestInit) => Promise.resolve(answers[target.kind]()));
    await webhookSink(target, { fetch: fetchMock }).notify(event());
    expect(Object.keys(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string))).toContain(key);
  });

  it('a rejection, a timeout or a redirect rejects with a closed code and never echoes the URL', async () => {
    const target = resolveWebhookTarget(SLACK_HOOK);
    if (!target) throw new Error('fixture');
    for (const response of [
      () => Promise.resolve(new Response('no_service', { status: 404 })),
      () =>
        Promise.resolve(new Response('', { status: 302, headers: { location: 'https://evil.example/' } })),
      () => Promise.reject(Object.assign(new Error(`failed ${SLACK_HOOK}`), { name: 'TimeoutError' })),
    ]) {
      const error = await webhookSink(target, { fetch: vi.fn(response) })
        .notify(event())
        .then(
          () => null,
          (e: unknown) => e as Error,
        );
      expect(error?.message).toMatch(/^alert_webhook_/);
      expect(error?.message).not.toContain('hooks.slack.com');
    }
  });

  it('makes exactly one request per notification: no retry storm on failure', async () => {
    const target = resolveWebhookTarget(SLACK_HOOK);
    if (!target) throw new Error('fixture');
    const fetchMock = vi.fn(() => Promise.resolve(new Response('', { status: 500 })));
    await webhookSink(target, { fetch: fetchMock })
      .notify(event())
      .catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('ALERT_WEBHOOK_URL in the boot report', () => {
  it('is optional: unset is clean, a valid chat webhook is clean, anything else is a warning only', () => {
    const base = BOOT_ENV as unknown as Parameters<typeof assessConfig>[0];
    const withDb = { ...base, DB: db.d1 };
    expect(assessConfig(withDb).warnings).not.toContain('ALERT_WEBHOOK_URL');
    expect(assessConfig({ ...withDb, ALERT_WEBHOOK_URL: SLACK_HOOK }).warnings).not.toContain(
      'ALERT_WEBHOOK_URL',
    );
    const bad = assessConfig({ ...withDb, ALERT_WEBHOOK_URL: 'https://evil.example.com/x' });
    expect(bad.warnings).toContain('ALERT_WEBHOOK_URL');
    expect([...bad.storage, ...bad.credentials, ...bad.queue]).toEqual([]); // never a fault
  });
});

describe('the alert job inside the cron tick', () => {
  const seedStuckOutbox = () => {
    seedOrganization(db.raw, 'org-a');
    db.raw
      .prepare(
        "INSERT INTO notification_outbox(id,payload_json,state,organization_id,created_at) VALUES('s','{}','pending','org-a',?)",
      )
      .run(sqliteTimestamp(Date.now() - 3_600_000));
  };
  const quiet = () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    return vi.spyOn(console, 'error').mockImplementation(() => undefined);
  };
  const tick = (extra: Record<string, unknown> = {}, database: D1Database = db.d1) =>
    worker.scheduled({} as ScheduledEvent, { ...BOOT_ENV, DB: database, ...extra } as unknown as Bindings);

  it('records an `alerts` run, fires from real D1 state and writes the log sink line', async () => {
    const err = quiet();
    seedStuckOutbox();
    await tick().catch(() => undefined);
    expect(db.raw.prepare("SELECT state FROM alert_state WHERE alert_id='outbox_stall'").get()).toEqual({
      state: 'firing',
    });
    expect(err.mock.calls.some((c) => String(c[0]).includes('alert_firing'))).toBe(true);
    expect(db.raw.prepare("SELECT outcome FROM job_runs WHERE job='alerts'").get()).toEqual({
      outcome: 'ok',
    });
  });

  it('a webhook that is down never breaks the cron tick, and only one request per notification is made', async () => {
    quiet();
    seedStuckOutbox();
    const fetchMock = vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED')));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const baseline = await tick({}, createFakeD1().d1).then(
        () => 'resolved',
        () => 'rejected',
      );
      const outcome = await tick({ ALERT_WEBHOOK_URL: SLACK_HOOK }).then(
        () => 'resolved',
        () => 'rejected',
      );
      expect(outcome).toBe(baseline);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(db.raw.prepare("SELECT outcome FROM job_runs WHERE job='alerts'").get()).toEqual({
        outcome: 'ok',
      });
      expect(db.raw.prepare("SELECT state FROM alert_state WHERE alert_id='outbox_stall'").get()).toEqual({
        state: 'firing',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a Worker that cannot boot still evaluates alerts: key_config_fault fires from the failed tick', async () => {
    quiet();
    await expect(tick({ KEK_V1: 'not-hex' })).rejects.toThrow(/config_invalid/);
    expect(db.raw.prepare("SELECT state FROM alert_state WHERE alert_id='key_config_fault'").get()).toEqual({
      state: 'firing',
    });
    expect(db.raw.prepare('SELECT job FROM job_runs ORDER BY id').all()).toEqual([
      { job: 'heartbeat' },
      { job: 'stall_detection' },
      { job: 'alerts' },
    ]);
  });
});
