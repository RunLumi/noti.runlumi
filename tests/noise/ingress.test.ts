import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NOISE, HELD_CAPACITY, type NoiseSettings } from '../../src/routing/noise';
import {
  count,
  createHarness,
  heldRows,
  insertIntegration,
  outboxMessages,
  postGithub,
  setNow,
  workflowRun,
  comment,
  type Harness,
} from './harness';

/**
 * Noise control at ingress, end to end over the real Worker entry point and migrations: a signed
 * webhook is verified, the tenant resolved from the installation, and each subscribed
 * integration either gets a delivery now or a held row with a known release time (ADR 0016).
 */
const HCM = 'Asia/Ho_Chi_Minh';
const settings = (over: Partial<NoiseSettings>): NoiseSettings => ({ ...DEFAULT_NOISE, ...over });
const quiet = settings({ timezone: HCM, quietHours: { start: '22:00', end: '08:00' } });
// 23:00 in Ho Chi Minh: inside quiet hours. 12:00: outside them.
const NIGHT = '2026-10-14T16:00:00Z';
const NOON = '2026-10-14T05:00:00Z';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});
afterEach(() => vi.useRealTimers());

const decisions = () =>
  h.db.raw
    .prepare('SELECT integration_id, outcome, filter_id, reason FROM routing_decisions ORDER BY rowid')
    .all();

describe('quiet hours', () => {
  it('holds a non-critical update, stores display fields only, and does not create a delivery', async () => {
    insertIntegration(h, 'i1', 'org-a', quiet);
    setNow(NIGHT);
    const res = await postGithub(h, 'issue_comment', comment(7), 'gh-1');
    expect(res).toEqual({ status: 202, persisted: 0, held: 1 });
    expect(count(h, 'deliveries')).toBe(0);
    expect(count(h, 'notification_outbox')).toBe(0);
    expect(h.sent).toHaveLength(0);

    const [row, ...rest] = heldRows(h);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      organization_id: 'org-a',
      integration_id: 'i1',
      hold_reason: 'quiet_hours',
      state: 'held',
      title: 'Issue 7',
      release_at: Date.parse('2026-10-15T01:00:00Z'),
    });
    // Why it was held is recorded as a reason code, with no content.
    expect(decisions()).toEqual([
      { integration_id: 'i1', outcome: 'delivered', filter_id: null, reason: 'quiet_hours' },
    ]);
  });

  it('never stores the payload: only the bounded display columns exist', async () => {
    insertIntegration(h, 'i1', 'org-a', quiet);
    setNow(NIGHT);
    await postGithub(h, 'issue_comment', comment(7, 'SECRET-BODY-TEXT'), 'gh-1');
    const everything = JSON.stringify(h.db.raw.prepare('SELECT * FROM held_events').all());
    expect(everything).not.toContain('SECRET-BODY-TEXT');
    const columns = (h.db.raw.prepare('PRAGMA table_info(held_events)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).not.toContain('payload_json');
    expect(columns).not.toContain('body');
  });

  it('delivers immediately outside quiet hours', async () => {
    insertIntegration(h, 'i1', 'org-a', quiet);
    setNow(NOON);
    expect(await postGithub(h, 'issue_comment', comment(7), 'gh-1')).toEqual({ status: 202, persisted: 1 });
    expect(count(h, 'held_events')).toBe(0);
    expect(count(h, 'deliveries')).toBe(1);
    expect(decisions()).toEqual([]);
  });

  it('a critical update bypasses quiet hours and the bypass is recorded', async () => {
    insertIntegration(h, 'i1', 'org-a', quiet);
    setNow(NIGHT);
    const res = await postGithub(h, 'workflow_run', workflowRun('failure'), 'gh-1');
    expect(res).toEqual({ status: 202, persisted: 1 });
    expect(count(h, 'held_events')).toBe(0);
    expect(decisions()).toEqual([
      { integration_id: 'i1', outcome: 'delivered', filter_id: null, reason: 'critical_bypass' },
    ]);
    expect(h.sent).toHaveLength(1);
  });

  it('a provider redelivery of a held update neither duplicates nor delivers it', async () => {
    insertIntegration(h, 'i1', 'org-a', quiet);
    setNow(NIGHT);
    expect(await postGithub(h, 'issue_comment', comment(7), 'gh-1')).toMatchObject({ held: 1 });
    expect(await postGithub(h, 'issue_comment', comment(7), 'gh-1')).toEqual({ status: 202, persisted: 0 });
    expect(heldRows(h)).toHaveLength(1);
    // Not delivered, and the redelivery is recorded rather than dropped (F185).
    expect(count(h, 'deliveries', "state != 'suppressed'")).toBe(0);
    expect(count(h, 'deliveries', "state = 'suppressed' AND suppressed_reason = 'duplicate'")).toBe(1);
  });

  it('a redelivery of an update that was already delivered is not held afterwards', async () => {
    insertIntegration(h, 'i1', 'org-a', null);
    setNow(NIGHT);
    await postGithub(h, 'issue_comment', comment(7), 'gh-1');
    expect(count(h, 'deliveries')).toBe(1);
    // The person turns quiet hours on; GitHub redelivers the same event.
    h.db.raw
      .prepare("UPDATE integrations SET noise_json=? WHERE id='i1'")
      .run(JSON.stringify({ v: 1, ...quiet }));
    await postGithub(h, 'issue_comment', comment(7), 'gh-1');
    expect(count(h, 'held_events')).toBe(0);
    expect(count(h, 'deliveries', "state != 'suppressed'")).toBe(1);
    expect(count(h, 'deliveries', "state = 'suppressed'")).toBe(1);
  });
});

