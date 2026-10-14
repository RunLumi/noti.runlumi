import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigration, migrationFiles } from './d1';
import { seedLegacy } from './legacy-0026';

/**
 * A harness for the failure matrix of migration 0026 (docs/adr/0021): a seeded pre-0026 database
 * that is cloned per scenario, three ways of running the file that model what D1 might do, and
 * the checks that decide whether anything was lost.
 *
 *   transaction  one transaction, rolled back on the first error
 *   abort        no wrapper, stops at the first error (what node:sqlite `exec` does)
 *   continue     statement by statement, carrying on after an error (the sqlite3 shell's default)
 *
 * Every runner is node:sqlite, whose ALTER TABLE behaviour is the library default
 * (legacy_alter_table off), the same as D1's SQLite.
 */
export const MIGRATION = '0026_tenant_contract.sql';
export const TABLES = [
  'integrations',
  'deliveries',
  'notification_outbox',
  'held_events',
  'routing_decisions',
  'noise_open_failures',
] as const;
export type Mode = 'transaction' | 'abort' | 'continue';
export const MODES: readonly Mode[] = ['transaction', 'abort', 'continue'];

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const migrationSql = (): string => readFileSync(join(root, 'migrations', MIGRATION), 'utf8');

/** Statement boundaries: a line ending in `;`, or for a trigger the line that is `END;`. Comments are dropped. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inTrigger = false;
  for (const line of sql.replace(/--[^\n]*/g, '').split('\n')) {
    current += `${line}\n`;
    if (/^\s*CREATE TRIGGER\b/i.test(line)) inTrigger = true;
    if (inTrigger ? /^\s*END;\s*$/i.test(line) : /;\s*$/.test(line)) {
      out.push(current.trim());
      current = '';
      inTrigger = false;
    }
  }
  return out.filter((s) => s.length > 0);
}

export interface Pragmas {
  /** Default on, like D1. `false` turns enforcement off. */
  foreignKeys?: boolean;
  deferForeignKeys?: boolean;
  legacyAlterTable?: boolean;
}

let dir: string | undefined;
let baseFile: string | undefined;
let counter = 0;

/** The seeded pre-0026 database file, built once per test file. */
function base(): string {
  if (baseFile) return baseFile;
  dir = mkdtempSync(join(tmpdir(), 'noti-0026-'));
  baseFile = join(dir, 'base.db');
  const raw = new DatabaseSync(baseFile);
  raw.exec('PRAGMA foreign_keys=ON');
  for (const file of migrationFiles()) {
    if (file >= '0026') break;
    applyMigration(raw, file);
  }
  seedLegacy(raw);
  raw.close();
  return baseFile;
}

export function dispose(): void {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  baseFile = undefined;
}

/** A fresh copy of the seeded database, with the requested pragmas. */
export function cloneBase(pragmas: Pragmas = {}): DatabaseSync {
  const source = base();
  const target = join(dir ?? tmpdir(), `clone-${counter++}.db`);
  copyFileSync(source, target);
  const raw = new DatabaseSync(target);
  setPragmas(raw, pragmas);
  return raw;
}

export function setPragmas(raw: DatabaseSync, pragmas: Pragmas): void {
  raw.exec(`PRAGMA foreign_keys=${pragmas.foreignKeys === false ? 'OFF' : 'ON'}`);
  if (pragmas.deferForeignKeys) raw.exec('PRAGMA defer_foreign_keys=ON');
  if (pragmas.legacyAlterTable) raw.exec('PRAGMA legacy_alter_table=ON');
}

/** Runs `sql` the way the mode does and returns every error message seen. */
export function runSql(raw: DatabaseSync, sql: string, mode: Mode): string[] {
  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  if (mode === 'transaction') {
    try {
      raw.exec('BEGIN');
      raw.exec(sql);
      raw.exec('COMMIT');
      return [];
    } catch (e) {
      try {
        raw.exec('ROLLBACK');
      } catch {
        // already rolled back by the failing statement
      }
      return [message(e)];
    }
  }
  if (mode === 'abort') {
    try {
      raw.exec(sql);
      return [];
    } catch (e) {
      return [message(e)];
    }
  }
  const errors: string[] = [];
  for (const statement of splitStatements(sql)) {
    try {
      raw.exec(statement);
    } catch (e) {
      errors.push(message(e));
    }
  }
  return errors;
}

/** The process died after the first `k` statements: no transaction, each statement committed. */
export function runPrefix(raw: DatabaseSync, statements: readonly string[], k: number): void {
  for (const statement of statements.slice(0, k)) raw.exec(statement);
}

// --- inspection -------------------------------------------------------------------------------

const json = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (x instanceof Uint8Array ? Array.from(x) : x));

