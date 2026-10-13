import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigration, createFakeD1 } from './support/d1';

/**
 * Migration 0018 rebuilds `integrations` to widen one CHECK. The rebuild is only safe if it
 * changes nothing else, so these tests diff the whole schema around it instead of listing
 * what we remember adding. Anything a later migration adds to this table, or to a trigger
 * that names it, must be carried over here too; this test is what notices when one is missed.
 */
const OLD_KINDS = "'lark','slack','teams'";
const NEW_KINDS = "'lark','slack','teams','discord','generic_webhook'";

const squash = (sql: string | null): string => (sql ?? '').replace(/\s+/g, '');

interface SchemaRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

/** Every schema object that is, or names, `integrations`, keyed by type and name. */
function snapshot(raw: DatabaseSync): Map<string, string> {
  const rows = raw
    .prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql LIKE '%integrations%'")
    .all() as unknown as SchemaRow[];
  return new Map(rows.map((r) => [`${r.type}:${r.name}`, squash(r.sql)]));
}

function columns(raw: DatabaseSync): unknown[] {
  return raw.prepare('PRAGMA table_info(integrations)').all();
}

function seed(raw: DatabaseSync): void {
  raw.exec(`
    INSERT INTO organization(id,name,slug,created_at) VALUES('org-a','a','a',1),('org-b','b','b',1);
    INSERT INTO sources(id,organization_id,kind,name,endpoint_id,secret_envelope,key_salt,dek_wrapped,kek_version)
      VALUES('src-a','org-a','generic','Deploys','ep-aaaaaaaaaaaaaaaaaaaaaaaa',x'00',x'00',x'00',1);
  `);
  const insert = raw.prepare(
    `INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,enabled,organization_id,name,
       destination_host,created_at,filters_json,source_id,key_salt,dek_wrapped,kek_version,webhook_envelope,
       lark_secret_envelope,credentials_quarantined_at,credentials_quarantine_reason)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const blob = (b: number[]) => new Uint8Array(b);
  insert.run(
    'a',
    'acme/web',
    '["push"]',
    'slack',
    '',
    1,
    'org-a',
    'Alerts',
    'hooks.slack.com',
    '2026-01-01',
    '{"v":1,"branch":{"allow":["main"]}}',
    null,
    blob([1, 2]),
    blob([3, 4]),
    1,
    blob([5, 6]),
    null,
    null,
    null,
  );
  insert.run(
    'b',
    'acme/api',
    '["issues.opened"]',
    'teams',
    'x',
    0,
    'org-b',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    '2026-02-02',
    'row_defect',
  );
  insert.run(
    'c',
    'source:src-a',
    '[]',
    'lark',
    '',
    1,
    'org-a',
    'Deploys to Lark',
    'open.larksuite.com',
    '2026-03-03',
    null,
    'src-a',
    blob([7]),
    blob([8]),
    2,
    blob([9]),
    blob([10, 11]),
    null,
    null,
  );
}

describe('migration 0018', () => {
  it('changes only the destination CHECK: columns, indexes, triggers and rows are identical', () => {
    const { raw } = createFakeD1({ before: '0018' });
    seed(raw);
    const before = snapshot(raw);
    const beforeColumns = columns(raw);
    const beforeRows = raw.prepare('SELECT * FROM integrations ORDER BY id').all();
    expect(beforeRows).toHaveLength(3);

    applyMigration(raw, '0018_extended_destinations.sql');
    const after = snapshot(raw);

    // The schema objects are the same set, with the same definitions...
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [key, sql] of before) {
      const expected = key === 'table:integrations' ? sql.replace(squash(OLD_KINDS), squash(NEW_KINDS)) : sql;
      expect(after.get(key), key).toBe(expected);
    }
    // ...the table really did change, and by exactly that substitution.
    expect(before.get('table:integrations')).toContain(squash(OLD_KINDS));
    expect(after.get('table:integrations')).toContain(squash(NEW_KINDS));
    // Including the objects a table rebuild silently drops: both generations of triggers.
    expect([...after.keys()]).toEqual(
      expect.arrayContaining([
        'trigger:integrations_org_required_insert',
        'trigger:integrations_org_immutable',
        'trigger:integrations_source_same_org',
        'trigger:integrations_source_immutable',
        'trigger:sources_delete_integrations',
        'index:integrations_source',
        'index:integrations_repo',
        'index:integrations_org_idx',
        'index:integrations_kek_version',
        'index:integrations_org_created',
      ]),
    );

    expect(columns(raw)).toEqual(beforeColumns);
    expect(raw.prepare('SELECT * FROM integrations ORDER BY id').all()).toEqual(beforeRows);
  });

  it('leaves every integrations trigger and index in place after the whole chain (0019 recreates some)', () => {
    const { raw } = createFakeD1();
    const names = (type: string) =>
      (
        raw
          .prepare('SELECT name FROM sqlite_master WHERE type=? AND (tbl_name=? OR name=?) ORDER BY name')
          .all(type, 'integrations', 'sources_delete_integrations') as { name: string }[]
      ).map((r) => r.name);
    expect(names('trigger')).toEqual([
      'integrations_org_immutable',
      'integrations_org_required_insert',
      'integrations_source_immutable',
      'integrations_source_same_org',
      'sources_delete_integrations',
    ]);
    expect(names('index')).toEqual(
      expect.arrayContaining([
        'integrations_kek_version',
        'integrations_org_created',
        'integrations_org_idx',
        'integrations_repo',
        'integrations_source',
      ]),
    );
  });

  it('keeps the rest of the database intact', () => {
    const { raw } = createFakeD1({ before: '0018' });
    seed(raw);
    raw.exec(
      "INSERT INTO deliveries(id,integration_id,organization_id,state) VALUES('d','a','org-a','sent')",
    );
    const objects = () =>
      raw
        .prepare(
          "SELECT type,name,sql FROM sqlite_master WHERE sql NOT LIKE '%integrations%' ORDER BY type,name",
        )
        .all();
    const others = objects();
    applyMigration(raw, '0018_extended_destinations.sql');
    expect(objects()).toEqual(others);
    expect(raw.prepare("SELECT id,state FROM deliveries WHERE id='d'").get()).toEqual({
      id: 'd',
      state: 'sent',
    });
  });

  it('accepts discord and generic_webhook, and still rejects any other destination', () => {
    const { raw } = createFakeD1();
    const insert = (id: string, destination: string) =>
      raw
        .prepare(
          'INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id) VALUES(?,?,?,?,?,?)',
        )
        .run(id, 'a/b', '[]', destination, '', 'org-a');
    for (const kind of ['lark', 'slack', 'teams', 'discord', 'generic_webhook']) insert(kind, kind);
    for (const kind of ['telegram', 'email', 'DISCORD', ''])
      expect(() => insert('x' + kind, kind)).toThrow(/CHECK/);
  });

  it('still enforces every trigger and constraint added before it', () => {
    const { raw } = createFakeD1();
    seed(raw);
    const insert = (id: string, org: string | null, source: string | null = null) =>
      raw
        .prepare(
          'INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id,source_id) VALUES(?,?,?,?,?,?,?)',
        )
        .run(id, 'a/b', '[]', 'discord', '', org, source);
    // 0008: a workspace is required, and cannot change.
    expect(() => insert('x', null)).toThrow(/organization_id is required/);
    expect(() => raw.prepare("UPDATE integrations SET organization_id='org-b' WHERE id='a'").run()).toThrow(
      /cannot change/,
    );
    // 0017: a source must be in the same workspace, is set once, and cascades its integrations.
    expect(() => insert('y', 'org-b', 'src-a')).toThrow(/same organization/);
    expect(() => raw.prepare("UPDATE integrations SET source_id=NULL WHERE id='c'").run()).toThrow(
      /cannot change/,
    );
    raw.exec("DELETE FROM sources WHERE id='src-a'");
    expect(raw.prepare("SELECT COUNT(*) AS n FROM integrations WHERE id='c'").get()).toEqual({ n: 0 });
    // 0015: filters stay valid, bounded JSON.
    const setFilters = (value: string) =>
      raw.prepare("UPDATE integrations SET filters_json=? WHERE id='a'").run(value);
    expect(() => setFilters('{"v":1}')).not.toThrow();
    expect(() => setFilters('{not json')).toThrow(/CHECK/);
    expect(() => setFilters(JSON.stringify({ pad: 'x'.repeat(9000) }))).toThrow(/CHECK/);
  });
});
