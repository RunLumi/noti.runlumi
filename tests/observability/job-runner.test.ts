import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../../src/env';
import { JOB_CADENCE, JOB_NAMES, STALE_AFTER_CADENCES, isJobName } from '../../src/observability/cadence';
import { runCronJobs } from '../../src/observability/cron';
import { isStale, readJobHealth } from '../../src/observability/job-health';
import {
  JOB_ERROR_CLASSES,
  JOB_RUNS_RETENTION_MS,
  classifyJobError,
  createJobRecorder,
  normaliseReport,
} from '../../src/observability/job-runs';
import { computeSummary } from '../../src/observability/slis';
import { purgeExpiredRecords } from '../../src/pipeline/retention';
import { CryptoError } from '../../src/crypto/envelope';
import { BOOT_ENV } from '../support/boot-env';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

vi.mock('../../src/auth/better-auth', () => ({ createAuth: () => ({ handler: () => new Response(null) }) }));
const { default: worker } = await import('../../src/index');

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const MIN = 60_000;

let db: FakeD1;
beforeEach(() => {
  db = createFakeD1();
});
afterEach(() => vi.restoreAllMocks());

interface HistoryRow {
  job: string;
  outcome: string;
  healthy: number;
  counters_json: string | null;
  error_class: string | null;
}
const history = () =>
  db.raw
    .prepare('SELECT job,outcome,healthy,counters_json,error_class FROM job_runs ORDER BY id')
    .all() as unknown as HistoryRow[];
const state = (job: string) =>
  db.raw.prepare('SELECT * FROM job_state WHERE job=?').get(job) as Record<string, unknown> | undefined;

