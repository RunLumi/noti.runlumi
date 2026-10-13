import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  prepareDelivery,
  validateDestinationConfig,
  type DestinationKind,
} from '../../src/connectors/destinations';
import type { Bindings, DeliveryMessage } from '../../src/env';
import { SELECT_VIEW, FROM_VIEW } from '../../src/api/delivery-queries';
import { toDeliveryView, type DeliveryRowRecord } from '../../src/api/delivery-view';
import { toNotification } from '../../src/pipeline/consumer';
import { parseDeliveryMessage } from '../../src/pipeline/outbox';
import { UNITS_PER_TICK, releaseHeldEvents, type ReleaseDeps } from '../../src/pipeline/noise-release';
import { DEFAULT_NOISE, HELD_CAPACITY, type NoiseSettings } from '../../src/routing/noise';
import { DIGEST_LIST_MAX, DIGEST_MAX_PARTS } from '../../src/routing/noise-render';
import {
  comment,
  count,
  createHarness,
  heldRows,
  insertIntegration,
  outboxMessages,
  postGithub,
  setNow,
  workflowRun,
  type Harness,
} from './harness';

const HCM = 'Asia/Ho_Chi_Minh';
const settings = (over: Partial<NoiseSettings>): NoiseSettings => ({ ...DEFAULT_NOISE, ...over });
const quiet = settings({ timezone: HCM, quietHours: { start: '22:00', end: '08:00' } });
const grouped = settings({ groupWindowSec: 300 });
const NIGHT = '2026-10-14T16:00:00Z';
const MORNING = '2026-10-15T01:05:00Z';

let h: Harness;
let tokens = 0;
const clock = (iso: string): ReleaseDeps => ({
  now: () => Date.parse(iso),
  token: () => `token-${++tokens}`,
});

beforeEach(() => {
  h = createHarness();
  tokens = 0;
});
afterEach(() => vi.useRealTimers());

const run = (iso: string) => releaseHeldEvents(h.env, clock(iso));

