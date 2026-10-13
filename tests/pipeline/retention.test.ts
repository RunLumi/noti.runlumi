import { beforeEach, describe, expect, it } from 'vitest';
import { sqliteTimestamp } from '../../src/delivery/claim';
import {
  AUDIT_RETENTION,
  DELIVERY_RETENTION,
  parseRetentionDays,
  purgeExpiredRecords,
  RETENTION_BATCH,
  RETENTION_MAX_ROUNDS,
} from '../../src/pipeline/retention';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const DAY = 86_400_000;
let db: FakeD1;
let seq = 0;

function delivery(state: string, ageDays: number, deadLetteredAgeDays: number | null = null): string {
  const id = `d${++seq}`;
  const created = sqliteTimestamp(NOW - ageDays * DAY);
  db.raw
    .prepare(
      `INSERT INTO deliveries(id,integration_id,organization_id,state,created_at,updated_at,dead_lettered_at)
       VALUES(?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      'i',
      seq % 2 ? 'org-a' : 'org-b',
      state,
      created,
      created,
      deadLetteredAgeDays === null ? null : NOW - deadLetteredAgeDays * DAY,
    );
  return id;
}

function outbox(id: string, state: string, ageDays: number): void {
  db.raw
    .prepare(
      'INSERT INTO notification_outbox(id,payload_json,state,organization_id,created_at) VALUES(?,?,?,?,?)',
    )
    .run(id, '{}', state, 'org-a', sqliteTimestamp(NOW - ageDays * DAY));
}

function audit(ageDays: number): void {
  db.raw
    .prepare(
      'INSERT INTO audit_events(id,organization_id,action,subject_type,outcome,created_at) VALUES(?,?,?,?,?,?)',
    )
    .run(
      `a${++seq}`,
      'org-a',
      'integration.create',
      'integration',
      'success',
      sqliteTimestamp(NOW - ageDays * DAY),
    );
}

const ids = (table: string): string[] =>
  (db.raw.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as { id: string }[]).map((r) => r.id);

beforeEach(() => {
  db = createFakeD1();
  seq = 0;
  seedOrganization(db.raw, 'org-a');
  seedOrganization(db.raw, 'org-b');
});

describe('parseRetentionDays', () => {
  it.each([
    ['90', 90],
    ['30', 30],
    ['365', 365],
    [45, 45],
  ])('accepts %s', (raw, n) => expect(parseRetentionDays(raw, DELIVERY_RETENTION)).toBe(n));

  it.each([undefined, '', 'abc', '0', '1', '29', '366', '-5', '1.5', '9'.repeat(8), '90 days'])(
    'falls back to the default for %s',
    (raw) => expect(parseRetentionDays(raw, DELIVERY_RETENTION)).toBe(90),
  );

  it('has its own bounds for audit events', () => {
    expect(parseRetentionDays(undefined, AUDIT_RETENTION)).toBe(365);
    expect(parseRetentionDays('3650', AUDIT_RETENTION)).toBe(3650);
    expect(parseRetentionDays('3651', AUDIT_RETENTION)).toBe(365);
  });
});

describe('purgeExpiredRecords: deliveries', () => {
  it('deletes only terminal rows older than the cutoff', async () => {
    const oldSent = delivery('sent', 100);
    const oldAccepted = delivery('accepted', 100);
    const oldSuppressed = delivery('suppressed', 100);
    const oldLegacyFailed = delivery('failed', 100);
    const young = delivery('sent', 10);
    const edge = delivery('sent', 89);
    const report = await purgeExpiredRecords({ DB: db.d1 }, NOW);
    expect(report.deliveries).toBe(4);
    expect(ids('deliveries')).toEqual([young, edge].sort());
    expect([oldSent, oldAccepted, oldSuppressed, oldLegacyFailed]).toHaveLength(4);
  });

  it('never deletes a non-terminal row, however old', async () => {
    const live = ['pending', 'claimed', 'retrying'].map((s) => delivery(s, 400));
    await purgeExpiredRecords({ DB: db.d1 }, NOW);
    expect(ids('deliveries')).toEqual(live.sort());
  });

  it('keeps a dead-lettered row until both its creation and its dead-lettering are past retention', async () => {
    const recentlyDead = delivery('dead_lettered', 200, 5);
    const justBefore = delivery('dead_lettered', 200, 89);
    const expired = delivery('dead_lettered', 200, 120);
    const noStamp = delivery('dead_lettered', 200, null);
    const youngDead = delivery('dead_lettered', 10, 10);
    await purgeExpiredRecords({ DB: db.d1 }, NOW);
    expect(ids('deliveries')).toEqual([recentlyDead, justBefore, youngDead].sort());
    expect([expired, noStamp]).toHaveLength(2);
  });

  it('uses updated_at for legacy rows with no created_at', async () => {
    db.raw
      .prepare(
        "INSERT INTO deliveries(id,integration_id,organization_id,state,updated_at) VALUES('legacy','i','org-a','sent',?)",
      )
      .run(sqliteTimestamp(NOW - 200 * DAY));
    expect((await purgeExpiredRecords({ DB: db.d1 }, NOW)).deliveries).toBe(1);
  });

  it('is tenant-agnostic: expired rows of every workspace go', async () => {
    delivery('sent', 100);
    delivery('sent', 100);
    expect((await purgeExpiredRecords({ DB: db.d1 }, NOW)).deliveries).toBe(2);
    expect(ids('deliveries')).toEqual([]);
  });

  it('honours DELIVERY_RETENTION_DAYS, and ignores an unsafe value', async () => {
    delivery('sent', 40);
    delivery('sent', 100);
    await purgeExpiredRecords({ DB: db.d1, DELIVERY_RETENTION_DAYS: '30' }, NOW);
    expect(ids('deliveries')).toEqual([]);
    delivery('sent', 40);
    // "1" is below the 30-day floor, so the 90-day default applies and the row stays.
    await purgeExpiredRecords({ DB: db.d1, DELIVERY_RETENTION_DAYS: '1' }, NOW);
    expect(ids('deliveries')).toHaveLength(1);
  });

  it('is bounded per tick and reports that more remains', async () => {
    const rows = RETENTION_BATCH * RETENTION_MAX_ROUNDS + 100;
    db.raw
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
         INSERT INTO deliveries(id,integration_id,organization_id,state,created_at,updated_at)
         SELECT 'bulk'||i,'i','org-a','sent',?,? FROM n`,
      )
      .run(rows, sqliteTimestamp(NOW - 100 * DAY), sqliteTimestamp(NOW - 100 * DAY));
    const first = await purgeExpiredRecords({ DB: db.d1 }, NOW);
    expect(first).toMatchObject({ deliveries: RETENTION_BATCH * RETENTION_MAX_ROUNDS, more: true });
    const second = await purgeExpiredRecords({ DB: db.d1 }, NOW);
    expect(second).toMatchObject({ deliveries: 100, more: false });
  });
});

