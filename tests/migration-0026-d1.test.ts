import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { maxCompoundTerms } from './support/compound-terms';
import {
  TABLES,
  cloneBase,
  contracted,
  lostRows,
  originalRows,
  rowsWithoutOrg,
  scratchObjects,
  tableNames,
} from './support/migration-0026-harness';
import { migrationFiles } from './support/d1';

/**
 * D1 is workerd's SQLite, which is stricter than node:sqlite in ways the rest of the suite cannot see (the
 * first versions of 0026 failed "too many terms in compound SELECT" there while every node test passed).
 * So this file (1) bans the known limit statically across migrations, scripts and the runbook, and
 * (2) runs the REAL `wrangler d1 migrations apply --local` on the whole chain and on a seeded legacy
 * database, then the finalize and recover scripts through `wrangler d1 execute --local`, asserting no row
 * is lost. It needs no network and no account.
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(root, 'node_modules', '.bin', 'wrangler');
/** workerd allows 5 terms; stay under it. */
const MAX_TERMS = 4;

describe('compound SELECT limit (workerd allows 5 terms)', () => {
  const sqlFiles = [
    ...readdirSync(join(root, 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => join('migrations', f)),
    ...readdirSync(join(root, 'scripts'))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => join('scripts', f)),
  ];

  it.each(sqlFiles)('%s has no compound SELECT of more than 4 terms', (file) => {
    expect(maxCompoundTerms(readFileSync(join(root, file), 'utf8')), file).toBeLessThanOrEqual(MAX_TERMS);
  });

  it('the runbook SQL blocks stay under it too', () => {
    const doc = readFileSync(join(root, 'docs', 'RUNBOOK.md'), 'utf8');
    const blocks = [...doc.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
    expect(blocks.length).toBeGreaterThan(3);
    for (const block of blocks)
      expect(maxCompoundTerms(block), block.slice(0, 60)).toBeLessThanOrEqual(MAX_TERMS);
  });

  it('the counter counts what it should', () => {
    expect(maxCompoundTerms('SELECT 1')).toBe(0);
    expect(maxCompoundTerms('SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3')).toBe(3);
    expect(maxCompoundTerms('SELECT 1 UNION ALL SELECT 2; SELECT 3 UNION ALL SELECT 4')).toBe(2);
    expect(maxCompoundTerms("SELECT 'UNION' UNION ALL SELECT (SELECT 1 UNION SELECT 2 UNION SELECT 3)")).toBe(
      3,
    );
    expect(maxCompoundTerms(Array.from({ length: 6 }, () => 'SELECT 1').join(' UNION ALL '))).toBe(6);
  });
});

// --- real wrangler ----------------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), 'noti-0026-d1-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
const DATABASE = 'lumi-noti';
// Must equal wrangler.jsonc's id: `wrangler d1 execute --local` run from the repo finds the same file by it.
const DATABASE_ID = 'REPLACE_WITH_D1_DATABASE_ID';

function wrangler(args: string[], cwd = root): { status: number | null; out: string } {
  const r = spawnSync(BIN, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/**
 * The first complete top-level JSON array in wrangler's output. wrangler prints trailing text after `--json`
 * results (its log path, a version notice), so slicing from `[` to the end of the buffer is not parseable.
 */
function firstJsonArray(text: string): unknown {
  const start = text.indexOf('[');
  if (start < 0) throw new Error(`no JSON array in wrangler output: ${text.slice(-400)}`);
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error(`unterminated JSON array in wrangler output: ${text.slice(-400)}`);
}

/** A wrangler config whose migrations come from `migrationsDir`. */
function config(name: string, migrationsDir: string): string {
  const file = join(scratch, `${name}.jsonc`);
  writeFileSync(
    file,
    JSON.stringify({
      name: 'd1-compat',
      compatibility_date: '2026-09-01',
      d1_databases: [
        { binding: 'DB', database_name: DATABASE, database_id: DATABASE_ID, migrations_dir: migrationsDir },
      ],
    }),
  );
  return file;
}

const apply = (cfg: string, persist: string) =>
  wrangler(['d1', 'migrations', 'apply', DATABASE, '--local', '--persist-to', persist, '--config', cfg]);

function sqliteFile(persist: string): string {
  const dir = join(persist, 'v3', 'd1', 'miniflare-D1DatabaseObject');
  const file = readdirSync(dir).find((f) => f.endsWith('.sqlite'));
  if (!file) throw new Error('no local D1 file');
  return join(dir, file);
}

const sqlLiteral = (v: unknown): string => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (v instanceof Uint8Array) return `x'${Buffer.from(v).toString('hex')}'`;
  if (typeof v !== 'string') throw new TypeError('unexpected seed value');
  return `'${v.replaceAll("'", "''")}'`;
};

/** The seeded legacy rows of the harness as INSERT statements (one per row). */
function seedSql(): string {
  const raw = cloneBase();
  const lines = [
    'DROP TRIGGER integrations_org_required_insert;',
    'DROP TRIGGER integrations_source_same_org;',
  ];
  for (const table of [
    'organization',
    'sources',
    'integrations',
    'deliveries',
    'notification_outbox',
    'held_events',
    'routing_decisions',
    'noise_open_failures',
    'event_dedup',
    'delivery_attempts',
    'destination_health',
  ]) {
    for (const row of raw.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Record<
      string,
      unknown
    >[]) {
      const cols = Object.keys(row);
      lines.push(
        `INSERT INTO "${table}"(${cols.map((c) => `"${c}"`).join(',')}) VALUES(${cols.map((c) => sqlLiteral(row[c])).join(',')});`,
      );
    }
  }
  raw.close();
  return `${lines.join('\n')}\n`;
}

describe('the real `wrangler d1 migrations apply --local` (workerd SQLite)', () => {
  it('applies every migration, 0001 to the last, on an empty database', { timeout: 120_000 }, () => {
    const persist = join(scratch, 'empty');
    mkdirSync(persist);
    const result = apply(config('all', join(root, 'migrations')), persist);
    expect(result.out).not.toMatch(/ERROR|too many terms/);
    expect(result.status).toBe(0);
    const raw = new DatabaseSync(sqliteFile(persist), { readOnly: true });
    expect(tableNames(raw)).toEqual(
      expect.arrayContaining(['integrations_old', '_snapshot_0026', 'legacy_orphaned_rows']),
    );
    expect(scratchObjects(raw)).toEqual([]);
    for (const t of TABLES) expect(contracted(raw, t), t).toBe(true);
    raw.close();
  });

  /** 0001..0025 and the legacy seed through wrangler, then (optionally) the preflight, then 0026 alone. */
  async function seededAndMigrated(
    name: string,
  ): Promise<{ persist: string; file: string; predicted: number }> {
    const before = join(scratch, `${name}-before`);
    mkdirSync(before);
    for (const f of migrationFiles().filter((x) => x < '0026'))
      copyFileSync(join(root, 'migrations', f), join(before, f));
    const persist = join(scratch, name);
    mkdirSync(persist);
    expect(apply(config(`${name}-before`, before), persist).status).toBe(0);
    const seedFile = join(scratch, `${name}-seed.sql`);
    writeFileSync(seedFile, seedSql());
    const seeded = wrangler([
      'd1',
      'execute',
      DATABASE,
      '--local',
      '--persist-to',
      persist,
      '--config',
      config(`${name}-seed`, before),
      '--file',
      seedFile,
    ]);
    expect(seeded.status, seeded.out.slice(-400)).toBe(0);

    // The preflight runs on workerd (it was 23 compound terms) and predicts the quarantine.
    const pre = wrangler([
      'd1',
      'execute',
      DATABASE,
      '--local',
      '--persist-to',
      persist,
      '--config',
      config(`${name}-pre`, before),
      '--json',
      '--file',
      join(root, 'scripts', 'migration-0026-preflight.sql'),
    ]);
    expect(pre.status, pre.out.slice(-400)).toBe(0);
    const preflightPath = '../scripts/migration-0026-preflight.mjs';
    const { rowsOf } = (await import(/* @vite-ignore */ preflightPath)) as {
      rowsOf: (raw: unknown) => { check: string; n: number }[];
    };
    const predicted = rowsOf(firstJsonArray(pre.out))
      .filter((r) => r.check.startsWith('orphan:'))
      .reduce((sum, r) => sum + r.n, 0);
    expect(predicted).toBeGreaterThan(5);

    // 0026 alone, the real file, the real runner.
    const applied = apply(config(`${name}-full`, join(root, 'migrations')), persist);
    expect(applied.out).not.toMatch(/ERROR|too many terms/);
    expect(applied.status).toBe(0);
    return { persist, file: sqliteFile(persist), predicted };
  }

  interface Executor {
    run(statements: string[]): Promise<void>;
  }
  const scripts = async () => {
    const lib = '../scripts/lib/migration-0026.mjs';
    const fin = '../scripts/migration-0026-finalize.mjs';
    const rec = '../scripts/migration-0026-recover.mjs';
    return {
      ...((await import(/* @vite-ignore */ lib)) as {
        wranglerExecutor: (o: { database: string; remote: boolean; persistTo: string }) => Executor;
      }),
      ...((await import(/* @vite-ignore */ fin)) as {
        finalize: (e: Executor, o?: { apply?: boolean }) => Promise<{ status: string; blockers: string[] }>;
      }),
      ...((await import(/* @vite-ignore */ rec)) as {
        planRecovery: (e: Executor) => Promise<{ statements: string[]; blockers: string[] }>;
      }),
    };
  };

  it(
    'applies 0026 to a seeded legacy database with zero row loss, and finalize reconciles and drops through wrangler',
    { timeout: 600_000 },
    async () => {
      const { persist, file, predicted } = await seededAndMigrated('finalize');
      const raw = new DatabaseSync(file, { readOnly: true });
      const original = originalRows();
      expect(lostRows(raw, original)).toEqual([]);
      for (const t of TABLES) {
        expect(contracted(raw, t), t).toBe(true);
        expect(rowsWithoutOrg(raw, `${t}_old`), `${t}_old`).toEqual(original[t]);
        expect(
          (raw.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n,
          `${t} not empty`,
        ).toBeGreaterThan(0);
      }
      expect((raw.prepare('SELECT COUNT(*) AS n FROM legacy_orphaned_rows').get() as { n: number }).n).toBe(
        predicted,
      );
      expect(scratchObjects(raw)).toEqual([]);
      expect(
        raw.prepare("SELECT 1 FROM sqlite_master WHERE name='sources_delete_integrations'").all(),
      ).toHaveLength(1);
      const liveCounts = TABLES.map(
        (t) => (raw.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n,
      );
      raw.close();

      const { wranglerExecutor, finalize } = await scripts();
      const executor = wranglerExecutor({ database: DATABASE, remote: false, persistTo: persist });
      const check = await finalize(executor);
      expect(check.blockers).toEqual([]);
      expect(check.status).toBe('reconciled');
      expect((await finalize(executor, { apply: true })).status).toBe('finalized');
      expect((await finalize(executor, { apply: true })).status).toBe('nothing_to_finalize');
      const after = new DatabaseSync(file, { readOnly: true });
      expect(tableNames(after).filter((n) => n.endsWith('_old') || n === '_snapshot_0026')).toEqual([]);
      expect(
        TABLES.map((t) => (after.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n),
      ).toEqual(liveCounts);
      after.close();
    },
  );

  it(
    'recovery restores the originals, indexes and triggers through wrangler',
    { timeout: 600_000 },
    async () => {
      const { persist, file } = await seededAndMigrated('recover');
      const { wranglerExecutor, planRecovery } = await scripts();
      const executor = wranglerExecutor({ database: DATABASE, remote: false, persistTo: persist });
      const plan = await planRecovery(executor);
      expect(plan.blockers).toEqual([]);
      await executor.run(plan.statements);
      const restored = new DatabaseSync(file, { readOnly: true });
      const original = originalRows();
      expect(lostRows(restored, original)).toEqual([]);
      const pristine = cloneBase();
      const names = (db: DatabaseSync) =>
        (
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name",
            )
            .all() as { name: string }[]
        ).map((r) => r.name);
      for (const t of TABLES) {
        expect(contracted(restored, t), `${t} restored`).toBe(false);
        expect(rowsWithoutOrg(restored, t), t).toEqual(original[t]);
      }
      expect(names(restored)).toEqual(expect.arrayContaining(names(pristine)));
      // Migration 0027 stays recorded as applied, so the restored tables must carry what it added.
      for (const t of ['deliveries', 'notification_outbox']) {
        const cols = (
          restored.prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as { name: string }[]
        ).map((c) => c.name);
        expect(cols, `${t} correlation_id`).toContain('correlation_id');
      }
      expect(names(restored)).toEqual(
        expect.arrayContaining(['deliveries_correlation', 'deliveries_org_correlation']),
      );
      expect(((plan as { notes?: string[] }).notes ?? []).join('\n')).toMatch(/correlation_id/);
      restored.close();
    },
  );
});