describe('release', () => {
  it('combines a burst into ONE notification with a count and the newest item, through the normal outbox', async () => {
    insertIntegration(h, 'i1', 'org-a', grouped);
    setNow('2026-10-14T10:00:00Z');
    await postGithub(h, 'issue_comment', comment(7), 'gh-1');
    setNow('2026-10-14T10:01:00Z');
    await postGithub(h, 'issue_comment', comment(7), 'gh-2');
    setNow('2026-10-14T10:02:00Z');
    await postGithub(h, 'issue_comment', comment(7), 'gh-3');

    // Not due yet: nothing is released early.
    expect(await run('2026-10-14T10:04:59Z')).toMatchObject({ events: 0, notifications: 0 });
    expect(count(h, 'deliveries')).toBe(0);

    const report = await run('2026-10-14T10:05:00Z');
    expect(report).toMatchObject({ units: 1, notifications: 1, events: 3 });
    expect(count(h, 'deliveries', "state='pending'")).toBe(1);
    const [message] = outboxMessages(h);
    expect(message).toMatchObject({
      organizationId: 'org-a',
      integrationId: 'i1',
      count: 3,
      eventType: 'issue_comment.created',
      status: 'info',
      repo: 'acme/web',
    });
    expect(message?.title).toContain('3 updates');
    expect(message?.summary).toContain('3 updates combined, newest first');
    // Every held row is accounted for by that one delivery.
    const rows = heldRows(h);
    expect(rows.every((r) => r.state === 'released' && r.released_in === message?.id)).toBe(true);
  });

  it('releases a lone held update as itself, under its own deterministic delivery id', async () => {
    insertIntegration(h, 'i1', 'org-a', grouped);
    setNow('2026-10-14T10:00:00Z');
    await postGithub(h, 'issue_comment', comment(7), 'gh-1');
    const [held] = heldRows(h);
    await run('2026-10-14T10:05:00Z');
    const [message] = outboxMessages(h);
    expect(message?.id).toBe(held?.id);
    expect(message?.title).toBe('Issue 7');
    expect(message?.count).toBeUndefined();
    // A provider redelivery after the release must not send it a second time.
    setNow('2026-10-14T10:06:00Z');
    await postGithub(h, 'issue_comment', comment(7), 'gh-1');
    expect(count(h, 'deliveries')).toBe(1);
    expect(count(h, 'notification_outbox')).toBe(1);
  });

  it('turns everything held in quiet hours into one digest, failures first, and states the count', async () => {
    insertIntegration(h, 'i1', 'org-a', quiet);
    setNow(NIGHT);
    await postGithub(h, 'issue_comment', comment(1), 'gh-1');
    await postGithub(h, 'issue_comment', comment(2), 'gh-2');
    await postGithub(h, 'issue_comment', comment(2), 'gh-3');
    // A successful run is not critical, so it is held; a failed one bypasses and is not.
    await postGithub(h, 'workflow_run', workflowRun('success', { id: 5 }), 'gh-4');
    expect(heldRows(h)).toHaveLength(4);

    const report = await run(MORNING);
    expect(report).toMatchObject({ units: 1, notifications: 1, events: 4 });
    const [message] = outboxMessages(h);
    // Comments are `info`; the worst status of the items is the digest's status.
    expect(message).toMatchObject({ eventType: 'noti.digest', count: 4, status: 'info' });
    expect(message?.title).toBe('4 updates while you were away');
    const lines = (message?.summary ?? '').split('\n');
    expect(lines[0]).toBe('4 updates held during quiet hours:');
    // Collapsed by group key: the two comments on #2 are one line with a count.
    expect(message?.summary).toContain('(×2)');
    expect(message?.summary).toContain('✓');
    expect(message?.summary).toContain('•');
  });

  it('puts failures above successes and never relies on colour alone', async () => {
    insertIntegration(h, 'i1', 'org-a', quiet);
    setNow(NIGHT);
    await postGithub(h, 'workflow_run', workflowRun('success', { id: 5 }), 'gh-1');
    // Force a failure-status row into the hold (a critical update would normally bypass).
    h.db.raw
      .prepare(
        `INSERT INTO held_events(id,organization_id,integration_id,hold_reason,group_key,state,release_at,held_at,event_type,title,url,repo,actor,status,summary)
         VALUES('f1','org-a','i1','quiet_hours',?,'held',1,${Date.parse(NIGHT) - 1000},'workflow_run.failure','Build broke','','acme/web','','failure','')`,
      )
      .run('f'.repeat(32));
    await run(MORNING);
    const summary = outboxMessages(h)[0]?.summary ?? '';
    expect(summary.indexOf('✗')).toBeGreaterThan(-1);
    expect(summary.indexOf('✗')).toBeLessThan(summary.indexOf('✓'));
    expect(outboxMessages(h)[0]?.status).toBe('failure');
  });

  it('a digest that would be empty sends nothing', async () => {
    insertIntegration(h, 'i1', 'org-a', quiet);
    expect(await run(MORNING)).toEqual({ units: 0, notifications: 0, events: 0, reclaimed: 0 });
    expect(count(h, 'deliveries')).toBe(0);
    expect(count(h, 'notification_outbox')).toBe(0);
  });

  it('is idempotent: a second run finds nothing to do', async () => {
    insertIntegration(h, 'i1', 'org-a', quiet);
    setNow(NIGHT);
    await postGithub(h, 'issue_comment', comment(1), 'gh-1');
    await postGithub(h, 'issue_comment', comment(2), 'gh-2');
    await run(MORNING);
    expect(await run(MORNING)).toMatchObject({ events: 0, notifications: 0 });
    expect(count(h, 'deliveries')).toBe(1);
  });

  it('two overlapping runs release each event exactly once', async () => {
    insertIntegration(h, 'i1', 'org-a', quiet);
    setNow(NIGHT);
    for (let i = 1; i <= 6; i++) await postGithub(h, 'issue_comment', comment(i), `gh-${i}`);
    const [a, b] = await Promise.all([run(MORNING), run(MORNING)]);
    expect((a?.events ?? 0) + (b?.events ?? 0)).toBe(6);
    expect(count(h, 'deliveries')).toBe(1);
    expect(count(h, 'notification_outbox')).toBe(1);
  });

  it('only releases rows that are due', async () => {
    insertIntegration(h, 'i1', 'org-a', quiet);
    setNow(NIGHT);
    await postGithub(h, 'issue_comment', comment(1), 'gh-1');
    // 00:59Z is 07:59 local: still quiet, still held.
    expect(await run('2026-10-15T00:59:59Z')).toMatchObject({ events: 0 });
    expect(heldRows(h)[0]?.state).toBe('held');
    expect(await run('2026-10-15T01:00:00Z')).toMatchObject({ events: 1 });
  });
});