describe('runCronJobs records every execution (F192)', () => {
  it('upserts job_state for ok, failed and skipped, with counters and a closed error class, in one batch', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const batch = vi.spyOn(db.d1, 'batch');
    await expect(
      runCronJobs(
        [
          { name: 'a', run: () => Promise.resolve({ counters: { rows: 3 } }) },
          { name: 'b', run: () => Promise.reject(new Error('D1_ERROR: boom token=abc123')) },
          { name: 'c', run: () => Promise.resolve({ skipped: true }) },
          { name: 'd', run: () => Promise.resolve(undefined) },
        ],
        { recorder: createJobRecorder(db.d1) },
      ),
    ).rejects.toThrow('cron jobs failed: b');
    expect(state('a')).toMatchObject({ last_outcome: 'ok', last_counters_json: '{"rows":3}', runs: 1 });
    expect(state('b')).toMatchObject({
      last_outcome: 'failed',
      last_healthy_at: null,
      last_error_class: 'database',
    });
    expect(state('c')).toMatchObject({ last_outcome: 'skipped' });
    expect(state('d')).toMatchObject({ last_outcome: 'ok', last_counters_json: null });
    // First runs of each job, plus the failure: all four are history rows this once.
    expect(history().map((h) => [h.job, h.outcome])).toEqual([
      ['a', 'ok'],
      ['b', 'failed'],
      ['c', 'skipped'],
      ['d', 'ok'],
    ]);
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it('a steady healthy job writes one state upsert a tick and NO history; a change of outcome writes one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let fail = false;
    const job = {
      name: 'steady',
      run: () => (fail ? Promise.reject(new Error('boom')) : Promise.resolve({ counters: { n: 1 } })),
    };
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(Date.now() + MIN);
      await runCronJobs([job], { recorder: createJobRecorder(db.d1) });
    }
    expect(history()).toHaveLength(1); // the first run only
    expect(state('steady')).toMatchObject({ runs: 5, last_outcome: 'ok' });
    fail = true;
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(Date.now() + MIN);
      await runCronJobs([job], { recorder: createJobRecorder(db.d1) }).catch(() => undefined);
    }
    fail = false;
    vi.setSystemTime(Date.now() + MIN);
    await runCronJobs([job], { recorder: createJobRecorder(db.d1) });
    // first ok, then every failure (3), then the recovery (an outcome change): 5 rows over 9 runs.
    expect(history().map((h) => h.outcome)).toEqual(['ok', 'failed', 'failed', 'failed', 'ok']);
    expect(state('steady')).toMatchObject({ runs: 9, last_outcome: 'ok' });
    expect(state('steady')?.last_failed_at).not.toBeNull();
  });

  it('never stores an error message: the text of a failure appears nowhere in D1', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      runCronJobs([{ name: 'x', run: () => Promise.reject(new Error('secret-token-abc123 in message')) }], {
        recorder: createJobRecorder(db.d1),
      }),
    ).rejects.toThrow();
    const dump = JSON.stringify([
      db.raw.prepare('SELECT * FROM job_runs').all(),
      db.raw.prepare('SELECT * FROM job_state').all(),
    ]);
    expect(dump).not.toContain('abc123');
    expect(JOB_ERROR_CLASSES).toContain(history()[0]?.error_class);
  });

  it('classifies errors into the closed vocabulary from their shape', () => {
    expect(classifyJobError(new CryptoError('malformed_envelope'))).toBe('crypto');
    expect(classifyJobError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('timeout');
    expect(classifyJobError(new Error('config_invalid: KEK_V1'))).toBe('config');
    expect(classifyJobError(new Error('no such table: job_runs'))).toBe('database');
    expect(classifyJobError('a string')).toBe('internal');
  });

  it('keeps counters to a handful of well-formed non-negative integers', () => {
    const { counters } = normaliseReport({
      counters: {
        ok: 1,
        Bad: 2,
        neg: -1,
        frac: 1.5,
        str: '3',
        huge: 1e12,
        a: 1,
        b: 2,
        c: 3,
        d: 4,
        e: 5,
        f: 6,
        g: 7,
      },
    });
    expect(Object.keys(counters).length).toBeLessThanOrEqual(8);
    for (const bad of ['Bad', 'neg', 'frac', 'str', 'huge']) expect(counters).not.toHaveProperty(bad);
    expect(normaliseReport('x')).toEqual({ skipped: false, counters: {} });
  });

  it('a recording failure is swallowed: jobs still run and the tick does not fail because of it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    db.raw.exec('DROP TABLE job_state');
    const ran: string[] = [];
    await expect(
      runCronJobs([{ name: 'a', run: () => Promise.resolve(void ran.push('a')) }], {
        recorder: createJobRecorder(db.d1),
      }),
    ).resolves.toBeUndefined();
    expect(ran).toEqual(['a']);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('job_runs_write_failed'))).toBe(true);
  });

  it('a job with flushBefore sees the state of the jobs before it', async () => {
    let seen = -1;
    await runCronJobs(
      [
        { name: 'one', run: () => Promise.resolve() },
        { name: 'two', run: () => Promise.resolve() },
        {
          name: 'three',
          flushBefore: true,
          run: () => {
            seen = (db.raw.prepare('SELECT COUNT(*) AS n FROM job_state').get() as { n: number }).n;
            return Promise.resolve();
          },
        },
      ],
      { recorder: createJobRecorder(db.d1) },
    );
    expect(seen).toBe(2);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM job_state').get()).toEqual({ n: 3 });
  });
});

