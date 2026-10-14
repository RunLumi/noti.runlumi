/**
 * Shared by scripts/migration-0026-finalize.mjs and scripts/migration-0026-recover.mjs
 * (docs/adr/0021, docs/RUNBOOK.md): the six tables, the scratch objects migration 0026 leaves,
 * and an executor over `wrangler d1 execute`.
 *
 * An executor is `{ query(sql) -> Promise<row[]>, run(statements: string[]) -> Promise<void> }`.
 * Tests pass one over node:sqlite; the CLI passes `wranglerExecutor`, which has never been run
 * against a real D1 (UNVERIFIED, docs/RELEASE_GATES.md).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TABLES = [
  'integrations',
  'deliveries',
  'notification_outbox',
  'held_events',
  'routing_decisions',
  'noise_open_failures',
];

export const oldName = (table) => `${table}_old`;

/** Scratch tables and views migration 0026 creates (never an `_old` table, never the snapshot). */
export const SCRATCH_TABLES = [
  '_gate_0026_ok',
  '_gate_0026_verified',
  '_fk_required',
  '_alter_mode',
  '_old_absent',
  '_live_present',
  '_contract_verify',
  '_swap_verify',
  ...TABLES.map((t) => `_guard_${t}`),
  ...TABLES.map((t) => `${t}_v4`),
];
export const SCRATCH_VIEWS = ['_gate_0026_poison'];
export const SNAPSHOT_TABLE = '_snapshot_0026';

const ident = (name) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`refusing to quote identifier ${name}`);
  return `"${name}"`;
};
export { ident };

/** Flattens wrangler's `--json` output ([{ results: [...] }]) to rows. */
export function rowsFromWrangler(raw) {
  const batches = Array.isArray(raw) ? raw : [];
  return batches.flatMap((b) => (b && typeof b === 'object' && Array.isArray(b.results) ? b.results : []));
}

/**
 * @param {{ database: string, remote?: boolean, wrangler?: string[] }} options
 * Runs `wrangler d1 execute` per call. Statements go through a temporary file so a trigger body
 * keeps its semicolons.
 */
export function wranglerExecutor({
  database,
  remote = true,
  wrangler = ['npx', '--no-install', 'wrangler'],
}) {
  const base = [...wrangler.slice(1), 'd1', 'execute', database, remote ? '--remote' : '--local', '--json'];
  const spawn = (extra) => {
    const result = spawnSync(wrangler[0], [...base, ...extra], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0)
      throw new Error(`wrangler d1 execute failed: ${(result.stderr || result.stdout).slice(0, 500)}`);
    return result.stdout;
  };
  return {
    query(sql) {
      return Promise.resolve(rowsFromWrangler(JSON.parse(spawn(['--command', sql]))));
    },
    run(statements) {
      const dir = mkdtempSync(join(tmpdir(), 'noti-0026-'));
      try {
        const file = join(dir, 'statements.sql');
        writeFileSync(file, `${statements.map((s) => s.replace(/;\s*$/, '')).join(';\n')};\n`);
        spawn(['--file', file]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      return Promise.resolve();
    },
  };
}

/** Names of objects present, by type, from sqlite_master. */
export async function inventory(executor, names) {
  const list = names.map((n) => `'${n}'`).join(',');
  const rows = await executor.query(`SELECT type, name FROM sqlite_master WHERE name IN (${list})`);
  return new Map(rows.map((r) => [String(r.name), String(r.type)]));
}