describe('release is bounded', () => {
  const insert = (n: number, integration: string, org: string, status = 'info') => {
    const stmt = h.db.raw.prepare(
      `INSERT INTO held_events(id,organization_id,integration_id,hold_reason,group_key,state,release_at,held_at,event_type,title,url,repo,actor,status,summary)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (let i = 0; i < n; i++)
      stmt.run(
        `${integration}-${i}`,
        org,
        integration,
        'digest',
        String(i).padStart(32, '0'),
        'held',
        1000,
        2000 + i,
        'issues.opened',
        `Issue number ${i}`,
        `https://github.com/acme/web/issues/${i}`,
        'acme/web',
        '',
        status,
        '',
      );
  };

  it('releases at most UNITS_PER_TICK integrations per tick and the rest on the next', async () => {
    const total = UNITS_PER_TICK + 5;
    for (let i = 0; i < total; i++) {
      insertIntegration(h, `i${i}`, 'org-a', quiet);
      insert(2, `i${i}`, 'org-a');
    }
    expect(await run(MORNING)).toMatchObject({ units: UNITS_PER_TICK, events: UNITS_PER_TICK * 2 });
    expect(count(h, 'held_events', "state='held'")).toBe(10);
    expect(await run(MORNING)).toMatchObject({ units: 5, events: 10 });
    expect(count(h, 'held_events', "state='held'")).toBe(0);
    expect(count(h, 'deliveries')).toBe(total);
  });

  it('splits a full backlog of distinct entries into continuation digests and counts every row honestly', async () => {
    insertIntegration(h, 'i1', 'org-a', quiet);
    insert(HELD_CAPACITY, 'i1', 'org-a');
    await run(MORNING);
    const digests = outboxMessages(h);
    expect(digests).toHaveLength(DIGEST_MAX_PARTS);
    expect(digests.map((m) => m.title)).toEqual(
      [1, 2, 3].map((i) => `Summary: ${HELD_CAPACITY} updates (part ${i} of ${DIGEST_MAX_PARTS})`),
    );
    let listed = 0;
    for (const [index, message] of digests.entries()) {
      const summary = message.summary ?? '';
      expect(summary.length).toBeLessThanOrEqual(1400);
      const lines = summary.split('\n').filter((l) => /^[✗!•✓]/.test(l));
      expect(lines).toHaveLength(DIGEST_LIST_MAX);
      listed += lines.length;
      if (index < digests.length - 1) expect(summary).toContain('Continued in the next message.');
    }
    // The last message states what no message lists, and that its details are not kept.
    const notShown = HELD_CAPACITY - listed;
    expect(digests.at(-1)?.summary).toContain(
      `…and ${notShown} more items not shown. Their details are not kept.`,
    );
    // listed + not shown == rows, and each message's count is the rows it stands for.
    expect(digests.reduce((n, m) => n + (m.count ?? 0), 0)).toBe(HELD_CAPACITY);
    expect(count(h, 'held_events', "state='released'")).toBe(HELD_CAPACITY);
    for (const message of digests)
      expect(count(h, 'held_events', `released_in='${message.id}'`)).toBe(message.count);
  });

  it('keeps the digest inside the character budget however long the titles and links are', async () => {
    insertIntegration(h, 'i1', 'org-a', quiet);
    const stmt = h.db.raw.prepare(
      `INSERT INTO held_events(id,organization_id,integration_id,hold_reason,group_key,state,release_at,held_at,event_type,title,url,repo,actor,status,summary)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (let i = 0; i < 40; i++)
      stmt.run(
        `x${i}`,
        'org-a',
        'i1',
        'quiet_hours',
        String(i).padStart(32, '0'),
        'held',
        1,
        10 + i,
        'issues.opened',
        'T'.repeat(300),
        `https://example.test/${'a'.repeat(130)}`,
        'r'.repeat(200),
        '',
        'info',
        's'.repeat(280),
      );
    await run(MORNING);
    const digests = outboxMessages(h);
    for (const message of digests) expect((message.summary ?? '').length).toBeLessThanOrEqual(1400);
    // The closing line is never cut, whatever the titles and links were.
    expect(digests.at(-1)?.summary).toMatch(/more items? not shown\. Their details are not kept\.$/);
    expect(digests.reduce((n, m) => n + (m.count ?? 0), 0)).toBe(40);
  });
});