describe('staleness (F192: overdue by more than three cadences)', () => {
  const seed = (job: string, o: { ok?: number | null; failed?: number | null; first?: number }) =>
    db.raw
      .prepare(
        `INSERT INTO job_state(job,first_seen_at,last_started_at,last_finished_at,last_outcome,last_healthy_at,last_failed_at)
         VALUES(?,?,?,?,?,?,?)`,
      )
      .run(job, o.first ?? 1, 1, 1, o.ok === null ? 'failed' : 'ok', o.ok ?? null, o.failed ?? null);

  it('is the cadence table times three, and nothing else', () => {
    for (const name of JOB_NAMES) {
      expect(JOB_CADENCE[name].staleAfterMs).toBe(JOB_CADENCE[name].intervalMs * STALE_AFTER_CADENCES);
    }
    const now = 10_000_000;
    expect(isStale('heartbeat', now - 3 * MIN, null, now)).toBe(false);
    expect(isStale('heartbeat', now - 3 * MIN - 1, null, now)).toBe(true);
  });

  it('is computed from job_state: fresh jobs are fine, an overdue one is stale, a failing one goes stale', async () => {
    const now = Date.now();
    for (const name of JOB_NAMES) seed(name, { ok: now - MIN });
    db.raw.prepare("DELETE FROM job_state WHERE job IN ('dedup_purge','noise_purge')").run();
    seed('dedup_purge', { ok: now - 4 * MIN });
    seed('noise_purge', { ok: now - MIN, failed: now - 30_000 });
    const health = await readJobHealth(db.d1, now);
    const byName = Object.fromEntries(health.map((j) => [j.name, j]));
    expect(byName.dedup_purge).toMatchObject({ stale: true, lastOk: now - 4 * MIN, lastFailed: null });
    expect(byName.heartbeat).toMatchObject({ stale: false, lastOk: now - MIN });
    expect(byName.noise_purge).toMatchObject({ stale: false, lastFailed: now - 30_000 });
    expect(health.map((j) => j.name)).toEqual([...JOB_NAMES]);
    vi.setSystemTime(now + 3 * MIN + 1);
    expect((await readJobHealth(db.d1, Date.now())).find((j) => j.name === 'noise_purge')?.stale).toBe(true);
  });

  it('a job with no record has no deadline: a job added by a later release never reads stale', async () => {
    const now = Date.now();
    seed('heartbeat', { ok: now - 10 * MIN, first: now - 30 * 86_400_000 });
    const health = await readJobHealth(db.d1, now);
    expect(health.find((j) => j.name === 'alerts')).toMatchObject({ stale: false, lastOk: null });
    expect(health.find((j) => j.name === 'heartbeat')?.stale).toBe(true);
    expect((await readJobHealth(createFakeD1().d1, now)).some((j) => j.stale)).toBe(false); // empty table
  });

  it('a job that ran but was never healthy goes stale from ITS OWN first run', async () => {
    const now = Date.now();
    seed('dedup_purge', { ok: null, failed: now - MIN, first: now - 2 * MIN });
    expect((await readJobHealth(db.d1, now)).find((j) => j.name === 'dedup_purge')?.stale).toBe(false);
    vi.setSystemTime(now + 2 * MIN);
    expect((await readJobHealth(db.d1, Date.now())).find((j) => j.name === 'dedup_purge')?.stale).toBe(true);
  });

  it('is surfaced in the summary as jobs: [{name,lastOk,lastFailed,stale}]', async () => {
    seedOrganization(db.raw, 'org-a');
    const now = Date.now();
    seed('dedup_purge', { ok: now - 20 * MIN });
    const summary = await computeSummary(db.d1, 'org-a', 3_600_000, now);
    expect(summary.jobs).toHaveLength(JOB_NAMES.length);
    expect(summary.jobs?.find((j) => j.name === 'dedup_purge')).toEqual({
      name: 'dedup_purge',
      lastOk: now - 20 * MIN,
      lastFailed: null,
      stale: true,
    });
    expect(Object.keys(summary.jobs?.[0] ?? {}).sort()).toEqual(['lastFailed', 'lastOk', 'name', 'stale']);
  });

  it('a summary whose job state cannot be read says null and logs, never an empty "all fine" list', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    seedOrganization(db.raw, 'org-a');
    db.raw.exec('DROP TABLE job_state');
    expect((await computeSummary(db.d1, 'org-a', 3_600_000, Date.now())).jobs).toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('summary_jobs_unreadable'))).toBe(true);
  });
});

