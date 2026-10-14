import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyMigration, createFakeD1, migrationFiles, seedOrganization } from './support/d1';
import { seedLegacy } from './support/legacy-0026';
import { must } from './support/must';

/**
 * Migration 0026 is the CONTRACT step of the tenant migration (F25): it rebuilds six tables to
 * add NOT NULL + a foreign key on organization_id. A rebuild is only safe if it changes nothing
 * else, so the schema is diffed around it (as for 0018), and the data path (backfill,
 * quarantine, row-count verification) is exercised against rows shaped like legacy data.
 */
const FILE = '0026_tenant_contract.sql';
const TABLES = [
  'integrations',
  'deliveries',
  'notification_outbox',
  'held_events',
  'routing_decisions',
  'noise_open_failures',
] as const;
const FK_ORG = 'REFERENCES organization(id) ON DELETE CASCADE';

const squash = (sql: string | null): string =>
  (sql ?? '')
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, '')
    .replace(/"/g, '');

interface Col {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

const columns = (raw: DatabaseSync, table: string): Col[] =>
  raw.prepare(`PRAGMA table_info("${table}")`).all() as unknown as Col[];

/** Every CHECK(...) clause in a CREATE TABLE, balanced-paren extracted, whitespace-insensitive. */
function checks(sql: string): string[] {
  const out: string[] = [];
  const re = /CHECK\s*\(/gi;
  for (let m = re.exec(sql); m; m = re.exec(sql)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < sql.length && depth > 0) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') depth--;
      i++;
    }
    out.push(squash(sql.slice(start, i - 1)));
  }
  return out.sort();
}

function schemaObjects(raw: DatabaseSync): Map<string, string> {
  const rows = raw
    .prepare(
      `SELECT type,name,tbl_name,sql FROM sqlite_master
       WHERE sql IS NOT NULL AND type IN ('index','trigger')
         AND (tbl_name IN (${TABLES.map((t) => `'${t}'`).join(',')}) OR sql LIKE '%integrations%')`,
    )
    .all() as { type: string; name: string; sql: string }[];
  return new Map(rows.map((r) => [`${r.type}:${r.name}`, squash(r.sql)]));
}

function tableSql(raw: DatabaseSync, table: string): string {
  return (
    raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string }
  ).sql;
}

