import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigration, createFakeD1, seedOrganization } from './support/d1';

/**
 * Migration 0025 (ADR 0023) is expand-only: four ADD COLUMNs on `deliveries` and three new tables. It
 * must change nothing else, so the schema is diffed around it, and the new constraints are exercised.
 */
const FILE = '0025_delivery_ledger_depth.sql';

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

describe('migration 0025', () => {
  it('keeps every existing delivery and defaults the new columns to "nothing recorded"', () => {
    const { raw } = createFakeD1({ before: FILE });
    raw
      .prepare(
        "INSERT INTO deliveries(id,integration_id,organization_id,state,created_at) VALUES('d1','i','o','sent','2026-01-01 00:00:00')",
      )
      .run();
    applyMigration(raw, FILE);
    expect(
      raw
        .prepare(
          'SELECT id,state,duplicate_of,suppressed_reason,possible_duplicate,provider_message_id FROM deliveries',
        )
        .all(),
    ).toEqual([
      {
        id: 'd1',
        state: 'sent',
        duplicate_of: null,
        suppressed_reason: null,
        possible_duplicate: 0,
        provider_message_id: null,
      },
    ]);
  });

  it('changes nothing it does not own: every earlier table, index and trigger is identical', () => {
    const { raw } = createFakeD1({ before: FILE });
    const before = objects(raw);
    applyMigration(raw, FILE);
    const after = objects(raw);
    const added = [...after.keys()].filter((k) => !before.has(k)).sort();
    expect(added).toEqual([
      'index:delivery_attempts_delivery',
      'index:delivery_attempts_started',
      'index:destination_health_state',
      'index:event_dedup_expires',
      'index:event_dedup_key',
      'table:delivery_attempts',
      'table:destination_health',
      'table:event_dedup',
    ]);
    const changed = [...before.keys()].filter((k) => after.get(k) !== before.get(k));
    // Only `deliveries` itself (ADD COLUMN rewrites its stored CREATE statement).
    expect(changed).toEqual(['table:deliveries']);
    const sql = after.get('table:deliveries') ?? '';
    for (const column of ['duplicate_of', 'suppressed_reason', 'possible_duplicate', 'provider_message_id'])
      expect(sql).toContain(column);
  });

  it('rejects values outside the closed vocabularies', () => {
    const { raw } = createFakeD1();
    seedOrganization(raw, 'o');
    raw
      .prepare(
        "INSERT INTO deliveries(id,integration_id,organization_id,state) VALUES('d','i','o','suppressed')",
      )
      .run();
    expect(() => raw.prepare("UPDATE deliveries SET suppressed_reason='because' WHERE id='d'").run()).toThrow(
      /CHECK/,
    );
    expect(() => raw.prepare("UPDATE deliveries SET possible_duplicate=2 WHERE id='d'").run()).toThrow(
      /CHECK/,
    );
    const attempt = (outcome: string, status: string) =>
      raw
        .prepare(
          `INSERT INTO delivery_attempts(id,organization_id,delivery_id,integration_id,attempt,started_at,finished_at,outcome,status_class)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(crypto.randomUUID(), 'o', 'd', 'i', 1, 1, 2, outcome, status);
    expect(() => attempt('delivered', '2xx')).not.toThrow();
    expect(() => attempt('exploded', '2xx')).toThrow(/CHECK/);
    expect(() => attempt('delivered', '418')).toThrow(/CHECK/);
    expect(() =>
      raw
        .prepare(
          "INSERT INTO destination_health(organization_id,integration_id,state,updated_at) VALUES('o','i','ajar',1)",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it('identifies a dedup row by tenant and delivery, and cascades from the organization', () => {
    const { raw } = createFakeD1();
    seedOrganization(raw, 'org-a');
    seedOrganization(raw, 'org-b');
    const insert = raw.prepare(
      'INSERT INTO event_dedup(organization_id,delivery_id,dedup_key,integration_id,first_seen,last_seen,expires_at) VALUES(?,?,?,?,1,1,9)',
    );
    insert.run('org-a', 'd1', 'k', 'i');
    // The same delivery id in another workspace is a different row.
    insert.run('org-b', 'd1', 'k', 'i');
    expect(() => insert.run('org-a', 'd1', 'k', 'i')).toThrow(/UNIQUE|PRIMARY/);
    // An organization that does not exist cannot own one.
    expect(() => insert.run('org-missing', 'd2', 'k', 'i')).toThrow(/FOREIGN KEY/);
    raw.prepare("DELETE FROM organization WHERE id='org-a'").run();
    expect(raw.prepare('SELECT organization_id FROM event_dedup').all()).toEqual([
      { organization_id: 'org-b' },
    ]);
  });

  it('range-seeks the purge and the attempt history by index', () => {
    const { raw } = createFakeD1();
    const plan = (sql: string) =>
      (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join('|');
    expect(plan('SELECT rowid FROM event_dedup WHERE expires_at < 5 LIMIT 10')).toContain(
      'event_dedup_expires',
    );
    expect(
      plan(
        "SELECT * FROM delivery_attempts WHERE organization_id='o' AND delivery_id='d' ORDER BY started_at",
      ),
    ).toContain('delivery_attempts_delivery');
  });
});
