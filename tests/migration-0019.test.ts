import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigration, createFakeD1 } from './support/d1';

/**
 * Migration 0019 rebuilds `sources` to widen CHECK(kind) and adds two columns. The schema-diff
 * test compares the table, its indexes and every trigger in the database before and after, so
 * a column, index or trigger lost by the rebuild fails here.
 */
interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

const columns = (raw: DatabaseSync, table: string) =>
  raw.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnInfo[];
const names = (raw: DatabaseSync, type: 'index' | 'trigger', table?: string) =>
  (
    raw
      .prepare(
        `SELECT name FROM sqlite_master WHERE type=? ${table ? 'AND tbl_name=?' : ''} AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all(...(table ? [type, table] : [type])) as { name: string }[]
  ).map((r) => r.name);
const sql = (raw: DatabaseSync, name: string) =>
  (raw.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name) as { sql: string }).sql;

function seed(raw: DatabaseSync) {
  raw.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES('o','o','o',1)").run();
  raw.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES('p','p','p',1)").run();
  raw
    .prepare(
      `INSERT INTO sources(id,organization_id,kind,name,endpoint_id,secret_envelope,key_salt,dek_wrapped,kek_version,
         enabled,created_by,reused_id_rejections,last_reuse_rejected_at,last_received_at,secret_rotated_at)
       VALUES('s1','o','generic','CI',?,x'0a0b',x'0c',x'0d',3,0,'alice',4,'2026-01-01 00:00:00','2026-02-02 00:00:00','2026-03-03 00:00:00')`,
    )
    .run('e'.repeat(24));
  raw
    .prepare(
      `INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id,name,source_id)
       VALUES('i1','source:s1','[]','slack','x','o','to slack','s1')`,
    )
    .run();
}

describe('migration 0019', () => {
  it('keeps every source column, adds auth_mode and livemode, and preserves the rows', () => {
    const { raw } = createFakeD1({ before: '0019' });
    const before = columns(raw, 'sources');
    seed(raw);
    const rowBefore = raw.prepare('SELECT * FROM sources').get() as Record<string, unknown>;
    applyMigration(raw, '0019_provider_sources.sql');

    const after = columns(raw, 'sources');
    expect(after.map((c) => c.name)).toEqual([...before.map((c) => c.name), 'auth_mode', 'livemode']);
    // Existing columns keep type, nullability, default and primary key.
    for (const col of before) expect(after.find((c) => c.name === col.name)).toEqual(col);
    expect(raw.prepare('SELECT * FROM sources').get()).toEqual({
      ...rowBefore,
      auth_mode: null,
      livemode: null,
    });
    // The integration still points at the source.
    expect(raw.prepare('SELECT source_id FROM integrations').get()).toEqual({ source_id: 's1' });
  });

  it('keeps every index and trigger of sources and integrations (schema diff)', () => {
    const { raw } = createFakeD1({ before: '0019' });
    const indexes = {
      sources: names(raw, 'index', 'sources'),
      integrations: names(raw, 'index', 'integrations'),
    };
    const triggers = names(raw, 'trigger');
    const triggerSql = Object.fromEntries(triggers.map((t) => [t, sql(raw, t)]));
    applyMigration(raw, '0019_provider_sources.sql');

    expect(names(raw, 'index', 'sources')).toEqual(indexes.sources);
    expect(names(raw, 'index', 'integrations')).toEqual(indexes.integrations);
    expect(names(raw, 'trigger')).toEqual(triggers);
    // Trigger bodies are unchanged (only whitespace may differ across the DROP/CREATE).
    const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
    for (const t of triggers) expect(squash(sql(raw, t)), t).toBe(squash(triggerSql[t] ?? ''));
    // The old table and the temporary one are gone.
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name IN ('sources_v2')").all()).toEqual([]);
  });

  it('widens the kind CHECK to gitlab and stripe only, and constrains the new columns', () => {
    const { raw } = createFakeD1();
    raw.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES('o','o','o',1)").run();
    let n = 0;
    const insert = (kind: string, extra = 'NULL,NULL') =>
      raw
        .prepare(
          `INSERT INTO sources(id,organization_id,kind,name,endpoint_id,secret_envelope,key_salt,dek_wrapped,kek_version,auth_mode,livemode)
           VALUES(?,'o',?,'n',?,x'00',x'00',x'00',1,${extra})`,
        )
        .run(`s${++n}`, kind, `${String(n).padStart(24, 'a')}`);
    for (const kind of ['generic', 'gitlab', 'stripe']) insert(kind);
    expect(() => insert('sentry')).toThrow();
    expect(() => insert('github')).toThrow();
    expect(() => insert('gitlab', "'signing_token',NULL")).not.toThrow();
    expect(() => insert('gitlab', "'bogus',NULL")).toThrow();
    expect(() => insert('stripe', 'NULL,1')).not.toThrow();
    expect(() => insert('stripe', 'NULL,2')).toThrow();
  });

  it('the rebuilt triggers still enforce the tenant contract', () => {
    const { raw } = createFakeD1({ before: '0019' });
    seed(raw);
    applyMigration(raw, '0019_provider_sources.sql');
    // organization_id required, immutable.
    expect(() =>
      raw
        .prepare(
          `INSERT INTO sources(id,organization_id,kind,name,endpoint_id,secret_envelope,key_salt,dek_wrapped,kek_version)
           VALUES('x','','gitlab','n',?,x'00',x'00',x'00',1)`,
        )
        .run('z'.repeat(24)),
    ).toThrow(/organization_id is required/);
    expect(() => raw.prepare("UPDATE sources SET organization_id='p' WHERE id='s1'").run()).toThrow(
      /cannot change/,
    );
    // An integration cannot reference another organization's source, nor be re-pointed.
    expect(() =>
      raw
        .prepare(
          `INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id,source_id)
           VALUES('i2','source:s1','[]','slack','x','p','s1')`,
        )
        .run(),
    ).toThrow(/same organization/);
    expect(() => raw.prepare("UPDATE integrations SET source_id=NULL WHERE id='i1'").run()).toThrow(
      /cannot change/,
    );
    // Deleting a source (any path) removes its integrations; deleting the organization cascades.
    raw.prepare("DELETE FROM sources WHERE id='s1'").run();
    expect(raw.prepare('SELECT COUNT(*) AS n FROM integrations').get()).toEqual({ n: 0 });
    seed2(raw);
    raw.prepare("DELETE FROM organization WHERE id='o'").run();
    expect(raw.prepare('SELECT COUNT(*) AS n FROM sources').get()).toEqual({ n: 0 });
  });
});

function seed2(raw: DatabaseSync) {
  raw
    .prepare(
      `INSERT INTO sources(id,organization_id,kind,name,endpoint_id,secret_envelope,key_salt,dek_wrapped,kek_version)
       VALUES('s9','o','stripe','n',?,x'00',x'00',x'00',1)`,
    )
    .run('q'.repeat(24));
}