describe('the scheduler and the cadence table agree (single source)', () => {
  const env = (): Bindings => ({ ...BOOT_ENV, DB: db.d1 }) as unknown as Bindings;
  const quiet = () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  };

  it('records one state row per cadence-table job per tick, and every scheduled name is in the table', async () => {
    quiet();
    seedOrganization(db.raw, 'org-a');
    await worker.scheduled({} as ScheduledEvent, env()).catch(() => undefined);
    const recorded = (db.raw.prepare('SELECT job FROM job_state').all() as { job: string }[]).map(
      (r) => r.job,
    );
    expect([...recorded].sort()).toEqual([...JOB_NAMES].sort());
    const scheduled = [
      ...readFileSync(join(root, 'src/index.ts'), 'utf8').matchAll(/name: '([a-z_]+)'/g),
    ].map((m) => m[1] ?? '');
    for (const name of scheduled) expect(isJobName(name), name).toBe(true);
    expect(new Set(scheduled)).toEqual(new Set(JOB_NAMES));
  });

  it('records a throttled retention purge as skipped on the second tick, and a failing job as failed', async () => {
    quiet();
    await worker.scheduled({} as ScheduledEvent, env()).catch(() => undefined);
    vi.setSystemTime(Date.now() + MIN);
    await worker.scheduled({} as ScheduledEvent, env()).catch(() => undefined);
    expect(state('retention_purge')).toMatchObject({ last_outcome: 'skipped', runs: 2 });
    expect(
      history()
        .filter((h) => h.job === 'retention_purge')
        .map((h) => h.outcome),
    ).toEqual(['ok', 'skipped']);

    const failing = new Proxy(db.d1, {
      get(target, prop) {
        if (prop !== 'prepare') return Reflect.get(target, prop) as unknown;
        return (sql: string) => {
          if (/kek_version IS NOT/.test(sql)) throw new Error('D1_ERROR: boom');
          return target.prepare(sql);
        };
      },
    });
    vi.setSystemTime(Date.now() + MIN);
    await expect(
      worker.scheduled({} as ScheduledEvent, { ...BOOT_ENV, DB: failing } as unknown as Bindings),
    ).rejects.toThrow(/credential_maintenance/);
    expect(history().filter((h) => h.outcome === 'failed')).toEqual([
      {
        job: 'credential_maintenance',
        outcome: 'failed',
        healthy: 0,
        counters_json: null,
        error_class: 'database',
      },
    ]);
  });

  it('writes no job state during a maintenance window (only the one skip marker)', async () => {
    quiet();
    await worker.scheduled({} as ScheduledEvent, { ...env(), MAINTENANCE_MODE: 'true' });
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM job_state').get()).toEqual({ n: 0 });
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM job_runs').get()).toEqual({ n: 0 });
    expect(db.raw.prepare("SELECT key FROM ops_state WHERE key='cron_maintenance'").get()).toBeDefined();
  });
});

describe('retention of job_runs', () => {
  it('purges history older than the retention in bounded rounds, and keeps newer rows; job_state stays', async () => {
    const now = Date.now();
    const ins = db.raw.prepare(
      "INSERT INTO job_runs(job,started_at,finished_at,outcome,healthy) VALUES('heartbeat',?,?, 'failed',0)",
    );
    for (let i = 0; i < 30; i++)
      ins.run(now - JOB_RUNS_RETENTION_MS - i - 1_000, now - JOB_RUNS_RETENTION_MS);
    ins.run(now - JOB_RUNS_RETENTION_MS + 60_000, now);
    db.raw
      .prepare(
        "INSERT INTO job_state(job,first_seen_at,last_started_at,last_finished_at,last_outcome) VALUES('heartbeat',1,1,1,'ok')",
      )
      .run();
    const report = await purgeExpiredRecords({ DB: db.d1 }, now);
    expect(report.jobRuns).toBe(30);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM job_runs').get()).toEqual({ n: 1 });
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM job_state').get()).toEqual({ n: 1 });
  });

  it('the purge range-seeks the started_at index', () => {
    const plan = db.raw
      .prepare('EXPLAIN QUERY PLAN SELECT rowid FROM job_runs WHERE started_at < 1 LIMIT 5')
      .all() as { detail: string }[];
    expect(plan.map((p) => p.detail).join('\n')).toMatch(/job_runs_started/);
  });
});