const count = (raw: DatabaseSync, table: string): number =>
  (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('migration 0026: schema', () => {
  it('changes only the constraint on organization_id: columns, checks, indexes and triggers are identical', () => {
    const { raw } = createFakeD1({ before: '0026' });
    const beforeCols = Object.fromEntries(TABLES.map((t) => [t, columns(raw, t)]));
    const beforeChecks = Object.fromEntries(TABLES.map((t) => [t, checks(tableSql(raw, t))]));
    const beforeObjects = schemaObjects(raw);
    applyMigration(raw, FILE);

    for (const t of TABLES) {
      const after = columns(raw, t);
      // Same columns, same order, same types, defaults and primary keys...
      expect(
        after.map(({ notnull: _n, ...rest }) => rest),
        t,
      ).toEqual(must(beforeCols[t]).map(({ notnull: _n, ...rest }) => rest));
      // ...and the only nullability change is organization_id becoming NOT NULL.
      const changed = after
        .filter((c, i) => c.notnull !== must(must(beforeCols[t])[i]).notnull)
        .map((c) => c.name);
      const wasNullable = must(must(beforeCols[t]).find((c) => c.name === 'organization_id')).notnull === 0;
      expect(changed, t).toEqual(wasNullable ? ['organization_id'] : []);
      expect(must(after.find((c) => c.name === 'organization_id')).notnull, t).toBe(1);
      expect(checks(tableSql(raw, t)), t).toEqual(beforeChecks[t]);
      // The foreign key is exactly one: organization_id -> organization(id) ON DELETE CASCADE.
      const fks = raw.prepare(`PRAGMA foreign_key_list("${t}")`).all() as {
        from: string;
        table: string;
        to: string;
        on_delete: string;
      }[];
      expect(
        fks.map((f) => [f.from, f.table, f.to, f.on_delete]),
        t,
      ).toEqual([['organization_id', 'organization', 'id', 'CASCADE']]);
      expect(squash(tableSql(raw, t)), t).toContain(squash(`organization_id TEXT NOT NULL ${FK_ORG}`));
    }

    // Every index and trigger that existed still exists, byte for byte (modulo whitespace).
    const afterObjects = schemaObjects(raw);
    expect([...afterObjects.keys()].sort()).toEqual([...beforeObjects.keys()].sort());
    for (const [key, sql] of beforeObjects) expect(afterObjects.get(key), key).toBe(sql);
    expect([...afterObjects.keys()]).toEqual(
      expect.arrayContaining([
        'trigger:integrations_org_required_insert',
        'trigger:integrations_org_immutable',
        'trigger:integrations_source_same_org',
        'trigger:integrations_source_immutable',
        'trigger:sources_delete_integrations',
        'index:held_events_released_in',
        'index:deliveries_org_updated',
      ]),
    );
  });

  it('enforces NOT NULL and the foreign key on every contracted table, and cascades on delete', () => {
    const { raw } = createFakeD1();
    seedOrganization(raw, 'org-a');
    seedOrganization(raw, 'org-b');
    const insert = (org: string | null) => [
      () =>
        raw
          .prepare(
            "INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id) VALUES('i','r','[]','slack','',?)",
          )
          .run(org),
      () =>
        raw
          .prepare("INSERT INTO deliveries(id,integration_id,state,organization_id) VALUES('d','i','sent',?)")
          .run(org),
      () =>
        raw
          .prepare("INSERT INTO notification_outbox(id,payload_json,organization_id) VALUES('o','{}',?)")
          .run(org),
      () =>
        raw
          .prepare(
            `INSERT INTO held_events(id,organization_id,integration_id,hold_reason,group_key,release_at,held_at,
               event_type,title,url,repo,actor,status,summary)
             VALUES('h',?,'i','digest','${'k'.repeat(32)}',1,1,'push','t','','','','info','')`,
          )
          .run(org),
      () =>
        raw
          .prepare(
            "INSERT INTO routing_decisions(id,organization_id,integration_id,event_type,outcome,reason,decided_at) VALUES('r',?,'i','push','delivered','ok',1)",
          )
          .run(org),
      () =>
        raw
          .prepare(
            `INSERT INTO noise_open_failures(organization_id,integration_id,key_hash,opened_at) VALUES(?,'i','${'k'.repeat(32)}',1)`,
          )
          .run(org),
    ];
    // Missing and unknown tenants are refused on all six tables.
    for (const write of insert(null)) expect(write).toThrow(/NOT NULL|organization_id is required/);
    for (const write of insert('ghost')) expect(write).toThrow(/FOREIGN KEY/);
    // A real tenant is accepted everywhere...
    for (const write of insert('org-a')) write();
    for (const t of TABLES) expect(count(raw, t), t).toBe(1);
    // ...and deleting the organization removes every row (the last-admin trigger is not in play:
    // this organization has no members), leaving the other tenant alone.
    raw.exec(
      "INSERT INTO sources(id,organization_id,kind,name,endpoint_id,secret_envelope,key_salt,dek_wrapped,kek_version) VALUES('s','org-b','generic','n','ep-bbbbbbbbbbbbbbbbbbbbbbbb',x'00',x'00',x'00',1)",
    );
    raw.prepare("DELETE FROM organization WHERE id='org-a'").run();
    for (const t of TABLES) expect(count(raw, t), `${t} after cascade`).toBe(0);
    expect(count(raw, 'sources')).toBe(1);
    expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('migration 0026: backfill, quarantine and verification', () => {
  const migrated = () => {
    const { raw } = createFakeD1({ before: '0026' });
    seedLegacy(raw);
    const before = Object.fromEntries(TABLES.map((t) => [t, count(raw, t)]));
    const keptRows = raw.prepare("SELECT * FROM deliveries WHERE id='d-set'").all();
    applyMigration(raw, FILE);
    return { raw, before, keptRows };
  };

  const orgOf = (raw: DatabaseSync, table: string, id: string) =>
    (raw.prepare(`SELECT organization_id AS o FROM ${table} WHERE id=?`).get(id) as { o: string } | undefined)
      ?.o;

  it('assigns a tenant only when it is derivable from our own rows', () => {
    const { raw } = migrated();
    expect(orgOf(raw, 'integrations', 'i-ok')).toBe('org-a');
    expect(orgOf(raw, 'integrations', 'i-b')).toBe('org-b');
    // From its source, which is tenant-owned and NOT NULL.
    expect(orgOf(raw, 'integrations', 'i-src')).toBe('org-a');
    // From the integration it was routed to, including one that was itself just backfilled.
    expect(orgOf(raw, 'deliveries', 'd-derive')).toBe('org-a');
    expect(orgOf(raw, 'deliveries', 'd-via-source')).toBe('org-a');
    expect(orgOf(raw, 'deliveries', 'd-set')).toBe('org-b');
    // From the delivery with the same id, else the integration in the payload.
    expect(orgOf(raw, 'notification_outbox', 'd-derive')).toBe('org-a');
    expect(orgOf(raw, 'notification_outbox', 'o-payload')).toBe('org-a');
    expect(orgOf(raw, 'notification_outbox', 'o-set')).toBe('org-b');
  });

  it('quarantines every row whose tenant cannot be derived, and never guesses one', () => {
    const { raw } = migrated();
    const rows = raw
      .prepare('SELECT source_table,row_id,reason FROM legacy_orphaned_rows ORDER BY source_table,row_id')
      .all();
    expect(rows).toEqual([
      { source_table: 'deliveries', row_id: 'd-dangling', reason: 'organization_not_found' },
      { source_table: 'deliveries', row_id: 'd-no-integration', reason: 'organization_missing' },
      { source_table: 'deliveries', row_id: 'd-orphan', reason: 'organization_missing' },
      { source_table: 'held_events', row_id: 'h-dangling', reason: 'organization_not_found' },
      { source_table: 'integrations', row_id: 'i-case', reason: 'organization_not_found' },
      { source_table: 'integrations', row_id: 'i-dangling', reason: 'organization_not_found' },
      { source_table: 'integrations', row_id: 'i-empty', reason: 'organization_missing' },
      { source_table: 'integrations', row_id: 'i-long', reason: 'organization_missing' },
      { source_table: 'integrations', row_id: 'i-orphan', reason: 'organization_missing' },
      { source_table: 'noise_open_failures', row_id: expect.any(String), reason: 'organization_not_found' },
      { source_table: 'notification_outbox', row_id: 'o-badjson', reason: 'organization_missing' },
      { source_table: 'notification_outbox', row_id: 'o-orphan', reason: 'organization_missing' },
      { source_table: 'routing_decisions', row_id: 'r-dangling', reason: 'organization_not_found' },
    ]);
    // None of them stayed behind in a live table.
    for (const id of ['i-orphan', 'i-dangling', 'i-empty'])
      expect(orgOf(raw, 'integrations', id), id).toBeUndefined();
    expect(orgOf(raw, 'deliveries', 'd-orphan')).toBeUndefined();
  });

  it('keeps no credential, payload or event content in the quarantine', () => {
    const { raw } = migrated();
    const text = (
      raw.prepare('SELECT group_concat(detail_json) AS t FROM legacy_orphaned_rows').get() as {
        t: string;
      }
    ).t;
    expect(text).not.toContain('ciphertext-marker');
    expect(text).not.toContain('event-body-marker');
    expect(text).not.toMatch(/payload|ciphertext|envelope|dek_wrapped|key_salt/);
    // The quarantine itself is not a tenant table: no organization column, nothing reads it.
    expect(columns(raw, 'legacy_orphaned_rows').map((c) => c.name)).not.toContain('organization_id');
  });

  it('accounts for every row: kept plus quarantined equals the original count, per table', () => {
    const { raw, before } = migrated();
    for (const t of TABLES) {
      const quarantined = (
        raw.prepare('SELECT COUNT(*) AS n FROM legacy_orphaned_rows WHERE source_table=?').get(t) as {
          n: number;
        }
      ).n;
      expect(count(raw, t) + quarantined, t).toBe(before[t]);
    }
    expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    // The scratch tables are gone.
    expect(
      raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE name LIKE '\\_contract%' ESCAPE '\\' OR name LIKE '%_v4'",
        )
        .all(),
    ).toEqual([]);
  });

  it('leaves the 0025 ledger tables alone and keeps the 0025 delivery columns', () => {
    const { raw } = migrated();
    // event_dedup, delivery_attempts and destination_health were created NOT NULL with a foreign key: no rebuild.
    expect(count(raw, 'event_dedup')).toBe(1);
    expect(count(raw, 'delivery_attempts')).toBe(1); // points at a quarantined delivery; retention removes it as an orphan
    expect(count(raw, 'destination_health')).toBe(1);
    expect(
      raw
        .prepare(
          "SELECT state,duplicate_of,suppressed_reason,possible_duplicate,provider_message_id FROM deliveries WHERE id='d-set'",
        )
        .get(),
    ).toEqual({
      state: 'suppressed',
      duplicate_of: 'd-derive',
      suppressed_reason: 'duplicate',
      possible_duplicate: 1,
      provider_message_id: 'pm-1',
    });
  });

  it('leaves rows that already had a valid tenant byte-identical', () => {
    const { raw, keptRows } = migrated();
    expect(raw.prepare("SELECT * FROM deliveries WHERE id='d-set'").all()).toEqual(keptRows);
  });

  describe('when the file fails part way', () => {
    const migrationSql = (): string =>
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', FILE), 'utf8');
    const VERIFY = '-- --- 4. verify';
    const SWAP = '-- --- 5. swap';
    const lost = `DELETE FROM deliveries_v4 WHERE id = 'd-set';\n`;
    const late = `INSERT INTO deliveries(id,integration_id,state,organization_id,created_at) VALUES('d-late','i-ok','sent','org-a','2026-02-01');\n`;
    const original = (raw: DatabaseSync) => ({
      nullable: must(columns(raw, 'deliveries').find((c) => c.name === 'organization_id')).notnull === 0,
      // organization_id is excluded: the backfill (step 1) legitimately fills it before any failure.
      rows: withoutOrg(raw.prepare('SELECT * FROM deliveries ORDER BY rowid').all()),
    });
    const withoutOrg = (rows: Record<string, unknown>[]): unknown[] =>
      rows.map(({ organization_id: _o, ...rest }) => rest);
    const leftovers = (raw: DatabaseSync): string[] =>
      (
        raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%\\_v4' ESCAPE '\\' OR name LIKE '%\\_old' ESCAPE '\\' OR name LIKE '\\_guard%' ESCAPE '\\' OR name LIKE '\\_contract%' ESCAPE '\\') ORDER BY name",
          )
          .all() as { name: string }[]
      ).map((r) => r.name);

    it('aborts inside a transaction and leaves the old schema untouched', () => {
      const { raw } = createFakeD1({ before: '0026' });
      seedLegacy(raw);
      const before = original(raw);
      const sql = migrationSql();
      expect(sql).toContain(VERIFY);
      raw.exec('BEGIN');
      expect(() => raw.exec(sql.replace(VERIFY, `${lost}${VERIFY}`))).toThrow(/row_counts_must_match/);
      raw.exec('ROLLBACK');
      expect(original(raw)).toEqual(before);
      expect(
        raw
          .prepare("SELECT name FROM sqlite_master WHERE name IN ('legacy_orphaned_rows','deliveries_v4')")
          .all(),
      ).toEqual([]);
    });

    it('with no wrapper transaction: stops before anything is renamed, then a plain re-run completes cleanly', () => {
      const { raw } = createFakeD1({ before: '0026' });
      seedLegacy(raw);
      const before = original(raw);
      const sql = migrationSql();
      // node:sqlite stops at the first error, like a runner that aborts the file.
      expect(() => raw.exec(sql.replace(VERIFY, `${lost}${VERIFY}`))).toThrow(/row_counts_must_match/);
      // Originals intact and still the live tables; only scratch objects are left behind.
      expect(original(raw)).toEqual(before);
      expect(leftovers(raw)).toContain('deliveries_v4');
      // Re-running the unmodified file cleans the scratch tables and finishes.
      raw.exec(sql);
      expect(leftovers(raw)).toEqual([]);
      expect(must(columns(raw, 'deliveries').find((c) => c.name === 'organization_id')).notnull).toBe(1);
      expect(count(raw, 'deliveries')).toBe(before.rows.length - 3);
      expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    });

    it('a row written between the copy and the swap is never lost: the guard refuses the DROP', () => {
      const { raw } = createFakeD1({ before: '0026' });
      seedLegacy(raw);
      const sql = migrationSql();
      expect(sql).toContain(SWAP);
      // The verify has passed; a live writer then adds one row to the ORIGINAL table.
      expect(() => raw.exec(sql.replace(SWAP, `${late}${SWAP}`))).toThrow(/FOREIGN KEY constraint failed/);
      const rows = raw.prepare("SELECT id FROM deliveries_old WHERE id='d-late'").all();
      expect(rows).toHaveLength(1);
      expect(count(raw, 'deliveries_old')).toBe(8);
    });

    /** A runner that, like the sqlite3 shell, carries on after an error. */
    function runCarryingOn(raw: DatabaseSync, sql: string): string[] {
      const errors: string[] = [];
      const text = sql.replace(/--[^\n]*/g, '');
      const statements: string[] = [];
      let current = '';
      let inTrigger = false;
      for (const line of text.split('\n')) {
        current += `${line}\n`;
        if (/^\s*CREATE TRIGGER\b/i.test(line)) inTrigger = true;
        if (inTrigger ? /^\s*END;\s*$/i.test(line) : /;\s*$/.test(line)) {
          statements.push(current.trim());
          current = '';
          inTrigger = false;
        }
      }
      for (const statement of statements.filter((x) => x.length > 0)) {
        try {
          raw.exec(statement);
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e));
        }
      }
      return errors;
    }

    it('a runner that carries on after a failed verify still cannot destroy the original', () => {
      const { raw } = createFakeD1({ before: '0026' });
      seedLegacy(raw);
      const before = original(raw);
      const errors = runCarryingOn(raw, migrationSql().replace(VERIFY, `${lost}${VERIFY}`));
      expect(errors.some((e) => /row_counts_must_match/.test(e))).toBe(true);
      expect(errors.some((e) => /FOREIGN KEY constraint failed/.test(e))).toBe(true);
      // Every original row survives, byte for byte, in the table the DROP was refused for.
      expect(
        withoutOrg(
          raw.prepare('SELECT * FROM deliveries_old ORDER BY rowid').all() as Record<string, unknown>[],
        ),
      ).toEqual(before.rows);
      // Tables whose copy was sound completed normally.
      expect(must(columns(raw, 'held_events').find((c) => c.name === 'organization_id')).notnull).toBe(1);
      expect(leftovers(raw)).toEqual(['deliveries_old']);
    });

    it('a runner that carries on after a late writer also keeps every row', () => {
      const { raw } = createFakeD1({ before: '0026' });
      seedLegacy(raw);
      const errors = runCarryingOn(raw, migrationSql().replace(SWAP, `${late}${SWAP}`));
      expect(errors.some((e) => /FOREIGN KEY constraint failed/.test(e))).toBe(true);
      expect(raw.prepare("SELECT id FROM deliveries_old WHERE id='d-late'").all()).toHaveLength(1);
    });

    it('is safe to apply twice', () => {
      const { raw } = createFakeD1({ before: '0026' });
      seedLegacy(raw);
      applyMigration(raw, FILE);
      const once = Object.fromEntries(
        TABLES.map((t) => [t, raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]),
      );
      const quarantine = raw
        .prepare('SELECT source_table,row_id,reason FROM legacy_orphaned_rows ORDER BY id')
        .all();
      applyMigration(raw, FILE);
      expect(
        Object.fromEntries(TABLES.map((t) => [t, raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()])),
      ).toEqual(once);
      expect(
        raw.prepare('SELECT source_table,row_id,reason FROM legacy_orphaned_rows ORDER BY id').all(),
      ).toEqual(quarantine);
      expect(leftovers(raw)).toEqual([]);
    });
  });

  it('copies in rowid order, so the recency the API reads from rowid survives', () => {
    const { raw } = createFakeD1({ before: '0026' });
    seedOrganization(raw, 'org-a');
    const insert = raw.prepare(
      "INSERT INTO deliveries(id,integration_id,state,organization_id) VALUES(?,'i','sent','org-a')",
    );
    for (const id of ['z', 'a', 'm', 'b']) insert.run(id);
    applyMigration(raw, FILE);
    expect(
      (raw.prepare('SELECT id FROM deliveries ORDER BY rowid').all() as { id: string }[]).map((r) => r.id),
    ).toEqual(['z', 'a', 'm', 'b']);
  });

  it('records long free text and odd unicode in the quarantine, cut to 200 characters', () => {
    const { raw } = createFakeD1({ before: '0026' });
    seedLegacy(raw);
    applyMigration(raw, FILE);
    for (const id of ['i-long']) {
      const row = raw
        .prepare(
          "SELECT detail_json FROM legacy_orphaned_rows WHERE source_table='integrations' AND row_id=?",
        )
        .get(id) as { detail_json: string };
      const detail = JSON.parse(row.detail_json) as { repo: string; name: string };
      expect(Array.from(detail.repo).length).toBe(200);
      expect(Array.from(detail.name).length).toBeLessThanOrEqual(200);
      expect(detail.name.startsWith('👩')).toBe(true);
    }
  });

  it('is a no-op on data when there are no legacy rows', () => {
    const { raw } = createFakeD1({ before: '0026' });
    seedOrganization(raw, 'org-a');
    raw
      .prepare(
        "INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id) VALUES('i','r','[]','slack','','org-a')",
      )
      .run();
    applyMigration(raw, FILE);
    expect(count(raw, 'integrations')).toBe(1);
    expect(count(raw, 'legacy_orphaned_rows')).toBe(0);
  });
});

describe('migration 0026 on databases first built at an older version (L5)', () => {
  it.each(['0012', '0015', '0017', '0020', '0021'])('upgrades legacy data written at 0%s', (version) => {
    const { raw } = createFakeD1({ before: version });
    raw.exec('DROP TRIGGER IF EXISTS integrations_org_required_insert');
    for (const org of ['org-a', 'org-b']) seedOrganization(raw, org);
    const integ = raw.prepare(
      'INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id) VALUES(?,?,?,?,?,?)',
    );
    integ.run('i-a', 'acme/a', '[]', 'slack', 'x', 'org-a');
    integ.run('i-null', 'acme/n', '[]', 'slack', 'x', null);
    const deliv = raw.prepare(
      "INSERT INTO deliveries(id,integration_id,state,organization_id) VALUES(?,?,'sent',?)",
    );
    deliv.run('d-a', 'i-a', 'org-a');
    deliv.run('d-derive', 'i-a', null);
    deliv.run('d-orphan', 'i-null', null);
    const out = raw.prepare(
      "INSERT INTO notification_outbox(id,payload_json,state,organization_id) VALUES(?,?,'dispatched',?)",
    );
    out.run('o-a', '{}', 'org-b');
    out.run('o-orphan', 'not json', null);
    for (const file of migrationFiles().filter((f) => f >= version)) applyMigration(raw, file);

    const quarantined = raw
      .prepare('SELECT source_table,row_id FROM legacy_orphaned_rows ORDER BY source_table,row_id')
      .all();
    expect(quarantined).toEqual([
      { source_table: 'deliveries', row_id: 'd-orphan' },
      { source_table: 'integrations', row_id: 'i-null' },
      { source_table: 'notification_outbox', row_id: 'o-orphan' },
    ]);
    expect(count(raw, 'integrations')).toBe(1);
    expect(count(raw, 'deliveries')).toBe(2);
    expect(
      (raw.prepare("SELECT organization_id AS o FROM deliveries WHERE id='d-derive'").get() as { o: string })
        .o,
    ).toBe('org-a');
    for (const t of TABLES) {
      expect(must(columns(raw, t).find((c) => c.name === 'organization_id')).notnull, t).toBe(1);
    }
    expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