describe('purgeExpiredRecords: outbox', () => {
  it('removes expired dispatched or invalid rows that have no delivery, and keeps the rest', async () => {
    const kept = delivery('dead_lettered', 10, 10);
    outbox(kept, 'dispatched', 100); // a retained delivery keeps its replay message
    outbox('orphan-dispatched', 'dispatched', 100);
    outbox('orphan-invalid', 'invalid', 100);
    outbox('young-orphan', 'dispatched', 5);
    outbox('old-pending', 'pending', 100); // work that was never dispatched is not ours to delete
    outbox('old-claimed', 'claimed', 100);
    const report = await purgeExpiredRecords({ DB: db.d1 }, NOW);
    expect(report.outbox).toBe(2);
    expect(ids('notification_outbox')).toEqual([kept, 'old-claimed', 'old-pending', 'young-orphan'].sort());
  });
});

describe('purgeExpiredRecords: audit events', () => {
  it('deletes events older than AUDIT_RETENTION_DAYS and keeps newer ones', async () => {
    audit(400);
    audit(364);
    audit(1);
    const report = await purgeExpiredRecords({ DB: db.d1 }, NOW);
    expect(report.audit).toBe(1);
    expect(ids('audit_events')).toHaveLength(2);
  });

  it('honours a longer window', async () => {
    audit(400);
    expect((await purgeExpiredRecords({ DB: db.d1, AUDIT_RETENTION_DAYS: '730' }, NOW)).audit).toBe(0);
  });

  it('leaves audit events append-only for updates (the purge is delete-only)', () => {
    audit(1);
    expect(() => db.raw.prepare("UPDATE audit_events SET action='x'").run()).toThrow(/append-only/);
  });
});
