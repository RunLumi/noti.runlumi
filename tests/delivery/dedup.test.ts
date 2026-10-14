import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SUPPRESSED_ROWS_PER_ORIGINAL,
  DEDUP_PURGE_BATCH,
  DEDUP_PURGE_MAX_ROUNDS,
  DEDUP_TTL_MS,
  PROVIDER_REDELIVERY_HORIZON_MS,
  purgeEventDedup,
} from '../../src/delivery/dedup';
import { runCronJobs } from '../../src/observability/cron';
import { comment, count, createHarness, insertIntegration, postGithub, setNow } from '../noise/harness';

/**
 * Dedup storage and recorded suppression (F171, F185, F186 server side) through the real Worker
 * entry point and migrations.
 */
const T0 = '2026-10-14T10:00:00Z';
const T0_MS = Date.parse(T0);

afterEach(() => vi.useRealTimers());

const dedupRows = (h: ReturnType<typeof createHarness>) =>
  h.db.raw.prepare('SELECT * FROM event_dedup ORDER BY rowid').all() as {
    organization_id: string;
    delivery_id: string;
    dedup_key: string;
    integration_id: string;
    first_seen: number;
    last_seen: number;
    hit_count: number;
    expires_at: number;
  }[];

describe('dedup window', () => {
  it('dedup_ttl_exceeds_provider_redelivery_horizon', () => {
    // F171: the window must outlast the longest provider redelivery horizon, with margin.
    for (const [provider, horizon] of Object.entries(PROVIDER_REDELIVERY_HORIZON_MS))
      expect(DEDUP_TTL_MS, provider).toBeGreaterThan(horizon);
    expect(DEDUP_TTL_MS).toBe(7 * 24 * 3_600_000);
  });
});

