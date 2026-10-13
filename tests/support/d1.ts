import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A D1Database stand-in over Node's built-in SQLite, with every migration applied in order.
 *
 * It mirrors the D1 behaviours our code depends on: `prepare().bind()`, `first`, `all`,
 * `run` with `meta.changes`, and `batch` as one transaction. BLOB columns come back as
 * `number[]`, the shape D1 returns, so tests exercise the same normalisation path.
 */
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function normaliseBinding(value: unknown): SQLInputValue {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value as SQLInputValue;
}

function normaliseRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Uint8Array ? Array.from(value) : value;
  }
  return out;
}

class FakeStatement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    readonly params: readonly SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, values.map(normaliseBinding));
  }

  first<T>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    return Promise.resolve(row ? (normaliseRow(row) as T) : null);
  }

  all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    const rows = this.db.prepare(this.sql).all(...this.params) as Record<string, unknown>[];
    return Promise.resolve({ results: rows.map((r) => normaliseRow(r) as T), success: true, meta: {} });
  }

  runSync(): { success: true; meta: { changes: number } } {
    const result = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  run(): Promise<{ success: true; meta: { changes: number } }> {
    return Promise.resolve(this.runSync());
  }
}

export interface FakeD1 {
  readonly d1: D1Database;
  readonly raw: DatabaseSync;
}

export function createFakeD1(): FakeD1 {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys=ON');
  const dir = join(root, 'migrations');
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    raw.exec(readFileSync(join(dir, file), 'utf8'));
  }

  const d1 = {
    prepare: (sql: string) => new FakeStatement(raw, sql),
    batch: (statements: FakeStatement[]) => {
      raw.exec('BEGIN');
      try {
        const results = statements.map((s) => s.runSync());
        raw.exec('COMMIT');
        return Promise.resolve(results);
      } catch (e) {
        raw.exec('ROLLBACK');
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },
    exec: (sql: string) => {
      raw.exec(sql);
      return Promise.resolve({ count: 0, duration: 0 });
    },
  };
  return { d1: d1 as unknown as D1Database, raw };
}

/** Insert an organization row so foreign keys hold. */
export function seedOrganization(raw: DatabaseSync, id: string): void {
  raw.prepare('INSERT INTO "organization"(id,name,slug,created_at) VALUES(?,?,?,?)').run(id, id, id, 1);
}
