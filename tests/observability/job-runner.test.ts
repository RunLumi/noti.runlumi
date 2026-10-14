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

const runs = () =>
  db.raw.prepare('SELECT job,outcome,healthy,counters_json,error_class FROM job_runs ORDER BY id').all() as {
    job: string;
    outcome: string;
    healthy: number;
    counters_json: string | null;
    error_class: string | null;
  }[];

describe('runCronJobs records every execution in job_runs (F192)', () => {
  it('writes ok, failed and skipped rows with counters and a closed error class, in one batch', async () => {
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
    expect(runs()).toEqual([
      { job: 'a', outcome: 'ok', healthy: 1, counters_json: '{"rows":3}', error_class: null },
      { job: 'b', outcome: 'failed', healthy: 0, counters_json: null, error_class: 'database' },
      { job: 'c', outcome: 'skipped', healthy: 1, counters_json: null, error_class: null },
      { job: 'd', outcome: 'ok', healthy: 1, counters_json: null, error_class: null },
    ]);
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it('never stores an error message: the text of a failure appears nowhere in the table', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      runCronJobs([{ name: 'x', run: () => Promise.reject(new Error('secret-token-abc123 in message')) }], {
        recorder: createJobRecorder(db.d1),
      }),
    ).rejects.toThrow();
    const dump = JSON.stringify(db.raw.prepare('SELECT * FROM job_runs').all());
    expect(dump).not.toContain('abc123');
    expect(JOB_ERROR_CLASSES).toContain(runs()[0]?.error_class);
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
    expect(counters).not.toHaveProperty('Bad');
    expect(counters).not.toHaveProperty('neg');
    expect(counters).not.toHaveProperty('frac');
    expect(counters).not.toHaveProperty('str');
    expect(counters).not.toHaveProperty('huge');
    expect(normaliseReport('x')).toEqual({ skipped: false, counters: {} });
  });

  it('a recording failure is swallowed: jobs still run and the tick does not fail because of it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    db.raw.exec('DROP TABLE job_runs');
    const ran: string[] = [];
    await expect(
      runCronJobs([{ name: 'a', run: () => Promise.resolve(void ran.push('a')) }], {
        recorder: createJobRecorder(db.d1),
      }),
    ).resolves.toBeUndefined();
    expect(ran).toEqual(['a']);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('job_runs_write_failed'))).toBe(true);
  });

  it('a job with flushBefore sees the rows of the jobs before it', async () => {
    let seen = -1;
    await runCronJobs(
      [
        { name: 'one', run: () => Promise.resolve() },
        { name: 'two', run: () => Promise.resolve() },
        {
          name: 'three',
          flushBefore: true,
          run: () => {
            seen = (db.raw.prepare('SELECT COUNT(*) AS n FROM job_runs').get() as { n: number }).n;
            return Promise.resolve();
          },
        },
      ],
      { recorder: createJobRecorder(db.d1) },
    );
    expect(seen).toBe(2);
    expect(runs()).toHaveLength(3);
  });
});

describe('staleness (F192: overdue by more than three cadences)', () => {
  const insert = (job: string, finishedAt: number, healthy = 1) =>
    db.raw
      .prepare('INSERT INTO job_runs(job,started_at,finished_at,outcome,healthy) VALUES(?,?,?,?,?)')
      .run(job, finishedAt - 1, finishedAt, healthy ? 'ok' : 'failed', healthy);

  it('is the cadence table times three, and nothing else', () => {
    for (const name of JOB_NAMES) {
      expect(JOB_CADENCE[name].staleAfterMs).toBe(JOB_CADENCE[name].intervalMs * STALE_AFTER_CADENCES);
    }
    const now = 10_000_000;
    expect(isStale('heartbeat', now - 3 * MIN, null, now)).toBe(false);
    expect(isStale('heartbeat', now - 3 * MIN - 1, null, now)).toBe(true);
  });

  it('is computed from job_runs: fresh jobs are fine, an overdue one is stale, a failing one goes stale', async () => {
    const now = Date.now();
    for (const name of JOB_NAMES) insert(name, now - MIN);
    insert('retention_purge', now - 10 * MIN); // older healthy run
    db.raw.prepare("DELETE FROM job_runs WHERE job='dedup_purge'").run();
    insert('dedup_purge', now - 4 * MIN); // overdue
    insert('noise_purge', now - 30_000, 0); // failing, but its last healthy run is a minute old: fine
    const health = await readJobHealth(db.d1, now);
    const byName = Object.fromEntries(health.map((j) => [j.name, j]));
    expect(byName.dedup_purge).toMatchObject({ stale: true, lastOk: now - 4 * MIN, lastFailed: null });
    expect(byName.heartbeat).toMatchObject({ stale: false, lastOk: now - MIN });
    expect(byName.noise_purge).toMatchObject({ stale: false, lastFailed: now - 30_000 });
    expect(byName.retention_purge?.lastOk).toBe(now - MIN);
    expect(health.map((j) => j.name)).toEqual([...JOB_NAMES]);
    // Time moves: a failing job whose healthy runs stopped goes stale after three cadences.
    vi.setSystemTime(now + 3 * MIN + 1);
    const later = await readJobHealth(db.d1, Date.now());
    expect(later.find((j) => j.name === 'noise_purge')?.stale).toBe(true);
  });

  it('a job that never ran is stale only once the table has been collecting longer than three cadences', async () => {
    const now = Date.now();
    expect((await readJobHealth(db.d1, now)).some((j) => j.stale)).toBe(false); // empty table: no verdict
    insert('heartbeat', now - MIN);
    expect((await readJobHealth(db.d1, now)).find((j) => j.name === 'alerts')?.stale).toBe(false);
    db.raw.prepare('DELETE FROM job_runs').run();
    insert('heartbeat', now - 10 * MIN);
    expect((await readJobHealth(db.d1, now)).find((j) => j.name === 'alerts')?.stale).toBe(true);
  });

  it('reads one index point-lookup per job, never the table', () => {
    const plan = db.raw
      .prepare(
        "EXPLAIN QUERY PLAN SELECT MAX(r.finished_at) FROM job_runs r WHERE r.job = 'x' AND r.healthy = 1",
      )
      .all() as { detail: string }[];
    expect(plan.map((p) => p.detail).join('\n')).toMatch(/USING (COVERING )?INDEX job_runs_job_healthy/);
  });

  it('is surfaced in the workspace summary as jobs: [{name,lastOk,lastFailed,stale}]', async () => {
    seedOrganization(db.raw, 'org-a');
    const now = Date.now();
    insert('heartbeat', now - MIN);
    insert('dedup_purge', now - 20 * MIN);
    const summary = await computeSummary(db.d1, 'org-a', 3_600_000, now);
    expect(summary.jobs).toHaveLength(JOB_NAMES.length);
    expect(summary.jobs?.find((j) => j.name === 'dedup_purge')).toEqual({
      name: 'dedup_purge',
      lastOk: now - 20 * MIN,
      lastFailed: null,
      stale: true,
    });
    // Names and times only: nothing tenant-derived can be in it.
    expect(Object.keys(summary.jobs?.[0] ?? {}).sort()).toEqual(['lastFailed', 'lastOk', 'name', 'stale']);
  });
});