describe('settings changes between an event and its redelivery', () => {
  it('a held update that GitHub redelivers after the settings were cleared is not also sent now', async () => {
    // Found by the conservation property test: the redelivery used to create a second, immediate
    // delivery while the held row was still waiting, so the update arrived twice.
    insertIntegration(h, 'i1', 'org-a', quiet);
    setNow(NIGHT);
    await postGithub(h, 'issue_comment', comment(7), 'gh-1');
    h.db.raw.prepare("UPDATE integrations SET noise_json=NULL WHERE id='i1'").run();
    expect(await postGithub(h, 'issue_comment', comment(7), 'gh-1')).toEqual({ status: 202, persisted: 0 });
    expect(count(h, 'deliveries', "state != 'suppressed'")).toBe(0);
    expect(count(h, 'deliveries', "state = 'suppressed'")).toBe(1);
    expect(heldRows(h)).toHaveLength(1);
  });
});

describe('burst grouping', () => {
  const grouped = settings({ groupWindowSec: 300 });

  it('opens a group and lets later updates join it at the same release time', async () => {
    insertIntegration(h, 'i1', 'org-a', grouped);
    setNow('2026-10-14T10:00:00Z');
    await postGithub(h, 'issue_comment', comment(7), 'gh-1');
    setNow('2026-10-14T10:02:00Z');
    await postGithub(h, 'issue_comment', comment(7), 'gh-2');
    const rows = heldRows(h);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.release_at)).toEqual(
      [Date.parse('2026-10-14T10:05:00Z')].flatMap((x) => [x, x]),
    );
    expect(rows.every((r) => r.hold_reason === 'grouped')).toBe(true);
  });

  it('keeps a different pull request, issue, repository and event type apart', async () => {
    insertIntegration(h, 'i1', 'org-a', grouped);
    setNow('2026-10-14T10:00:00Z');
    await postGithub(h, 'issue_comment', comment(7), 'gh-1');
    setNow('2026-10-14T10:01:00Z');
    await postGithub(h, 'issue_comment', comment(8), 'gh-2');
    await postGithub(
      h,
      'issues',
      { action: 'opened', sender: { login: 'o', type: 'User' }, issue: { number: 7, title: 't' } },
      'gh-3',
    );
    const keys = (h.db.raw.prepare('SELECT DISTINCT group_key FROM held_events').all() as unknown[]).length;
    expect(keys).toBe(3);
    // The comment on #8 opened its own window: it did not inherit #7's release time.
    const [first, second] = heldRows(h);
    expect(second?.release_at).toBe((first?.release_at ?? 0) + 60_000);
  });

  it('does not group updates of the same type about the same thing across repositories', async () => {
    insertIntegration(h, 'i1', 'org-a', grouped, { repo: 'acme/web' });
    insertIntegration(h, 'i2', 'org-a', grouped, { repo: 'acme/api' });
    setNow('2026-10-14T10:00:00Z');
    await postGithub(h, 'issue_comment', comment(7), 'gh-1', { repo: 'acme/web' });
    await postGithub(h, 'issue_comment', comment(7), 'gh-2', { repo: 'acme/api' });
    const keys = h.db.raw.prepare('SELECT DISTINCT group_key FROM held_events').all();
    expect(keys).toHaveLength(2);
  });

  it('a critical update is never grouped', async () => {
    insertIntegration(h, 'i1', 'org-a', grouped);
    setNow('2026-10-14T10:00:00Z');
    expect(await postGithub(h, 'workflow_run', workflowRun('failure'), 'gh-1')).toEqual({
      status: 202,
      persisted: 1,
    });
    expect(count(h, 'held_events')).toBe(0);
  });
});

