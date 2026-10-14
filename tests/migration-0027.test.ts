import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigration, createFakeD1, seedOrganization } from './support/d1';

/**
 * Migration 0027 (ADR 0024) is expand-only: two new platform tables and a nullable `correlation_id`
 * column on three existing tables. It must change nothing else.
 */
const FILE = '0027_job_runner_alerting.sql';

interface SchemaRow {
  type: string;
  name: string;
  sql: string | null;
}

const objects = (raw: DatabaseSync): Map<string, string> =>
  new Map(
    (
      raw
        .prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
        .all() as unknown as SchemaRow[]
    ).map((r) => [`${r.type}:${r.name}`, (r.sql ?? '').replace(/\s+/g, '')]),
  );

describe('migration 0027', () => {
  it('keeps every existing row and gives it no correlation id', () => {
    const { raw } = createFakeD1({ before: FILE });
    seedOrganization(raw, 'o');
    raw
      .prepare(
        "INSERT INTO deliveries(id,integration_id,organization_id,state,created_at) VALUES('d1','i','o','sent','2026-01-01 00:00:00')",
      )
      .run();
    raw
      .prepare("INSERT INTO notification_outbox(id,organization_id,payload_json) VALUES('d1','o','{}')")
      .run();
    raw
      .prepare(
        "INSERT INTO delivery_attempts(id,organization_id,delivery_id,integration_id,attempt,started_at,finished_at,outcome) VALUES('a1','o','d1','i',1,1,2,'delivered')",
      )
      .run();
    applyMigration(raw, FILE);
    for (const table of ['deliveries', 'notification_outbox', 'delivery_attempts']) {
      expect(raw.prepare(`SELECT correlation_id AS c FROM ${table}`).all(), table).toEqual([{ c: null }]);
    }
    expect(raw.prepare('SELECT id,state FROM deliveries').all()).toEqual([{ id: 'd1', state: 'sent' }]);
  });

  it('adds only the three tables, their indexes, the partial alert indexes and three columns', () => {
    const { raw } = createFakeD1({ before: FILE });
    const before = objects(raw);
    applyMigration(raw, FILE);
    const after = objects(raw);
    const added = [...after.keys()].filter((k) => !before.has(k)).sort();
    expect(added).toEqual([
      'index:deliveries_correlation',
      'index:deliveries_org_correlation',
      'index:delivery_attempts_dead',
      'index:integrations_quarantined',
      'index:job_runs_started',
      'index:sources_dropped',
      'table:alert_state',
      'table:job_runs',
      'table:job_state',
    ]);
    const changed = [...before.keys()].filter((k) => before.get(k) !== after.get(k)).sort();
    expect(changed).toEqual(['table:deliveries', 'table:delivery_attempts', 'table:notification_outbox']);
    for (const k of changed) expect(after.get(k)).toContain('correlation_id');
  });

  it('is not a tenant table: job_runs and alert_state carry no organization_id', () => {
    const { raw } = createFakeD1();
    for (const table of ['job_runs', 'job_state', 'alert_state']) {
      const cols = raw.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[];
      expect(
        cols.map((c) => c.name),
        table,
      ).not.toContain('organization_id');
    }
  });

  it('bounds what a row may hold', () => {
    const { raw } = createFakeD1();
    seedOrganization(raw, 'o');
    const run = (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).run(...args);
    const jobRun =
      'INSERT INTO job_runs(job,started_at,finished_at,outcome,healthy,counters_json,error_class) VALUES(?,?,?,?,?,?,?)';
    expect(() => run(jobRun, 'heartbeat', 1, 2, 'ok', 1, null, null)).not.toThrow();
    expect(() => run(jobRun, 'heartbeat', 1, 2, 'maybe', 1, null, null)).toThrow(); // closed outcome
    expect(() => run(jobRun, 'heartbeat', 1, 2, 'ok', 2, null, null)).toThrow(); // healthy is 0 or 1
    expect(() => run(jobRun, 'x'.repeat(61), 1, 2, 'ok', 1, null, null)).toThrow();
    expect(() => run(jobRun, 'heartbeat', 1, 2, 'ok', 1, 'x'.repeat(501), null)).toThrow(); // counters stay small
    expect(() => run(jobRun, 'heartbeat', 1, 2, 'failed', 0, null, 'x'.repeat(41))).toThrow(); // class, not a message
    const jobState =
      'INSERT INTO job_state(job,first_seen_at,last_started_at,last_finished_at,last_outcome,last_error_class) VALUES(?,?,?,?,?,?)';
    expect(() => run(jobState, 'heartbeat', 1, 1, 2, 'ok', null)).not.toThrow();
    expect(() => run(jobState, 'dup', 1, 1, 2, 'paused', null)).toThrow(); // closed outcome
    expect(() => run(jobState, 'heartbeat', 1, 1, 2, 'ok', null)).toThrow(); // one row per job
    expect(() => run(jobState, 'x2', 1, 1, 2, 'failed', 'x'.repeat(41))).toThrow(); // class, not a message
    const alert = 'INSERT INTO alert_state(alert_id,state,since,dedupe_key,updated_at) VALUES(?,?,?,?,?)';
    expect(() => run(alert, 'job_stale', 'firing', 1, 'job_stale:1', 1)).not.toThrow();
    expect(() => run(alert, 'other', 'paging', 1, 'k', 1)).toThrow();
    expect(() =>
      run(
        "INSERT INTO alert_state(alert_id,state,since,dedupe_key,unsent,updated_at) VALUES('x','firing',1,'k','paged',1)",
      ),
    ).toThrow(); // an unsent notice is one of the three kinds
    const delivery =
      'INSERT INTO deliveries(id,integration_id,organization_id,state,correlation_id) VALUES(?,?,?,?,?)';
    expect(() => run(delivery, 'd1', 'i', 'o', 'pending', 'c'.repeat(64))).not.toThrow();
    expect(() => run(delivery, 'd2', 'i', 'o', 'pending', 'c'.repeat(65))).toThrow();
  });

  it('never targets a table 0026 keeps aside as `<t>_old`, and its object names collide with nothing', () => {
    const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', FILE), 'utf8');
    expect(sql.replace(/--.*$/gm, '')).not.toMatch(/_old\b/);
    // Applying every migration in order succeeding is the collision check: a duplicate index or table name
    // would fail here. Re-run with `_old` tables present (PR #55's 0026) once it is the base.
    expect(() => createFakeD1()).not.toThrow();
  });
});