export const tableNames = (raw: DatabaseSync): string[] =>
  (
    raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);

export const hasTable = (raw: DatabaseSync, name: string): boolean => tableNames(raw).includes(name);

export const countRows = (raw: DatabaseSync, table: string): number =>
  (raw.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;

/**
 * Rows as JSON strings in rowid order, with organization_id left out (the backfill legitimately fills it) and
 * `correlation_id` left out (migration 0027 adds it to live tables, and recovery re-adds it empty).
 */
export function rowsWithoutOrg(raw: DatabaseSync, table: string): string[] {
  return (raw.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Record<string, unknown>[]).map(
    ({ organization_id: _o, correlation_id: _c, ...rest }) => json(rest),
  );
}

/** Every original row, by table, as it was before the migration touched anything. */
export function originalRows(): Record<string, string[]> {
  const raw = cloneBase();
  try {
    return Object.fromEntries(TABLES.map((t) => [t, rowsWithoutOrg(raw, t)]));
  } finally {
    raw.close();
  }
}

/**
 * Original rows that exist in neither the live table nor `<table>_old`. Empty means nothing was
 * lost, whatever state the database is in. (Quarantined orphans are counted as present: they are
 * kept in `_old`; a state where they are in neither is a loss.)
 */
export function lostRows(raw: DatabaseSync, original: Record<string, string[]>): string[] {
  const names = new Set(tableNames(raw));
  const lost: string[] = [];
  for (const t of TABLES) {
    const have = new Set<string>();
    for (const name of [t, `${t}_old`])
      if (names.has(name)) for (const r of rowsWithoutOrg(raw, name)) have.add(r);
    for (const row of original[t] ?? []) if (!have.has(row)) lost.push(`${t}: ${row.slice(0, 60)}`);
  }
  return lost;
}

const squash = (sql: string | null): string =>
  (sql ?? '')
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, '')
    .replace(/"/g, '');

/** The six tables, their indexes and triggers, and every trigger that names `integrations`: squashed DDL by name. */
export function schemaOf(raw: DatabaseSync): Map<string, string> {
  const rows = raw
    .prepare(
      `SELECT type,name,sql FROM sqlite_master
       WHERE sql IS NOT NULL AND type IN ('table','index','trigger')
         AND (tbl_name IN (${TABLES.map((t) => `'${t}'`).join(',')}) OR (type = 'trigger' AND sql LIKE '%integrations%'))
         AND name NOT LIKE '%\\_old' ESCAPE '\\'`,
    )
    .all() as { type: string; name: string; sql: string }[];
  return new Map(rows.map((r) => [`${r.type}:${r.name}`, squash(r.sql)]));
}

/** Whole-database fingerprint: every table's rows (minus volatile columns) and every object's DDL. */
export function dumpState(raw: DatabaseSync, options: { skipScratch?: boolean } = {}): string {
  const out: string[] = [];
  const skip = (name: string): boolean => options.skipScratch === true && SCRATCH_PATTERN.test(name);
  for (const name of tableNames(raw).filter((n) => !skip(n))) {
    const cols = (raw.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[])
      .map((c) => c.name)
      .filter((c) => c !== 'quarantined_at');
    const select = cols.map((c) => `"${c}"`).join(',');
    // The snapshot is DDL scratch whose rows depend on when objects were last recreated: only its shape counts.
    if (name === '_snapshot_0026') {
      out.push(`${name}: (rows not compared)`);
      continue;
    }
    out.push(`${name}: ${json(raw.prepare(`SELECT ${select} FROM "${name}" ORDER BY rowid`).all())}`);
  }
  for (const r of raw
    .prepare('SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name')
    .all() as {
    type: string;
    name: string;
    sql: string;
  }[])
    if (!skip(r.name)) out.push(`${r.type} ${r.name}: ${squash(r.sql)}`);
  return out.join('\n');
}

/** Table names created by the file that must not outlive it. */
export const SCRATCH_PATTERN =
  /_v4$|^_guard|^_contract|^_gate_0026|^_swap_verify$|^_fk_required$|^_alter_mode$|^_old_absent$|^_live_present$/;
export const scratchObjects = (raw: DatabaseSync): string[] =>
  (
    raw.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name").all() as {
      name: string;
    }[]
  )
    .map((r) => r.name)
    .filter((n) => SCRATCH_PATTERN.test(n));

/** Has the contract been applied to this live table: a foreign key from organization_id to organization(id)? */
export const contracted = (raw: DatabaseSync, table: string): boolean =>
  (
    raw
      .prepare(
        `SELECT COUNT(*) AS n FROM pragma_foreign_key_list('${table}') WHERE "from"='organization_id' AND "table"='organization'`,
      )
      .get() as { n: number }
  ).n === 1;
