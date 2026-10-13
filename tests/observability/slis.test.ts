import { beforeEach, describe, expect, it } from 'vitest';
import { sqliteTimestamp } from '../../src/delivery/claim';
import {
  computeSummary,
  DEFAULT_WINDOW_MS,
  MAX_WINDOW_MS,
  nearestRankIndex,
  NOT_MEASURABLE,
  parseWindow,
  ratio,
} from '../../src/observability/slis';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const MIN = 60_000;
let db: FakeD1;
let seq = 0;

interface Row {
  org?: string;
  integration?: string;
  state: string;
  attempts?: number;
  /** Seconds before NOW that the row was created. */
  ageS?: number;
  firstAttemptAfterS?: number;
  lastAttemptAfterS?: number;
  claimedAgoMs?: number;
  nextAttemptAgoMs?: number;
  code?: string | null;
  createdNull?: boolean;
}

function delivery(r: Row): void {
  const created = NOW - (r.ageS ?? 60) * 1000;
  db.raw
    .prepare(
      `INSERT INTO deliveries(id,integration_id,organization_id,state,attempts,created_at,first_attempt_at,
         last_attempt_at,claimed_at,next_attempt_at,last_error_code,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      `d${++seq}`,
      r.integration ?? 'int-slack',
      r.org ?? 'org-a',
      r.state,
      r.attempts ?? 1,
      r.createdNull ? null : sqliteTimestamp(created),
      r.firstAttemptAfterS === undefined ? null : created + r.firstAttemptAfterS * 1000,
      r.lastAttemptAfterS === undefined ? null : created + r.lastAttemptAfterS * 1000,
      r.claimedAgoMs === undefined ? null : NOW - r.claimedAgoMs,
      r.nextAttemptAgoMs === undefined ? null : NOW - r.nextAttemptAgoMs,
      r.code ?? null,
      sqliteTimestamp(created),
    );
}

function integration(id: string, destination: string, org = 'org-a'): void {
  db.raw
    .prepare(
      'INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id) VALUES(?,?,?,?,?,?)',
    )
    .run(id, 'acme/web', '[]', destination, 'x', org);
}

beforeEach(() => {
  db = createFakeD1();
  seq = 0;
  seedOrganization(db.raw, 'org-a');
  seedOrganization(db.raw, 'org-b');
  integration('int-slack', 'slack');
  integration('int-teams', 'teams');
  integration('int-b', 'slack', 'org-b');
});

describe('parseWindow', () => {
  it.each([
    [undefined, DEFAULT_WINDOW_MS],
    ['', DEFAULT_WINDOW_MS],
    ['1h', 3_600_000],
    ['24h', 86_400_000],
    ['7d', 7 * 86_400_000],
    ['30d', MAX_WINDOW_MS],
    ['720h', MAX_WINDOW_MS],
  ])('accepts %s', (raw, ms) => expect(parseWindow(raw)).toBe(ms));

  it.each(['31d', '721h', '0h', '0d', '-1d', '1w', 'abc', '1.5d', '9999d', '24', ' 7d'])(
    'rejects %s',
    (raw) => expect(parseWindow(raw)).toBeNull(),
  );
});

describe('ratio and percentile helpers', () => {
  it('has no value (not 0, not 1) when the denominator is zero', () => {
    expect(ratio(0, 0).value).toBeNull();
    expect(ratio(3, 4)).toEqual({ value: 0.75, numerator: 3, denominator: 4 });
  });

  it('uses nearest-rank indexes', () => {
    expect(nearestRankIndex(1, 0.95)).toBe(0);
    expect(nearestRankIndex(10, 0.5)).toBe(4);
    expect(nearestRankIndex(10, 0.95)).toBe(9);
    expect(nearestRankIndex(100, 0.95)).toBe(94);
  });
});

describe('computeSummary', () => {
  it('reports no data, not zero or one hundred percent, for an empty window', async () => {
    const s = await computeSummary(db.d1, 'org-a', DEFAULT_WINDOW_MS, NOW);
    expect(s.deliveries.total).toBe(0);
    expect(s.successRatio).toMatchObject({ value: null, numerator: 0, denominator: 0 });
    expect(s.retryRate.value).toBeNull();
    expect(s.latency.endToEnd).toMatchObject({ samples: 0, p50Ms: null, p95Ms: null });
    expect(s.backlog).toEqual({
      oldestPendingAgeMs: null,
      oldestClaimedAgeMs: null,
      oldestRetryOverdueMs: null,
      oldestOutboxPendingAgeMs: null,
    });
    expect(s.byDestination).toEqual([]);
  });

  it('counts by state and computes the success ratio over terminal outcomes only', async () => {
    for (let i = 0; i < 6; i++) delivery({ state: 'sent', lastAttemptAfterS: 2 });
    delivery({ state: 'accepted', integration: 'int-teams', lastAttemptAfterS: 2 });
    delivery({ state: 'dead_lettered', code: 'destination_unavailable', attempts: 13 });
    delivery({ state: 'failed', code: 'internal_error' });
    delivery({ state: 'pending', attempts: 0 });
    delivery({ state: 'suppressed' });
    const s = await computeSummary(db.d1, 'org-a', DEFAULT_WINDOW_MS, NOW);
    expect(s.deliveries.total).toBe(11);
    expect(s.deliveries.byState).toMatchObject({
      sent: 6,
      accepted: 1,
      dead_lettered: 2, // legacy `failed` reads as dead_lettered
      pending: 1,
      suppressed: 1,
    });
    // (6 sent + 1 accepted) / (6 + 1 + 2): pending and suppressed are not outcomes.
    expect(s.successRatio).toMatchObject({ numerator: 7, denominator: 9 });
    expect(s.successRatio.value).toBeCloseTo(7 / 9);
    expect(s.successRatio.definition).toContain('accepted');
    expect(s.deadLetter.count).toBe(2);
    expect(s.deadLetter.byErrorCode).toEqual([
      { code: 'destination_unavailable', count: 1 },
      { code: 'internal_error', count: 1 },
    ]);
  });

  it('reports Teams as accepted, never as delivered', async () => {
    delivery({ state: 'accepted', integration: 'int-teams', lastAttemptAfterS: 1 });
    delivery({ state: 'sent', integration: 'int-slack', lastAttemptAfterS: 1 });
    const s = await computeSummary(db.d1, 'org-a', DEFAULT_WINDOW_MS, NOW);
    const teams = s.byDestination.find((d) => d.destination === 'teams');
    const slack = s.byDestination.find((d) => d.destination === 'slack');
    expect(teams).toMatchObject({ outcomeKind: 'accepted', sent: 0, accepted: 1 });
    expect(slack).toMatchObject({ outcomeKind: 'delivered', sent: 1, accepted: 0 });
  });

  it('labels deliveries of a deleted integration as unknown instead of dropping them', async () => {
    delivery({ state: 'sent', integration: 'gone', lastAttemptAfterS: 1 });
    const s = await computeSummary(db.d1, 'org-a', DEFAULT_WINDOW_MS, NOW);
    expect(s.byDestination).toMatchObject([{ destination: 'unknown', sent: 1, outcomeKind: 'delivered' }]);
  });

  it('computes exact nearest-rank percentiles for end-to-end and queue delay', async () => {
    // 20 sent rows with end-to-end 1..20 s and queue delay 0..9 s (1 s resolution).
    for (let i = 1; i <= 20; i++) {
      delivery({ state: 'sent', firstAttemptAfterS: (i - 1) % 10, lastAttemptAfterS: i });
    }
    const s = await computeSummary(db.d1, 'org-a', DEFAULT_WINDOW_MS, NOW);
    expect(s.latency.endToEnd).toMatchObject({ samples: 20, excluded: 0, p50Ms: 10_000, p95Ms: 19_000 });
    expect(s.latency.endToEnd.resolutionMs).toBe(1000);
    expect(s.latency.queueDelay.samples).toBe(20);
    expect(s.latency.queueDelay.p95Ms).toBe(9_000);
  });

  it('excludes rows with missing timestamps from percentiles and counts them', async () => {
    delivery({ state: 'sent', lastAttemptAfterS: 4 });
    delivery({ state: 'sent', createdNull: true, lastAttemptAfterS: 4 });
    delivery({ state: 'sent' }); // no last_attempt_at
    const s = await computeSummary(db.d1, 'org-a', DEFAULT_WINDOW_MS, NOW);
    expect(s.latency.endToEnd).toMatchObject({ samples: 1, p50Ms: 4_000, p95Ms: 4_000 });
    // The NULL created_at row falls outside every window; the missing-attempt row is excluded.
    expect(s.latency.endToEnd.excluded).toBe(1);
  });

  it('does not report an average anywhere', async () => {
    delivery({ state: 'sent', lastAttemptAfterS: 4 });
    const s = JSON.stringify(await computeSummary(db.d1, 'org-a', DEFAULT_WINDOW_MS, NOW));
    expect(s.toLowerCase()).not.toMatch(/\bavg\b|average|\bmean\b/);
  });

  it('computes the retry rate among attempted deliveries', async () => {
    delivery({ state: 'sent', attempts: 1, lastAttemptAfterS: 1 });
    delivery({ state: 'sent', attempts: 3, lastAttemptAfterS: 1 });
    delivery({ state: 'dead_lettered', attempts: 13 });
    delivery({ state: 'pending', attempts: 0 });
    const s = await computeSummary(db.d1, 'org-a', DEFAULT_WINDOW_MS, NOW);
    expect(s.retryRate).toMatchObject({ numerator: 2, denominator: 3 });
  });

  it('applies the window to created_at', async () => {
    delivery({ state: 'sent', ageS: 3600 * 2, lastAttemptAfterS: 1 });
    delivery({ state: 'sent', ageS: 3600 * 30, lastAttemptAfterS: 1 });
    expect((await computeSummary(db.d1, 'org-a', 3_600_000 * 24, NOW)).deliveries.total).toBe(1);
    expect((await computeSummary(db.d1, 'org-a', 3_600_000 * 48, NOW)).deliveries.total).toBe(2);
  });

  it('measures backlog age from pending, claimed, overdue-retry and outbox rows', async () => {
    delivery({ state: 'pending', attempts: 0, ageS: 600 });
    delivery({ state: 'pending', attempts: 0, ageS: 60 });
    delivery({ state: 'claimed', claimedAgoMs: 7 * MIN });
    delivery({ state: 'retrying', nextAttemptAgoMs: 3 * MIN });
    delivery({ state: 'retrying', nextAttemptAgoMs: -10 * MIN }); // not yet due
    db.raw
      .prepare(
        'INSERT INTO notification_outbox(id,payload_json,state,organization_id,created_at) VALUES(?,?,?,?,?)',
      )
      .run('o1', '{}', 'pending', 'org-a', sqliteTimestamp(NOW - 9 * MIN));
    const s = await computeSummary(db.d1, 'org-a', DEFAULT_WINDOW_MS, NOW);
    expect(s.backlog).toEqual({
      oldestPendingAgeMs: 600_000,
      oldestClaimedAgeMs: 7 * MIN,
      oldestRetryOverdueMs: 3 * MIN,
      oldestOutboxPendingAgeMs: 9 * MIN,
    });
  });

  it('never includes another workspace in any figure', async () => {
    delivery({ state: 'sent', lastAttemptAfterS: 1 });
    delivery({ org: 'org-b', integration: 'int-b', state: 'dead_lettered', code: 'internal_error' });
    delivery({ org: 'org-b', integration: 'int-b', state: 'pending', attempts: 0, ageS: 5000 });
    db.raw
      .prepare(
        'INSERT INTO notification_outbox(id,payload_json,state,organization_id,created_at) VALUES(?,?,?,?,?)',
      )
      .run('ob', '{}', 'pending', 'org-b', sqliteTimestamp(NOW - 50 * MIN));
    const s = await computeSummary(db.d1, 'org-a', DEFAULT_WINDOW_MS, NOW);
    expect(s.deliveries.total).toBe(1);
    expect(s.deadLetter.count).toBe(0);
    expect(s.deadLetter.byErrorCode).toEqual([]);
    expect(s.backlog.oldestPendingAgeMs).toBeNull();
    expect(s.backlog.oldestOutboxPendingAgeMs).toBeNull();
    expect(s.successRatio).toMatchObject({ numerator: 1, denominator: 1 });
  });

  it('names what it cannot measure rather than inventing it', async () => {
    const s = await computeSummary(db.d1, 'org-a', DEFAULT_WINDOW_MS, NOW);
    const names = s.notMeasurable.map((n) => n.sli);
    expect(names).toEqual(
      expect.arrayContaining(['acceptance_rate', 'routing_rate', 'ack_latency', 'unmapped_provider_errors']),
    );
    expect(s.notMeasurable).toBe(NOT_MEASURABLE);
    expect(s.provenance).toBe('exact');
    for (const n of NOT_MEASURABLE) expect(n.reason.length).toBeGreaterThan(10);
  });

  it('does not use the words exactly-once', async () => {
    const s = JSON.stringify(await computeSummary(db.d1, 'org-a', DEFAULT_WINDOW_MS, NOW));
    expect(s.toLowerCase()).not.toMatch(/exactly[- ]once/);
  });
});
