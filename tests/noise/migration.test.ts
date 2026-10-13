import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigration, createFakeD1 } from '../support/d1';

describe('migration 0021', () => {
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

  it('adds a nullable noise column and keeps every row, index and trigger', () => {
    const { raw } = createFakeD1({ before: '0021' });
    seed(raw);
    const rows = raw.prepare('SELECT * FROM integrations ORDER BY id').all();
    const indexes = names(raw, 'index');
    const triggers = names(raw, 'trigger');

    applyMigration(raw, '0021_noise_control.sql');

    const after = raw.prepare('SELECT * FROM integrations ORDER BY id').all() as Record<string, unknown>[];
    expect(after.map(({ noise_json, ...rest }) => ({ noise_json, rest }))).toEqual(
      rows.map((r) => ({ noise_json: null, rest: r })),
    );
    expect(names(raw, 'index')).toEqual(indexes);
    expect(names(raw, 'trigger')).toEqual(triggers);
    // Existing integrations keep delivering exactly as before: no settings, nothing held.
    expect(raw.prepare('SELECT COUNT(*) AS n FROM integrations WHERE noise_json IS NOT NULL').get()).toEqual({
      n: 0,
    });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM held_events').get()).toEqual({ n: 0 });
  });

  it('only admits valid, bounded JSON in noise_json', () => {
    const { raw } = createFakeD1();
    seed(raw);
    const set = (value: string | null) =>
      raw.prepare("UPDATE integrations SET noise_json=? WHERE id='a'").run(value);
    expect(() => set('{"v":1}')).not.toThrow();
    expect(() => set(null)).not.toThrow();
    expect(() => set('{not json')).toThrow(/CHECK/);
    expect(() => set(JSON.stringify({ v: 1, pad: 'x'.repeat(2100) }))).toThrow(/CHECK/);
  });

  describe('held_events', () => {
    const insert = (raw: DatabaseSync, over: Record<string, string | number | null> = {}): void => {
      const row = {
        id: 'h1',
        organization_id: 'org-a',
        integration_id: 'a',
        hold_reason: 'digest',
        group_key: 'k'.repeat(32),
        state: 'held',
        release_at: 1,
        held_at: 1,
        event_type: 'issues.opened',
        title: 't',
        url: '',
        repo: '',
        actor: '',
        status: 'info',
        summary: '',
        ...over,
      };
      raw
        .prepare(
          `INSERT INTO held_events(${Object.keys(row).join(',')}) VALUES(${Object.keys(row)
            .map(() => '?')
            .join(',')})`,
        )
        .run(...Object.values(row));
    };

    it('admits a well-formed row', () => {
      const { raw } = createFakeD1();
      expect(() => insert(raw)).not.toThrow();
    });

    it.each([
      ['an unknown hold reason', { hold_reason: 'because' }],
      ['an unknown state', { state: 'lost' }],
      ['an unknown status', { status: 'purple' }],
      ['a short group key', { group_key: 'short' }],
      ['a title over 300 characters', { title: 'x'.repeat(301) }],
      ['a summary over 280 characters', { summary: 'x'.repeat(281) }],
      ['a url over 1000 characters', { url: 'x'.repeat(1001) }],
      ['a missing organization', { organization_id: null }],
    ])('refuses %s (the table is bounded and tenant-scoped by construction)', (_name, over) => {
      const { raw } = createFakeD1();
      expect(() => insert(raw, over)).toThrow(/CHECK|NOT NULL/);
    });

    it('has no column that could hold a payload', () => {
      const { raw } = createFakeD1();
      const columns = (raw.prepare('PRAGMA table_info(held_events)').all() as { name: string }[]).map(
        (c) => c.name,
      );
      expect(columns).toEqual(
        expect.not.arrayContaining(['payload', 'payload_json', 'body', 'headers', 'secret']),
      );
      expect(columns).toContain('organization_id');
    });

    it('uses an index for the due-row scan and the delivery-log join', () => {
      const { raw } = createFakeD1();
      const plan = (sql: string): string =>
        (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
          .map((r) => r.detail)
          .join('\n');
      expect(
        plan(
          "SELECT organization_id, integration_id FROM held_events WHERE state='held' AND release_at<=1 GROUP BY organization_id, integration_id",
        ),
      ).toContain('held_events_state_due');
      expect(
        plan("SELECT COUNT(*) FROM held_events WHERE organization_id='o' AND released_in='x'"),
      ).toContain('held_events_released_in');
    });
  });

  it('keeps one open failure per integration and workflow key', () => {
    const { raw } = createFakeD1();
    const insert = raw.prepare(
      'INSERT INTO noise_open_failures(organization_id,integration_id,key_hash,opened_at) VALUES(?,?,?,?)',
    );
    insert.run('org-a', 'a', 'k'.repeat(32), 1);
    expect(() => insert.run('org-a', 'a', 'k'.repeat(32), 2)).toThrow(/UNIQUE/);
    expect(() => insert.run('org-b', 'a', 'k'.repeat(32), 2)).not.toThrow();
    expect(() => insert.run('org-a', 'a', 'short', 2)).toThrow(/CHECK/);
  });
});
