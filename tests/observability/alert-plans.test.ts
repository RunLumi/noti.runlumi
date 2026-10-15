import { describe, expect, it } from 'vitest';
import { SIGNAL_QUERIES } from '../../src/observability/alerts/signals';
import { LOAD_ALERTS_SQL } from '../../src/observability/alerts/state';
import { JOB_HEALTH_SQL } from '../../src/observability/job-health';
import { HISTORY_SQL, STATE_SQL } from '../../src/observability/job-runs';
import { STALL_COUNT_CAP, STALL_SQL } from '../../src/observability/stall';
import { createFakeD1 } from '../support/d1';

/**
 * The alert signals run every minute, including during an outage when the ledger is largest. This pins the
 * query plan of EVERY one of them: a seek on an index, never a scan of a table that grows with customers
 * (`deliveries`, `integrations`, `sources`, `delivery_attempts`, `destination_health`, `notification_outbox`).
 * Style follows tests/migration-0025.test.ts.
 */
const { raw } = createFakeD1();

/** Bind markers become literals: the planner chooses by structure, not by value. */
const plan = (sql: string): string[] =>
  (
    raw.prepare(`EXPLAIN QUERY PLAN ${sql.replace(/\?\d*/g, '1')}`).all() as unknown as { detail: string }[]
  ).map((r) => r.detail);

const BIG = [
  'deliveries',
  'integrations',
  'sources',
  'delivery_attempts',
  'destination_health',
  'notification_outbox',
  'job_runs',
];

function scansOf(details: string[]): string[] {
  return details.filter((d) => {
    const m = /^SCAN (?:TABLE )?(\w+)/.exec(d);
    return m !== null && BIG.includes(m[1] ?? '');
  });
}

describe('the checker itself', () => {
  it('flags a scan of a big table (negative control)', () => {
    expect(scansOf(plan('SELECT COUNT(*) FROM deliveries WHERE is_test = 1')).length).toBeGreaterThan(0);
    expect(scansOf(plan("SELECT COUNT(*) FROM integrations WHERE destination = 'x'")).length).toBeGreaterThan(
      0,
    );
  });
});

describe('every alert signal query is an index seek', () => {
  const queries: [string, string][] = [
    ...Object.entries(SIGNAL_QUERIES),
    ['STALL_SQL (stall.ts, shared by the detector and outbox_stall)', STALL_SQL],
    ['JOB_HEALTH_SQL', JOB_HEALTH_SQL],
    ['LOAD_ALERTS_SQL', LOAD_ALERTS_SQL],
  ];

  it.each(queries)('%s', (_name, sql) => {
    const details = plan(sql);
    expect(details.length).toBeGreaterThan(0);
    expect(scansOf(details), details.join('\n')).toEqual([]);
  });

  it('the dead-letter, quarantine and drop counts use the partial indexes of migration 0027', () => {
    expect(plan(SIGNAL_QUERIES.DEAD_LETTERS_SQL ?? '').join('\n')).toMatch(/delivery_attempts_dead/);
    expect(plan(SIGNAL_QUERIES.QUARANTINED_SQL ?? '').join('\n')).toMatch(/integrations_quarantined/);
    expect(plan(SIGNAL_QUERIES.SOURCES_DROPPING_SQL ?? '').join('\n')).toMatch(/sources_dropped/);
  });

  it('the breaker count seeks by state, the pending age and the stuck rows by (state, created_at)', () => {
    expect(plan(SIGNAL_QUERIES.BREAKERS_SQL ?? '').join('\n')).toMatch(/destination_health_state/);
    expect(plan(SIGNAL_QUERIES.BREAKERS_HOLDING_SQL ?? '').join('\n')).toMatch(/destination_health_state/);
    expect(plan(SIGNAL_QUERIES.OLDEST_PENDING_SQL ?? '').join('\n')).toMatch(/deliveries_state_created/);
    expect(plan(SIGNAL_QUERIES.DEAD_LETTER_STUCK_SQL ?? '').join('\n')).toMatch(/deliveries_state_created/);
  });

  it('the stall counts are capped, and every count in the signals is capped by a LIMIT', () => {
    expect(STALL_COUNT_CAP).toBeGreaterThan(0);
    expect(STALL_SQL.match(/LIMIT \?5/g)).toHaveLength(3);
    for (const [name, sql] of Object.entries(SIGNAL_QUERIES)) {
      if (name === 'OLDEST_PENDING_SQL') {
        expect(sql).toMatch(/LIMIT 1\b/);
      } else {
        expect(sql, name).toMatch(/LIMIT \?\d/);
      }
    }
  });

  it('the job-run writes touch only the primary keys: no scan, no secondary index to maintain on job_state', () => {
    const idx = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='job_state'")
      .all();
    expect(idx.filter((i) => !String((i as { name: string }).name).startsWith('sqlite_autoindex'))).toEqual(
      [],
    );
    expect(scansOf(plan(HISTORY_SQL))).toEqual([]);
    expect(scansOf(plan(STATE_SQL))).toEqual([]);
  });
});