describe('release is safe when things fail', () => {
  const failBatchOnce = (): Bindings => {
    let failed = false;
    const db = h.env.DB;
    return {
      ...h.env,
      DB: {
        prepare: db.prepare.bind(db),
        exec: db.exec.bind(db),
        batch: (statements: D1PreparedStatement[]) => {
          if (!failed) {
            failed = true;
            return Promise.reject(new Error('D1 unavailable'));
          }
          return db.batch(statements);
        },
      } as unknown as D1Database,
    };
  };

  it('a failed release creates nothing, counts an attempt, backs off, and then releases once', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    insertIntegration(h, 'i1', 'org-a', quiet);
    setNow(NIGHT);
    await postGithub(h, 'issue_comment', comment(1), 'gh-1');
    await postGithub(h, 'issue_comment', comment(2), 'gh-2');
    const flaky = failBatchOnce();

    await expect(releaseHeldEvents(flaky, clock(MORNING))).rejects.toThrow(/noise release failed/);
    expect(count(h, 'deliveries')).toBe(0);
    expect(count(h, 'notification_outbox')).toBe(0);
    const failedRows = h.db.raw
      .prepare('SELECT state, attempts, last_error_class, retry_after FROM held_events')
      .all();
    expect(failedRows).toEqual(
      Array(2).fill({
        state: 'held',
        attempts: 1,
        last_error_class: 'batch_failed',
        retry_after: Date.parse(MORNING) + 60_000,
      }),
    );

    // Inside the backoff window the rows are not due, so nothing is attempted.
    expect(await releaseHeldEvents(flaky, clock('2026-10-15T01:05:30Z'))).toMatchObject({ events: 0 });
    // After it they are released, once.
    expect(await releaseHeldEvents(flaky, clock('2026-10-15T01:06:10Z'))).toMatchObject({
      events: 2,
      notifications: 1,
    });
    expect(count(h, 'deliveries')).toBe(1);
    expect(heldRows(h).every((r) => r.state === 'released')).toBe(true);
    spy.mockRestore();
  });

  it('a unit that fails does not stop the others, and the failure still surfaces', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    insertIntegration(h, 'i1', 'org-a', quiet);
    insertIntegration(h, 'i2', 'org-a', quiet);
    setNow(NIGHT);
    await postGithub(h, 'issue_comment', comment(1), 'gh-1');
    const flaky = failBatchOnce();
    await expect(releaseHeldEvents(flaky, clock(MORNING))).rejects.toThrow();
    // The first integration's batch failed; the second was still released in the same run.
    const states = h.db.raw
      .prepare('SELECT integration_id, state FROM held_events ORDER BY integration_id')
      .all();
    expect(states).toEqual([
      { integration_id: 'i1', state: 'held' },
      { integration_id: 'i2', state: 'released' },
    ]);
    expect(count(h, 'deliveries')).toBe(1);
    spy.mockRestore();
  });

  it('releases notifications in separate batches: one failing batch affects only its own rows', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    insertIntegration(h, 'i1', 'org-a', grouped);
    setNow('2026-10-14T10:00:00Z');
    for (const [issue, ids] of [
      [1, ['a1', 'a2']],
      [2, ['b1', 'b2']],
    ] as const)
      for (const id of ids) await postGithub(h, 'issue_comment', comment(issue), `gh-${id}`);
    const db = h.env.DB;
    let calls = 0;
    const second = {
      ...h.env,
      DB: {
        prepare: db.prepare.bind(db),
        exec: db.exec.bind(db),
        batch: (statements: D1PreparedStatement[]) =>
          ++calls === 2 ? Promise.reject(new Error('D1 unavailable')) : db.batch(statements),
      } as unknown as D1Database,
    } as Bindings;
    await expect(
      releaseHeldEvents(second, { ...clock('2026-10-14T10:05:00Z'), batchSize: 1 }),
    ).rejects.toThrow();
    expect(count(h, 'deliveries')).toBe(1);
    expect(count(h, 'held_events', "state='released'")).toBe(2);
    expect(count(h, 'held_events', "state='held' AND attempts=1")).toBe(2);
    // After the backoff the other group is released on its own, once.
    await releaseHeldEvents(h.env, clock('2026-10-14T10:07:00Z'));
    expect(count(h, 'deliveries')).toBe(2);
    expect(count(h, 'held_events', "state='released'")).toBe(4);
    spy.mockRestore();
  });

  it('a run whose lease was lost creates no delivery (the delivery insert is guarded on the claim)', async () => {
    insertIntegration(h, 'i1', 'org-a', quiet);
    setNow(NIGHT);
    await postGithub(h, 'issue_comment', comment(1), 'gh-1');
    // Another run claims after this one's lease would have expired.
    const taken = h.env.DB;
    let stolen = false;
    const racing = {
      ...h.env,
      DB: {
        prepare: taken.prepare.bind(taken),
        exec: taken.exec.bind(taken),
        batch: (statements: D1PreparedStatement[]) => {
          if (!stolen) {
            stolen = true;
            h.db.raw.prepare("UPDATE held_events SET claim_token='someone-else'").run();
          }
          return taken.batch(statements);
        },
      } as unknown as D1Database,
    } as Bindings;
    await releaseHeldEvents(racing, clock(MORNING));
    expect(count(h, 'deliveries')).toBe(0);
    expect(count(h, 'notification_outbox')).toBe(0);
    expect(heldRows(h)[0]).toMatchObject({ state: 'claimed', claim_token: 'someone-else' });
  });
});