describe('the scheduler and the cadence table agree (single source)', () => {
  const env = (): Bindings => ({ ...BOOT_ENV, DB: db.d1 }) as unknown as Bindings;

  it('records exactly one row per cadence-table job per tick, and every scheduled name is in the table', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    seedOrganization(db.raw, 'org-a');
    await worker.scheduled({} as ScheduledEvent, env()).catch(() => undefined);
    const recorded = runs().map((r) => r.job);
    expect([...recorded].sort()).toEqual([...JOB_NAMES].sort());
    const scheduled = [
      ...readFileSync(join(root, 'src/index.ts'), 'utf8').matchAll(/name: '([a-z_]+)'/g),
    ].map((m) => m[1] ?? '');
    for (const name of scheduled) expect(isJobName(name), name).toBe(true);
    expect(new Set(scheduled)).toEqual(new Set(JOB_NAMES));
  });

  it('records a throttled retention purge as skipped on the second tick, and a failing job as failed', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await worker.scheduled({} as ScheduledEvent, env()).catch(() => undefined);
    vi.setSystemTime(Date.now() + MIN);
    await worker.scheduled({} as ScheduledEvent, env()).catch(() => undefined);
    const retention = runs().filter((r) => r.job === 'retention_purge');
    expect(retention.map((r) => r.outcome)).toEqual(['ok', 'skipped']);

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
    const failed = runs().filter((r) => r.outcome === 'failed');
    expect(failed).toEqual([
      {
        job: 'credential_maintenance',
        outcome: 'failed',
        healthy: 0,
        counters_json: null,
        error_class: 'database',
      },
    ]);
  });

  it('writes nothing during a maintenance window (the write freeze holds)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await worker.scheduled({} as ScheduledEvent, { ...env(), MAINTENANCE_MODE: 'true' });
    expect(runs()).toEqual([]);
  });
});

describe('retention of job_runs', () => {
  it('purges rows older than three days in bounded rounds, and keeps newer ones', async () => {
    const now = Date.now();
    const ins = db.raw.prepare(
      "INSERT INTO job_runs(job,started_at,finished_at,outcome,healthy) VALUES('heartbeat',?,?, 'ok',1)",
    );
    for (let i = 0; i < 30; i++)
      ins.run(now - JOB_RUNS_RETENTION_MS - i - 1_000, now - JOB_RUNS_RETENTION_MS);
    ins.run(now - JOB_RUNS_RETENTION_MS + 60_000, now);
    const report = await purgeExpiredRecords({ DB: db.d1 }, now);
    expect(report.jobRuns).toBe(30);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM job_runs').get()).toEqual({ n: 1 });
  });

  it('the purge range-seeks the started_at index', () => {
    const plan = db.raw
      .prepare('EXPLAIN QUERY PLAN SELECT rowid FROM job_runs WHERE started_at < 1 LIMIT 5')
      .all() as { detail: string }[];
    expect(plan.map((p) => p.detail).join('\n')).toMatch(/job_runs_started/);
  });
});