describe('digests', () => {
  it('holds non-critical updates until the next scheduled boundary', async () => {
    insertIntegration(h, 'i1', 'org-a', settings({ timezone: HCM, digest: 'daily', digestAt: '08:00' }));
    setNow(NOON);
    await postGithub(h, 'issue_comment', comment(7), 'gh-1');
    await postGithub(h, 'issue_comment', comment(8), 'gh-2');
    const rows = heldRows(h);
    expect(rows.map((r) => r.hold_reason)).toEqual(['digest', 'digest']);
    expect(new Set(rows.map((r) => r.release_at))).toEqual(new Set([Date.parse('2026-10-15T01:00:00Z')]));
  });
});

describe('capacity', () => {
  it('delivers instead of holding once an integration has the maximum waiting, and records it', async () => {
    insertIntegration(h, 'i1', 'org-a', settings({ groupWindowSec: 3600 }));
    setNow('2026-10-14T10:00:00Z');
    const insert = h.db.raw.prepare(
      `INSERT INTO held_events(id,organization_id,integration_id,hold_reason,group_key,state,release_at,held_at,event_type,title,url,repo,actor,status,summary)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (let i = 0; i < HELD_CAPACITY; i++)
      insert.run(
        `h${i}`,
        'org-a',
        'i1',
        'grouped',
        'k'.repeat(32),
        'held',
        1,
        1,
        'issues.opened',
        't',
        '',
        '',
        '',
        'info',
        '',
      );
    const res = await postGithub(h, 'issue_comment', comment(7), 'gh-1');
    expect(res).toEqual({ status: 202, persisted: 1 });
    expect(count(h, 'held_events')).toBe(HELD_CAPACITY);
    expect(decisions()).toEqual([
      { integration_id: 'i1', outcome: 'delivered', filter_id: null, reason: 'hold_capacity' },
    ]);
  });

  it('is counted per integration, so another integration is unaffected', async () => {
    insertIntegration(h, 'i1', 'org-a', settings({ groupWindowSec: 60 }));
    insertIntegration(h, 'i2', 'org-a', settings({ groupWindowSec: 60 }));
    setNow('2026-10-14T10:00:00Z');
    const insert = h.db.raw.prepare(
      `INSERT INTO held_events(id,organization_id,integration_id,hold_reason,group_key,state,release_at,held_at,event_type,title,url,repo,actor,status,summary)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (let i = 0; i < HELD_CAPACITY; i++)
      insert.run(
        `h${i}`,
        'org-a',
        'i1',
        'grouped',
        'k'.repeat(32),
        'held',
        1,
        1,
        'issues.opened',
        't',
        '',
        '',
        '',
        'info',
        '',
      );
    const res = await postGithub(h, 'issue_comment', comment(7), 'gh-1');
    expect(res).toEqual({ status: 202, persisted: 1, held: 1 });
  });
});

describe('resolution notices', () => {
  const resolving = settings({ resolution: true });
  const failuresOnly = ['workflow_run.failure'];

  it('a success after a failure of the same workflow and branch is sent, though only failures were chosen', async () => {
    insertIntegration(h, 'i1', 'org-a', resolving, { eventTypes: failuresOnly });
    setNow('2026-10-14T10:00:00Z');
    await postGithub(h, 'workflow_run', workflowRun('failure', { id: 1 }), 'gh-1');
    expect(count(h, 'noise_open_failures')).toBe(1);
    const res = await postGithub(h, 'workflow_run', workflowRun('success', { id: 2 }), 'gh-2');
    expect(res).toEqual({ status: 202, persisted: 1 });
    const [, resolved] = outboxMessages(h);
    expect(resolved).toMatchObject({ status: 'success', eventType: 'workflow_run.success' });
    expect(resolved?.title).toMatch(/^Resolved: /);
    expect(resolved?.summary).toContain('Back to passing');
    // The failure is closed: a second success is just a success this integration did not ask for.
    expect(count(h, 'noise_open_failures')).toBe(0);
    expect(await postGithub(h, 'workflow_run', workflowRun('success', { id: 3 }), 'gh-3')).toEqual({
      status: 202,
      persisted: 0,
    });
  });

  it('a success with no earlier failure is not sent to a failures-only integration', async () => {
    insertIntegration(h, 'i1', 'org-a', resolving, { eventTypes: failuresOnly });
    setNow('2026-10-14T10:00:00Z');
    expect(await postGithub(h, 'workflow_run', workflowRun('success'), 'gh-1')).toEqual({
      status: 202,
      persisted: 0,
    });
    expect(count(h, 'deliveries')).toBe(0);
  });

  it.each([
    ['another branch', { branch: 'dev' }],
    ['another workflow', { name: 'Deploy' }],
  ])('does not resolve a failure on %s', async (_name, change) => {
    insertIntegration(h, 'i1', 'org-a', resolving, { eventTypes: failuresOnly });
    setNow('2026-10-14T10:00:00Z');
    await postGithub(h, 'workflow_run', workflowRun('failure'), 'gh-1');
    expect(await postGithub(h, 'workflow_run', workflowRun('success', change), 'gh-2')).toMatchObject({
      persisted: 0,
    });
    expect(count(h, 'noise_open_failures')).toBe(1);
  });

  it('does not track failures when resolution is off', async () => {
    insertIntegration(h, 'i1', 'org-a', settings({ groupWindowSec: 60 }), { eventTypes: failuresOnly });
    setNow('2026-10-14T10:00:00Z');
    await postGithub(h, 'workflow_run', workflowRun('failure'), 'gh-1');
    expect(count(h, 'noise_open_failures')).toBe(0);
  });

  it('a redelivered success is not sent twice', async () => {
    insertIntegration(h, 'i1', 'org-a', resolving, { eventTypes: failuresOnly });
    setNow('2026-10-14T10:00:00Z');
    await postGithub(h, 'workflow_run', workflowRun('failure'), 'gh-1');
    await postGithub(h, 'workflow_run', workflowRun('success', { id: 2 }), 'gh-2');
    await postGithub(h, 'workflow_run', workflowRun('success', { id: 2 }), 'gh-2');
    expect(count(h, 'deliveries')).toBe(2);
  });

  it('a subscribed success that resolves a failure is marked resolved, a plain one is not', async () => {
    insertIntegration(h, 'i1', 'org-a', resolving);
    setNow('2026-10-14T10:00:00Z');
    await postGithub(h, 'workflow_run', workflowRun('success', { id: 1 }), 'gh-1');
    await postGithub(h, 'workflow_run', workflowRun('failure', { id: 2 }), 'gh-2');
    await postGithub(h, 'workflow_run', workflowRun('success', { id: 3 }), 'gh-3');
    const titles = outboxMessages(h).map((m) => m.title);
    expect(titles[0]).not.toMatch(/^Resolved/);
    expect(titles[2]).toMatch(/^Resolved: /);
  });

  it('a resolved update that is held says so when it is listed', async () => {
    insertIntegration(h, 'i1', 'org-a', settings({ ...quiet, resolution: true }), {
      eventTypes: failuresOnly,
    });
    setNow(NIGHT);
    // The failure bypasses quiet hours; the resolution does not.
    await postGithub(h, 'workflow_run', workflowRun('failure', { id: 1 }), 'gh-1');
    await postGithub(h, 'workflow_run', workflowRun('success', { id: 2 }), 'gh-2');
    expect(heldRows(h)).toMatchObject([{ resolved: 1, hold_reason: 'quiet_hours' }]);
  });

  it('a redelivered failure does not re-open a failure that a later success closed', async () => {
    insertIntegration(h, 'i1', 'org-a', resolving, { eventTypes: failuresOnly });
    setNow('2026-10-14T10:00:00Z');
    await postGithub(h, 'workflow_run', workflowRun('failure', { id: 1 }), 'gh-1');
    await postGithub(h, 'workflow_run', workflowRun('success', { id: 2 }), 'gh-2');
    expect(count(h, 'noise_open_failures')).toBe(0);
    // GitHub redelivers the old failure: it is a duplicate, not a new failure.
    await postGithub(h, 'workflow_run', workflowRun('failure', { id: 1 }), 'gh-1');
    expect(count(h, 'noise_open_failures')).toBe(0);
    // So the next ordinary success is not announced as "resolved".
    expect(await postGithub(h, 'workflow_run', workflowRun('success', { id: 3 }), 'gh-3')).toMatchObject({
      persisted: 0,
    });
  });

  it('is per integration and per tenant', async () => {
    insertIntegration(h, 'i1', 'org-a', resolving, { eventTypes: failuresOnly });
    insertIntegration(h, 'i2', 'org-b', resolving, { eventTypes: failuresOnly });
    setNow('2026-10-14T10:00:00Z');
    await postGithub(h, 'workflow_run', workflowRun('failure'), 'gh-1');
    // Organization B never saw a failure, so its success resolves nothing.
    expect(
      await postGithub(h, 'workflow_run', workflowRun('success', { id: 9 }), 'gh-2', { installation: 1002 }),
    ).toMatchObject({ persisted: 0 });
    expect(count(h, 'noise_open_failures', "organization_id='org-b'")).toBe(0);
  });
});

describe('interaction with routing filters and other tenants', () => {
  it('a filtered update is not held (filters decide first)', async () => {
    insertIntegration(h, 'i1', 'org-a', quiet, {
      filters: JSON.stringify({ v: 1, actor: { bots: 'exclude' } }),
    });
    setNow(NIGHT);
    await postGithub(
      h,
      'issue_comment',
      { ...comment(7), sender: { login: 'dependabot[bot]', type: 'Bot' } },
      'gh-1',
    );
    expect(count(h, 'held_events')).toBe(0);
    expect(decisions()).toMatchObject([{ outcome: 'filtered', filter_id: 'actor' }]);
  });

  it('a held update that also had a filter row shows the hold reason, not a plain "sent"', async () => {
    insertIntegration(h, 'i1', 'org-a', quiet, {
      filters: JSON.stringify({ v: 1, actor: { bots: 'exclude' } }),
    });
    setNow(NIGHT);
    await postGithub(h, 'issue_comment', comment(7), 'gh-1');
    expect(decisions()).toEqual([
      { integration_id: 'i1', outcome: 'delivered', filter_id: null, reason: 'quiet_hours' },
    ]);
  });

  it('holds per tenant: the same repository name in two organizations makes two independent rows', async () => {
    insertIntegration(h, 'i1', 'org-a', quiet);
    insertIntegration(h, 'i2', 'org-b', quiet);
    setNow(NIGHT);
    await postGithub(h, 'issue_comment', comment(7), 'gh-1', { installation: 1001 });
    await postGithub(h, 'issue_comment', comment(7), 'gh-1', { installation: 1002 });
    const rows = heldRows(h);
    expect(rows.map((r) => [r.organization_id, r.integration_id])).toEqual([
      ['org-a', 'i1'],
      ['org-b', 'i2'],
    ]);
    const keys = new Set(
      (h.db.raw.prepare('SELECT group_key FROM held_events').all() as { group_key: string }[]).map(
        (r) => r.group_key,
      ),
    );
    expect(keys.size).toBe(2);
  });

  it('an integration without noise settings behaves exactly as before and writes no provenance', async () => {
    insertIntegration(h, 'i1', 'org-a', null);
    setNow(NIGHT);
    expect(await postGithub(h, 'issue_comment', comment(7), 'gh-1')).toEqual({ status: 202, persisted: 1 });
    expect(count(h, 'held_events')).toBe(0);
    expect(decisions()).toEqual([]);
  });

  it.each([
    ['not an object (the column only admits valid JSON)', '[]'],
    ['an unknown version', JSON.stringify({ v: 9, whatever: true })],
    ['an invalid value', JSON.stringify({ v: 1, digest: 'weekly' })],
  ])('delivers normally when the stored settings are %s (fail open)', async (_name, raw) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    insertIntegration(h, 'i1', 'org-a', raw);
    setNow(NIGHT);
    expect(await postGithub(h, 'issue_comment', comment(7), 'gh-1')).toEqual({ status: 202, persisted: 1 });
    expect(count(h, 'held_events')).toBe(0);
    expect(spy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('noise_settings_unusable');
    spy.mockRestore();
  });
});
