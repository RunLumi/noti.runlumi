import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../../src/env';
import {
  MAX_ATTEMPTS,
  NOTIFICATION_BUDGET,
  UNITS_PER_TICK,
  releaseHeldEvents,
} from '../../src/pipeline/noise-release';
import { DEFAULT_NOISE, HELD_CAPACITY, type NoiseSettings } from '../../src/routing/noise';
import {
  comment,
  count,
  createHarness,
  heldRows,
  insertIntegration,
  outboxMessages,
  postGithub,
  setNow,
  type Harness,
} from './harness';

/**
 * The release job's resource and failure behaviour: a per-tick notification budget (bounded D1
 * calls however large the backlog), paused integrations waiting, poison rows backing off and
 * dead-lettering without starving healthy ones, and display data blanked after release.
 */
const settings = (over: Partial<NoiseSettings>): NoiseSettings => ({ ...DEFAULT_NOISE, ...over });
const grouped = settings({ groupWindowSec: 300 });
const quiet = settings({ timezone: 'Asia/Ho_Chi_Minh', quietHours: { start: '22:00', end: '08:00' } });
const T0 = Date.parse('2026-10-15T01:05:00Z');

let h: Harness;
let tokens = 0;
const at = (ms: number) => ({ now: () => ms, token: () => `token-${++tokens}` });

