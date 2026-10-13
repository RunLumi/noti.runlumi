import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigration, createFakeD1 } from './support/d1';

describe('migration 0015', () => {
  const names = (raw: DatabaseSync, type: 'index' | 'trigger', table = 'integrations'): string[] =>
    (
      raw
        .prepare('SELECT name FROM sqlite_master WHERE type=? AND tbl_name=? ORDER BY name')
        .all(type, table) as { name: string }[]
    ).map((r) => r.name);

  function seed(raw: DatabaseSync): void {
    const insert = raw.prepare(
      `INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,enabled,organization_id,name,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    );
    insert.run('a', 'acme/web', '["push"]', 'slack', '', 1, 'org-a', 'Alerts', '2026-01-01');
    insert.run('b', 'acme/api', '["issues.opened"]', 'teams', 'x', 0, 'org-b', null, null);
  }

  it('adds a nullable filters column and keeps every row, index and trigger', () => {
    const { raw } = createFakeD1({ before: '0015' });
    seed(raw);
    const rows = raw.prepare('SELECT * FROM integrations ORDER BY id').all();
    const indexes = names(raw, 'index');
    const triggers = names(raw, 'trigger');

    applyMigration(raw, '0015_routing_filters.sql');

    const after = raw.prepare('SELECT * FROM integrations ORDER BY id').all() as Record<string, unknown>[];
    expect(after.map(({ filters_json, ...rest }) => ({ filters_json, rest }))).toEqual(
      rows.map((r) => ({ filters_json: null, rest: r })),
    );
    expect(names(raw, 'index')).toEqual(indexes);
    expect(names(raw, 'trigger')).toEqual(triggers);
    // Existing integrations keep routing exactly as before: no filters, nothing held back.
    expect(
      raw.prepare('SELECT COUNT(*) AS n FROM integrations WHERE filters_json IS NOT NULL').get(),
    ).toEqual({
      n: 0,
    });
  });

  it('only admits valid, bounded JSON in filters_json', () => {
    const { raw } = createFakeD1();
    seed(raw);
    const set = (value: string | null) =>
      raw.prepare("UPDATE integrations SET filters_json=? WHERE id='a'").run(value);
    expect(() => set('{"v":1}')).not.toThrow();
    expect(() => set(null)).not.toThrow();
    expect(() => set('{not json')).toThrow(/CHECK/);
    expect(() => set(JSON.stringify({ v: 1, pad: 'x'.repeat(9000) }))).toThrow(/CHECK/);
  });

  it('still enforces the tenant contract on integrations', () => {
    const { raw } = createFakeD1();
    expect(() =>
      raw
        .prepare(
          "INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext) VALUES('x','a/b','[]','slack','')",
        )
        .run(),
    ).toThrow(/organization_id is required/);
  });

  it('creates routing_decisions with its indexes', () => {
    const { raw } = createFakeD1();
    expect(names(raw, 'index', 'routing_decisions')).toEqual(
      expect.arrayContaining(['routing_decisions_integration', 'routing_decisions_decided']),
    );
  });
});
