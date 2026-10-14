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
 * @param {{ database: string, remote?: boolean, persistTo?: string, wrangler?: string[] }} options
 * `persistTo` is for a local D1 (tests); it is ignored with `remote`.
 * Runs `wrangler d1 execute` per call. Statements go through a temporary file so a trigger body
 * keeps its semicolons.
 */
export function wranglerExecutor({
  database,
  remote = true,
  persistTo,
  wrangler = ['npx', '--no-install', 'wrangler'],
}) {
  // The name goes to a command line: refuse anything that is not a plain database name.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(database))
    throw new Error(`refusing database name ${database}`);
  const base = [
    ...wrangler.slice(1),
    'd1',
    'execute',
    database,
    remote ? '--remote' : '--local',
    ...(!remote && persistTo ? ['--persist-to', persistTo] : []),
    '--json',
  ];
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
    /** One wrangler call for many SELECT statements (wrangler --json returns one result set per statement). */
    queryMany(statements) {
      const dir = mkdtempSync(join(tmpdir(), 'noti-0026-'));
      try {
        const file = join(dir, 'queries.sql');
        writeFileSync(file, `${statements.map((x) => x.replace(/;\s*$/, '')).join(';\n')};\n`);
        return Promise.resolve(rowsFromWrangler(JSON.parse(spawn(['--file', file]))));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
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

/**
 * The columns that exist in BOTH a live table and its kept original `<t>_old`. Later migrations add columns to
 * the live table only (0027 `correlation_id`), so whole-row comparisons name the columns 0026 created.
 * Tables not listed have no later additions and compare with `*`.
 */
export const COMPARE_COLUMNS = {
  deliveries:
    'id,integration_id,state,attempts,last_error,updated_at,organization_id,last_error_code,dedup_key,replay_of,replay_count,claim_token,claimed_at,next_attempt_at,first_attempt_at,last_attempt_at,dead_lettered_at,created_at,body_hash,is_test,duplicate_of,suppressed_reason,possible_duplicate,provider_message_id',
  notification_outbox:
    'id,payload_json,state,created_at,dispatched_at,organization_id,claimed_at,lease_token,lease_expires_at,not_before,last_error_code',
};

/** @param {string} table */
export const compareColumns = (table) => COMPARE_COLUMNS[table] ?? '*';

/**
 * Indexes and triggers created by LATER migrations on the live rebuilt tables, over columns the kept
 * originals do not have. Recovery recreates indexes from the live tables when the snapshot is empty; these
 * must not be recreated on a restored original (0027: `deliveries_correlation` needs `correlation_id`).
 */
export const CORRELATION_TABLES = ['deliveries', 'notification_outbox'];

/**
 * Re-add what migration 0027 added to a restored original: the nullable `correlation_id` column with its
 * CHECK, and for `deliveries` its two partial indexes. Same text as 0027 (a test pins the column text).
 * @param {string} table
 * @returns {string[]}
 */
export function correlationStatements(table) {
  const statements = [
    `ALTER TABLE ${ident(table)} ADD COLUMN correlation_id TEXT CHECK(correlation_id IS NULL OR length(correlation_id) <= 64)`,
  ];
  if (table === 'deliveries') {
    statements.push(
      'DROP INDEX IF EXISTS deliveries_correlation',
      'CREATE INDEX deliveries_correlation ON deliveries(correlation_id, organization_id) WHERE correlation_id IS NOT NULL',
      'DROP INDEX IF EXISTS deliveries_org_correlation',
      'CREATE INDEX deliveries_org_correlation ON deliveries(organization_id, correlation_id) WHERE correlation_id IS NOT NULL',
    );
  }
  return statements;
}

export const LATER_MIGRATION_OBJECTS = new Set(['deliveries_correlation', 'deliveries_org_correlation']);