beforeEach(() => {
  h = createHarness();
  tokens = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const insertRows = (
  integration: string,
  n: number,
  over: { reason?: string; releaseAt?: number; org?: string; prefix?: string } = {},
): void => {
  const stmt = h.db.raw.prepare(
    `INSERT INTO held_events(id,organization_id,integration_id,hold_reason,group_key,state,release_at,held_at,event_type,title,url,repo,actor,status,summary)
     VALUES(?,?,?,?,?,'held',?,?,'issues.opened',?,?,'acme/web','octocat','info','a summary')`,
  );
  for (let i = 0; i < n; i++)
    stmt.run(
      `${over.prefix ?? integration}-${i}`,
      over.org ?? 'org-a',
      integration,
      over.reason ?? 'grouped',
      String(i).padStart(32, '0'),
      over.releaseAt ?? 1000,
      2000 + i,
      `Title ${i}`,
      `https://github.com/acme/web/issues/${i}`,
    );
};

/** Counts every D1 call (a statement run/first/all, or a whole batch) made through the binding. */
interface Wrapped {
  readonly env: Bindings;
  calls(): number;
  reset(): void;
}
function counted(env: Bindings, shouldFailBatch?: (statements: { params: unknown[] }[]) => boolean): Wrapped {
  const db = env.DB;
  let n = 0;
  type Inner = { params: unknown[] };
  const wrap = (inner: unknown): unknown => {
    const stmt = inner as D1PreparedStatement & Inner;
    return {
      inner: stmt,
      params: stmt.params,
      bind: (...args: unknown[]) => wrap(stmt.bind(...args)),
      first: () => {
        n++;
        return stmt.first();
      },
      all: () => {
        n++;
        return stmt.all();
      },
      run: () => {
        n++;
        return stmt.run();
      },
    };
  };
  const wrapped = {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    exec: db.exec.bind(db),
    batch: (statements: { inner: Inner }[]) => {
      n++;
      if (shouldFailBatch?.(statements.map((s) => s.inner)))
        return Promise.reject(new Error('D1 unavailable'));
      return db.batch(statements.map((s) => s.inner) as unknown as D1PreparedStatement[]);
    },
  };
  return {
    env: { ...env, DB: wrapped as unknown as D1Database },
    calls: () => n,
    reset: () => {
      n = 0;
    },
  };
}

describe('the per-tick notification budget', () => {
  it('releases 500 distinct group keys over several ticks with a small, bounded number of D1 calls each', async () => {
    insertIntegration(h, 'i1', 'org-a', grouped);
    insertRows('i1', HELD_CAPACITY);
    const probe = counted(h.env);
    let ticks = 0;
    let created = 0;
    while (count(h, 'held_events', "state='held'") > 0) {
      probe.reset();
      const report = await releaseHeldEvents(probe.env, at(T0 + ticks * 60_000));
      ticks++;
      created += report.notifications;
      // Bounded work per invocation: not one call per row, not one per notification.
      expect(report.notifications).toBeLessThanOrEqual(NOTIFICATION_BUDGET);
      expect(probe.calls()).toBeLessThanOrEqual(20);
      // Nothing is claimed that the tick did not process.
      expect(count(h, 'held_events', "state='claimed'")).toBe(0);
      if (ticks > 20) throw new Error('did not drain');
    }
    expect(ticks).toBe(HELD_CAPACITY / NOTIFICATION_BUDGET);
    expect(created).toBe(HELD_CAPACITY);
    // Every row was released exactly once: 500 deliveries, 500 outbox rows, no duplicates, none lost.
    expect(count(h, 'deliveries')).toBe(HELD_CAPACITY);
    expect(count(h, 'notification_outbox')).toBe(HELD_CAPACITY);
    expect(new Set(outboxMessages(h).map((m) => m.id)).size).toBe(HELD_CAPACITY);
    expect(count(h, 'held_events', "state='released'")).toBe(HELD_CAPACITY);
  });

  it('shares one budget across integrations and never visits more than UNITS_PER_TICK', async () => {
    for (let i = 0; i < 30; i++) {
      insertIntegration(h, `i${i}`, 'org-a', grouped);
      insertRows(`i${i}`, 10);
    }
    const first = await releaseHeldEvents(h.env, at(T0));
    expect(first.notifications).toBeLessThanOrEqual(NOTIFICATION_BUDGET);
    expect(first.units).toBeLessThanOrEqual(UNITS_PER_TICK);
    let guard = 0;
    while (count(h, 'held_events', "state='held'") > 0 && guard++ < 20)
      await releaseHeldEvents(h.env, at(T0 + guard * 60_000));
    expect(count(h, 'deliveries')).toBe(300);
  });

  it('honours a smaller budget and leaves the rest held and due', async () => {
    insertIntegration(h, 'i1', 'org-a', grouped);
    insertRows('i1', 25);
    const report = await releaseHeldEvents(h.env, { ...at(T0), budget: 10 });
    expect(report.notifications).toBe(10);
    expect(count(h, 'held_events', "state='held'")).toBe(15);
    expect(count(h, 'held_events', "state='claimed'")).toBe(0);
  });

  it('a digest counts as the parts it needs, so it cannot overshoot the budget by much', async () => {
    insertIntegration(h, 'i1', 'org-a', quiet);
    insertRows('i1', 100, { reason: 'quiet_hours' });
    const report = await releaseHeldEvents(h.env, { ...at(T0), budget: 1 });
    expect(report.notifications).toBeLessThanOrEqual(3);
  });
});

describe('paused integrations wait', () => {
  it('rows of a disabled integration stay held, nothing is dead-lettered, and they release once it is enabled', async () => {
    insertIntegration(h, 'i1', 'org-a', quiet);
    insertRows('i1', 3, { reason: 'quiet_hours' });
    h.db.raw.prepare("UPDATE integrations SET enabled=0 WHERE id='i1'").run();
    expect(await releaseHeldEvents(h.env, at(T0))).toMatchObject({ events: 0, notifications: 0 });
    expect(count(h, 'deliveries')).toBe(0);
    expect(heldRows(h).every((r) => r.state === 'held')).toBe(true);
    // A week later it is still waiting: retention never touches unreleased rows.
    expect(await releaseHeldEvents(h.env, at(T0 + 7 * 86_400_000))).toMatchObject({ events: 0 });
    h.db.raw.prepare("UPDATE integrations SET enabled=1 WHERE id='i1'").run();
    expect(await releaseHeldEvents(h.env, at(T0 + 7 * 86_400_000))).toMatchObject({ events: 3 });
    expect(count(h, 'deliveries')).toBe(1);
  });

  it('rows of an integration with quarantined credentials wait too', async () => {
    insertIntegration(h, 'i1', 'org-a', quiet);
    insertRows('i1', 2, { reason: 'quiet_hours' });
    h.db.raw
      .prepare("UPDATE integrations SET credentials_quarantined_at=CURRENT_TIMESTAMP WHERE id='i1'")
      .run();
    expect(await releaseHeldEvents(h.env, at(T0))).toMatchObject({ events: 0 });
    h.db.raw.prepare("UPDATE integrations SET credentials_quarantined_at=NULL WHERE id='i1'").run();
    expect(await releaseHeldEvents(h.env, at(T0))).toMatchObject({ events: 2 });
  });

  it('a paused integration does not hold up a healthy one', async () => {
    insertIntegration(h, 'paused', 'org-a', quiet);
    insertIntegration(h, 'live', 'org-a', quiet);
    insertRows('paused', 5, { reason: 'quiet_hours', releaseAt: 500 });
    insertRows('live', 2, { reason: 'quiet_hours' });
    h.db.raw.prepare("UPDATE integrations SET enabled=0 WHERE id='paused'").run();
    expect(await releaseHeldEvents(h.env, at(T0))).toMatchObject({ events: 2, units: 1 });
  });
});

describe('poison rows', () => {
  const poison = (ids: readonly string[]) => (statements: { params: unknown[] }[]) =>
    statements.some(
      (s) => ids.some((id) => s.params.includes(id)) && s.params.includes('pending') === false,
    ) && statements.some((s) => ids.some((id) => s.params.includes(id)));

  it('back off after each failure, die after MAX_ATTEMPTS as visible failed rows, and are never retried again', async () => {
    insertIntegration(h, 'bad', 'org-a', quiet);
    insertRows('bad', 3, { reason: 'quiet_hours' });
    const probe = counted(h.env, poison(['bad']));
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Each attempt happens after the previous backoff (at most an hour).
      await expect(releaseHeldEvents(probe.env, at(T0 + attempt * 2 * 3_600_000))).rejects.toThrow();
      const rows = heldRows(h) as unknown as { attempts: number; state: string; last_error_class: string }[];
      expect(rows.every((r) => r.attempts === attempt)).toBe(true);
      expect(rows.every((r) => r.state === (attempt === MAX_ATTEMPTS ? 'failed' : 'held'))).toBe(true);
    }
    expect(heldRows(h)[0]).toMatchObject({ last_error_class: 'batch_failed' });
    // Failed for good: never due again, never released, still stored and visible.
    probe.reset();
    expect(await releaseHeldEvents(probe.env, at(T0 + 100 * 3_600_000))).toMatchObject({ events: 0 });
    expect(probe.calls()).toBeLessThanOrEqual(3);
    expect(count(h, 'deliveries')).toBe(0);
    expect(count(h, 'held_events', "state='failed'")).toBe(3);
  });

  it('a row inside its backoff window is not attempted again', async () => {
    insertIntegration(h, 'bad', 'org-a', quiet);
    insertRows('bad', 1, { reason: 'quiet_hours' });
    const probe = counted(h.env, poison(['bad']));
    await expect(releaseHeldEvents(probe.env, at(T0))).rejects.toThrow();
    probe.reset();
    // 30 s later (the first backoff is a minute): due-units query only, no claim, no batch.
    expect(await releaseHeldEvents(probe.env, at(T0 + 30_000))).toMatchObject({ events: 0 });
    expect(probe.calls()).toBeLessThanOrEqual(2);
  });

  it('25 poison integrations cannot starve a healthy one', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `bad${i}`);
    for (const id of ids) {
      insertIntegration(h, id, 'org-a', quiet);
      insertRows(id, 2, { reason: 'quiet_hours', releaseAt: 1000 });
    }
    insertIntegration(h, 'good', 'org-a', quiet);
    insertRows('good', 2, { reason: 'quiet_hours', releaseAt: 5000 });
    const probe = counted(h.env, poison(ids));
    // Tick 1 spends its units on the 20 earliest poison integrations and they all fail.
    await expect(releaseHeldEvents(probe.env, at(T0))).rejects.toThrow();
    // Tick 2, seconds later: those 20 are backing off, so the healthy one is reached.
    await expect(releaseHeldEvents(probe.env, at(T0 + 5_000))).rejects.toThrow();
    expect(count(h, 'deliveries', "integration_id='good'")).toBe(1);
    expect(count(h, 'held_events', "integration_id='good' AND state='released'")).toBe(2);
  });

  it('an abandoned claim (a crashed run) counts as an attempt too', async () => {
    insertIntegration(h, 'i1', 'org-a', quiet);
    insertRows('i1', 1, { reason: 'quiet_hours' });
    h.db.raw
      .prepare("UPDATE held_events SET state='claimed', claim_token='dead', claim_expires_at=?")
      .run(T0 - 1);
    await releaseHeldEvents(h.env, at(T0));
    expect(heldRows(h)[0]).toMatchObject({ state: 'held' });
    expect(h.db.raw.prepare('SELECT attempts, last_error_class FROM held_events').get()).toEqual({
      attempts: 1,
      last_error_class: 'lease_expired',
    });
  });
});