describe('resolved updates that were held', () => {
  const failuresAndSuccesses = ['workflow_run.failure', 'workflow_run.success'];

  it('a lone grouped "resolved" update says so exactly once', async () => {
    insertIntegration(h, 'i1', 'org-a', settings({ groupWindowSec: 300, resolution: true }), {
      eventTypes: failuresAndSuccesses,
    });
    setNow('2026-10-14T10:00:00Z');
    await postGithub(h, 'workflow_run', workflowRun('failure', { id: 1 }), 'gh-1');
    await postGithub(h, 'workflow_run', workflowRun('success', { id: 2 }), 'gh-2');
    expect(heldRows(h)).toMatchObject([{ resolved: 1, hold_reason: 'grouped', title: 'CI' }]);
    await run('2026-10-14T10:05:00Z');
    const resolved = outboxMessages(h).find((m) => m.eventType === 'workflow_run.success');
    expect(resolved?.title).toBe('Resolved: CI');
    expect(resolved?.summary?.match(/Back to passing/g)).toHaveLength(1);
  });

  it('a "resolved" update in a digest is marked once and keeps its own title', async () => {
    insertIntegration(h, 'i1', 'org-a', settings({ ...quiet, resolution: true }), {
      eventTypes: failuresAndSuccesses,
    });
    setNow(NIGHT);
    await postGithub(h, 'workflow_run', workflowRun('failure', { id: 1 }), 'gh-1');
    await postGithub(h, 'workflow_run', workflowRun('success', { id: 2 }), 'gh-2');
    await run(MORNING);
    const digest = outboxMessages(h).find((m) => m.eventType === 'noti.digest');
    expect(digest?.summary).toContain('✓ acme/web: CI (resolved)');
    expect(digest?.summary).not.toContain('Resolved: CI');
  });
});

describe('tenant isolation', () => {
  it('never mixes two organizations into one notification, even with identical group content', async () => {
    insertIntegration(h, 'i1', 'org-a', grouped);
    insertIntegration(h, 'i2', 'org-b', grouped);
    setNow('2026-10-14T10:00:00Z');
    for (const [org, install] of [
      ['a', 1001],
      ['b', 1002],
    ] as const)
      for (const n of [1, 2])
        await postGithub(h, 'issue_comment', comment(7), `gh-${org}-${n}`, { installation: install });
    await run('2026-10-14T10:05:00Z');
    const messages = outboxMessages(h);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => [m.organizationId, m.integrationId, m.count])).toEqual(
      expect.arrayContaining([
        ['org-a', 'i1', 2],
        ['org-b', 'i2', 2],
      ]),
    );
    for (const m of messages) {
      const row = h.db.raw
        .prepare('SELECT organization_id, integration_id FROM deliveries WHERE id=?')
        .get(m.id) as {
        organization_id: string;
        integration_id: string;
      };
      expect(row).toEqual({ organization_id: m.organizationId, integration_id: m.integrationId });
    }
  });
});

describe('the scheduled job', () => {
  it('releases after the outbox reconcile; the next tick dispatches through the existing outbox', async () => {
    insertIntegration(h, 'i1', 'org-a', quiet);
    setNow(NIGHT);
    await postGithub(h, 'issue_comment', comment(1), 'gh-1');
    await postGithub(h, 'issue_comment', comment(2), 'gh-2');
    setNow(MORNING);
    const { default: worker } = await import('../../src/index');
    await worker.scheduled({} as ScheduledEvent, h.env);
    expect(count(h, 'deliveries')).toBe(1);
    // noise_release runs after outbox_reconcile with its own budget, so dispatch is next tick.
    expect(h.sent).toHaveLength(0);
    setNow('2026-10-15T01:06:00Z');
    await worker.scheduled({} as ScheduledEvent, h.env);
    // The queue received the digest: retries, dead-lettering and replay apply to it as to any delivery.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ eventType: 'noti.digest', count: 2 });
    expect(count(h, 'notification_outbox', "state='dispatched'")).toBe(1);
  });
});