describe('suppression is recorded, not silent (F185)', () => {
  it('suppressed_duplicate_records_its_reason: a redelivery is a suppressed row pointing at the original', async () => {
    const h = createHarness();
    insertIntegration(h, 'i1', 'org-a', null);
    setNow(T0);
    expect(await postGithub(h, 'issue_comment', comment(7), 'gh-1')).toMatchObject({ persisted: 1 });
    const original = h.db.raw.prepare("SELECT id FROM deliveries WHERE state='pending'").get() as {
      id: string;
    };
    expect(await postGithub(h, 'issue_comment', comment(7), 'gh-1')).toEqual({ status: 202, persisted: 0 });

    const suppressed = h.db.raw
      .prepare(
        "SELECT integration_id,organization_id,state,suppressed_reason,duplicate_of,dedup_key FROM deliveries WHERE state='suppressed'",
      )
      .all();
    expect(suppressed).toEqual([
      {
        integration_id: 'i1',
        organization_id: 'org-a',
        state: 'suppressed',
        suppressed_reason: 'duplicate',
        duplicate_of: original.id,
        // Not the original's key: a later "find the first delivery for this event" never lands here.
        dedup_key: null,
      },
    ]);
    // Exactly one outbox message: nothing was sent twice.
    expect(count(h, 'notification_outbox')).toBe(1);
  });

  it('counts hits and keeps the first sighting; each repeat is its own suppressed row', async () => {
    const h = createHarness();
    insertIntegration(h, 'i1', 'org-a', null);
    setNow(T0);
    await postGithub(h, 'issue_comment', comment(7), 'gh-1');
    setNow('2026-10-14T10:05:00Z');
    await postGithub(h, 'issue_comment', comment(7), 'gh-1');
    setNow('2026-10-14T10:09:00Z');
    await postGithub(h, 'issue_comment', comment(7), 'gh-1');
    const [row, ...rest] = dedupRows(h);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      organization_id: 'org-a',
      integration_id: 'i1',
      hit_count: 2,
      first_seen: T0_MS,
      last_seen: Date.parse('2026-10-14T10:09:00Z'),
      expires_at: T0_MS + DEDUP_TTL_MS,
    });
    expect(count(h, 'deliveries', "state = 'suppressed'")).toBe(2);
    expect(count(h, 'deliveries', "state != 'suppressed'")).toBe(1);
  });

  it('caps suppressed rows per original but keeps counting hits', async () => {
    const h = createHarness();
    insertIntegration(h, 'i1', 'org-a', null);
    setNow(T0);
    await postGithub(h, 'issue_comment', comment(7), 'gh-1');
    const repeats = SUPPRESSED_ROWS_PER_ORIGINAL + 7;
    for (let i = 0; i < repeats; i++) {
      setNow(new Date(T0_MS + (i + 1) * 1000).toISOString());
      await postGithub(h, 'issue_comment', comment(7), 'gh-1');
    }
    expect(count(h, 'deliveries', "state = 'suppressed'")).toBe(SUPPRESSED_ROWS_PER_ORIGINAL);
    expect(dedupRows(h)).toMatchObject([
      { hit_count: repeats, last_seen: T0_MS + repeats * 1000, first_seen: T0_MS },
    ]);
    // Still exactly one message.
    expect(count(h, 'notification_outbox')).toBe(1);
  });

  it('an orphan outbox row that outlived its purged delivery is not a repeat: the new delivery takes it over', async () => {
    const h = createHarness();
    insertIntegration(h, 'i1', 'org-a', null);
    setNow(T0);
    await postGithub(h, 'issue_comment', comment(7), 'gh-1');
    // Retention removed the delivery (and its dedup row) but not yet the outbox row.
    h.db.raw.prepare('DELETE FROM deliveries').run();
    h.db.raw.prepare('DELETE FROM event_dedup').run();
    expect(await postGithub(h, 'issue_comment', comment(7), 'gh-1')).toMatchObject({ persisted: 1 });
    expect(count(h, 'deliveries', "state = 'suppressed'")).toBe(0);
    expect(count(h, 'deliveries', "state = 'pending'")).toBe(1);
    // The takeover re-dispatched it: the notification is sent again rather than silently lost.
    expect(h.sent).toHaveLength(2);
    expect(count(h, 'notification_outbox')).toBe(1);
  });

  it('a genuinely new event is never suppressed', async () => {
    const h = createHarness();
    insertIntegration(h, 'i1', 'org-a', null);
    setNow(T0);
    await postGithub(h, 'issue_comment', comment(7), 'gh-1');
    await postGithub(h, 'issue_comment', comment(8), 'gh-2');
    expect(count(h, 'deliveries', "state = 'suppressed'")).toBe(0);
    expect(count(h, 'deliveries')).toBe(2);
    expect(dedupRows(h).map((r) => r.hit_count)).toEqual([0, 0]);
  });

  it('one event for two integrations is two dedup rows, and a repeat suppresses both', async () => {
    const h = createHarness();
    insertIntegration(h, 'i1', 'org-a', null);
    insertIntegration(h, 'i2', 'org-a', null);
    setNow(T0);
    await postGithub(h, 'issue_comment', comment(7), 'gh-1');
    await postGithub(h, 'issue_comment', comment(7), 'gh-1');
    expect(dedupRows(h)).toHaveLength(2);
    expect(count(h, 'deliveries', "state = 'suppressed'")).toBe(2);
  });

  it('the same provider id in two workspaces never collides: each is delivered, neither suppressed', async () => {
    const h = createHarness();
    insertIntegration(h, 'i1', 'org-a', null);
    insertIntegration(h, 'i3', 'org-b', null);
    setNow(T0);
    expect(await postGithub(h, 'issue_comment', comment(7), 'gh-1', { installation: 1001 })).toMatchObject({
      persisted: 1,
    });
    expect(await postGithub(h, 'issue_comment', comment(7), 'gh-1', { installation: 1002 })).toMatchObject({
      persisted: 1,
    });
    expect(count(h, 'deliveries', "state = 'suppressed'")).toBe(0);
    // And a repeat in one workspace is counted in THAT workspace only.
    await postGithub(h, 'issue_comment', comment(7), 'gh-1', { installation: 1001 });
    expect(dedupRows(h).map((r) => [r.organization_id, r.hit_count])).toEqual([
      ['org-a', 1],
      ['org-b', 0],
    ]);
  });

  it('a repeat that the dedup table no longer knows (purged) is still recorded, never processed twice', async () => {
    const h = createHarness();
    insertIntegration(h, 'i1', 'org-a', null);
    setNow(T0);
    await postGithub(h, 'issue_comment', comment(7), 'gh-1');
    // Past the window the row is purged; the delivery row itself still blocks the repeat.
    const later = T0_MS + DEDUP_TTL_MS + 1000;
    await purgeEventDedup(h.db.d1, later);
    expect(dedupRows(h)).toEqual([]);
    setNow(new Date(later).toISOString());
    expect(await postGithub(h, 'issue_comment', comment(7), 'gh-1')).toEqual({ status: 202, persisted: 0 });
    expect(count(h, 'notification_outbox')).toBe(1);
    expect(count(h, 'deliveries', "state = 'suppressed'")).toBe(1);
    expect(dedupRows(h)).toMatchObject([{ hit_count: 1 }]);
  });

  it('a duplicate whose original is gone (a pre-0025 row) still writes nothing it cannot point at', async () => {
    const h = createHarness();
    insertIntegration(h, 'i1', 'org-a', null);
    setNow(T0);
    await postGithub(h, 'issue_comment', comment(7), 'gh-1');
    // Remove the original delivery and its dedup row: the id no longer exists anywhere.
    h.db.raw.prepare("DELETE FROM deliveries WHERE state='pending'").run();
    h.db.raw.prepare('DELETE FROM event_dedup').run();
    h.db.raw.prepare('DELETE FROM notification_outbox').run();
    // The event is then simply new again (the original is gone), not a phantom suppression.
    expect(await postGithub(h, 'issue_comment', comment(7), 'gh-1')).toMatchObject({ persisted: 1 });
    expect(count(h, 'deliveries', "state = 'suppressed'")).toBe(0);
  });
});