describe('released rows keep only what dedupe and the log join need', () => {
  it('blanks title, summary, link, actor and repository, and keeps id, reason and the carrier', async () => {
    insertIntegration(h, 'i1', 'org-a', quiet);
    setNow('2026-10-14T16:00:00Z');
    await postGithub(h, 'issue_comment', comment(7, 'SECRET-BODY-TEXT'), 'gh-1');
    await postGithub(h, 'issue_comment', comment(8), 'gh-2');
    await releaseHeldEvents(h.env, at(Date.parse('2026-10-15T01:05:00Z')));
    const rows = h.db.raw
      .prepare(
        'SELECT id, hold_reason, state, released_in, title, summary, url, actor, repo FROM held_events',
      )
      .all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    const carrier = (h.db.raw.prepare('SELECT id FROM deliveries').get() as { id: string }).id;
    for (const row of rows) {
      expect(row).toMatchObject({
        hold_reason: 'quiet_hours',
        state: 'released',
        released_in: carrier,
        title: '',
        summary: '',
        url: '',
        actor: '',
        repo: '',
      });
      expect(String(row.id)).toMatch(/^[0-9a-f]{64}$/);
    }
    // The notification itself still carries what was sent.
    expect(outboxMessages(h)[0]?.summary).toContain('Issue 7');
  });

  it('a redelivery after release is still recognised from the blank row (no second send)', async () => {
    insertIntegration(h, 'i1', 'org-a', quiet);
    setNow('2026-10-14T16:00:00Z');
    await postGithub(h, 'issue_comment', comment(7), 'gh-1');
    await releaseHeldEvents(h.env, at(Date.parse('2026-10-15T01:05:00Z')));
    setNow('2026-10-15T02:00:00Z');
    await postGithub(h, 'issue_comment', comment(7), 'gh-1');
    expect(count(h, 'deliveries')).toBe(1);
    expect(count(h, 'held_events')).toBe(1);
  });
});

describe('ingress reads', () => {
  it('does not read the backlog when the update is delivered at once, only when it is held', async () => {
    insertIntegration(h, 'i1', 'org-a', quiet);
    const probe = counted(h.env);
    const wrapped: Harness = { ...h, env: probe.env };
    // Noon in Ho Chi Minh: not quiet, nothing groups: delivered, with no extra held_events read.
    setNow('2026-10-14T05:00:00Z');
    const spy = vi.spyOn(h.db.d1, 'prepare');
    await postGithub(wrapped, 'issue_comment', comment(1), 'gh-1');
    const sqls = (): string[] => spy.mock.calls.map((c) => String(c[0]));
    expect(sqls().filter((s) => s.includes('COUNT(*) AS n'))).toEqual([]);
    spy.mockClear();
    // 23:00: held, which needs the backlog and open-group read.
    setNow('2026-10-14T16:00:00Z');
    await postGithub(wrapped, 'issue_comment', comment(2), 'gh-2');
    expect(sqls().filter((s) => s.includes('COUNT(*) AS n'))).toHaveLength(1);
  });
});