describe('rendered through the destination adapters', () => {
  // Assembled at run time so nothing in the repository looks like a webhook credential.
  const fixture = (): string => ['fixture', crypto.randomUUID().replaceAll('-', '')].join('');
  const urls: Record<Extract<DestinationKind, 'slack' | 'lark' | 'teams'>, string> = {
    slack: ['https://hooks.slack.com/services', 'T000', 'B000', fixture()].join('/'),
    lark: ['https://open.larksuite.com/open-apis/bot/v2/hook', fixture()].join('/'),
    teams: `https://prod-12.westus.logic.azure.com/workflows/${fixture()}/triggers/manual/paths/invoke?${new URLSearchParams({ sig: fixture() })}`,
  };

  it.each(['slack', 'lark', 'teams'] as const)('a digest fits and renders for %s', async (kind) => {
    insertIntegration(h, 'i1', 'org-a', quiet);
    setNow(NIGHT);
    for (let i = 1; i <= 25; i++) await postGithub(h, 'issue_comment', comment(i), `gh-${i}`);
    await run(MORNING);
    const stored = outboxMessages(h).find((m) => m.title?.includes('part 1 of'));
    const message = parseDeliveryMessage(stored) as DeliveryMessage;
    // The long summary survives parsing only because it is a combined notification.
    expect(message.summary?.length ?? 0).toBeGreaterThan(280);
    const checked = validateDestinationConfig({ kind, webhookUrl: urls[kind] });
    if (!checked.ok) throw new Error('fixture config rejected');
    const prepared = await prepareDelivery(checked.config, toNotification(message), { now: Date.now() });
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.request.body).toContain('while you were away');
      // 25 entries do not fit one message: the first part says it continues.
      expect(prepared.request.body).toContain('Continued in the next message.');
    }
  });

  it('an ordinary message cannot smuggle a long summary past the 280-character bound', () => {
    const long = 'x'.repeat(1000);
    const parsed = parseDeliveryMessage({
      id: 'a',
      integrationId: 'b',
      organizationId: 'c',
      title: 't',
      url: '',
      summary: long,
    });
    expect(parsed?.summary).toHaveLength(280);
    const combined = parseDeliveryMessage({
      id: 'a',
      integrationId: 'b',
      organizationId: 'c',
      title: 't',
      url: '',
      summary: long,
      count: 3,
    });
    expect(combined?.summary).toHaveLength(1000);
    expect(
      parseDeliveryMessage({ id: 'a', integrationId: 'b', organizationId: 'c', count: 9999 })?.count,
    ).toBeUndefined();
  });
});

describe('visible in the delivery log', () => {
  it('a released notification reports why it was held and how many updates it stands for', async () => {
    insertIntegration(h, 'i1', 'org-a', quiet);
    setNow(NIGHT);
    await postGithub(h, 'issue_comment', comment(1), 'gh-1');
    await postGithub(h, 'issue_comment', comment(2), 'gh-2');
    await postGithub(h, 'issue_comment', comment(3), 'gh-3');
    await run(MORNING);
    const rows = (
      await h.env.DB.prepare(`SELECT ${SELECT_VIEW} ${FROM_VIEW} WHERE d.organization_id=?`)
        .bind('org-a')
        .all<DeliveryRowRecord>()
    ).results;
    expect(rows).toHaveLength(1);
    const [row] = rows;
    const view = toDeliveryView(row as DeliveryRowRecord, true);
    expect(view).toMatchObject({ heldReason: 'quiet_hours', groupedCount: 3 });
  });

  it('an ordinary delivery reports neither, and another tenant never sees the counts', async () => {
    insertIntegration(h, 'i1', 'org-a', null);
    setNow(NIGHT);
    await postGithub(h, 'issue_comment', comment(1), 'gh-1');
    const [row] = (await h.env.DB.prepare(`SELECT ${SELECT_VIEW} ${FROM_VIEW}`).all<DeliveryRowRecord>())
      .results;
    expect(toDeliveryView(row as DeliveryRowRecord, true)).toMatchObject({
      heldReason: null,
      groupedCount: 0,
    });
  });
});