describe('dedup purge job (F171)', () => {
  it('removes only expired rows, in bounded rounds, and resumes on the next tick', async () => {
    const h = createHarness();
    const total = DEDUP_PURGE_BATCH * DEDUP_PURGE_MAX_ROUNDS + 100;
    const insert = h.db.raw.prepare(
      `INSERT INTO event_dedup(organization_id,delivery_id,dedup_key,integration_id,first_seen,last_seen,hit_count,expires_at)
       VALUES('org-a',?,?,'i1',1,1,0,?)`,
    );
    h.db.raw.exec('BEGIN');
    for (let i = 0; i < total; i++) insert.run(`d${i}`, `k${i}`, 1000);
    insert.run('live', 'klive', 9_000_000);
    h.db.raw.exec('COMMIT');
    const first = await purgeEventDedup(h.db.d1, 5000);
    expect(first).toEqual({ purged: DEDUP_PURGE_BATCH * DEDUP_PURGE_MAX_ROUNDS, more: true });
    // purge_resumes_after_interruption: the next tick finishes the rest and leaves the live row.
    const second = await purgeEventDedup(h.db.d1, 5000);
    expect(second).toEqual({ purged: 100, more: false });
    expect(dedupRows(h).map((r) => r.delivery_id)).toEqual(['live']);
  });

  it('a failing purge fails its own cron job and skips none of the others', async () => {
    const ran: string[] = [];
    const failing = {
      prepare: () => ({ bind: () => ({ run: () => Promise.reject(new Error('D1 down')) }) }),
    };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      runCronJobs([
        { name: 'dedup_purge', run: () => purgeEventDedup(failing as unknown as D1Database, 1) },
        { name: 'next', run: () => Promise.resolve(ran.push('next')) },
      ]),
    ).rejects.toThrow('dedup_purge');
    expect(ran).toEqual(['next']);
  });
});
