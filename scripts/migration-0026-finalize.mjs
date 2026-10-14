#!/usr/bin/env node
/**
 * The only step that destroys the originals migration 0026 kept (docs/adr/0021, docs/RUNBOOK.md).
 * Migration 0026 renames each of six tables aside to `<table>_old` and never drops it; this script
 * reconciles every `_old` against its live table and, only if it all balances, drops them.
 *
 *   node scripts/migration-0026-finalize.mjs --database lumi-noti --remote                 # check only
 *   node scripts/migration-0026-finalize.mjs --database lumi-noti --remote --apply         # check, then drop
 *   ... --ack-drift <N>     traffic resumed on the new tables: accept exactly N changed + missing + live-only rows
 *
 * Refuses unless, per table (scripts/migration-0026-finalize.sql): kept + quarantined = original, every
 * kept row equal to its original in every column, nothing live that the original lacked, no quarantined
 * id also live; and PRAGMA foreign_keys is 1 with no foreign key violations. Take a Time Travel bookmark
 * first (docs/RUNBOOK.md): the dropped rows include quarantined orphans whose credentials exist nowhere else.
 *
 * Drops: the six `<table>_old`, `_snapshot_0026`, and any scratch left by 0026 (`_gate_0026_*`, the poison
 * view, `_contract_*`, `_guard_*`, `*_v4`). Not `legacy_orphaned_rows` (review it, then drop it by hand).
 * Idempotent: with nothing left it prints so and exits 0. With only some `_old` tables it refuses
 * (a half-restored state: use scripts/migration-0026-recover.mjs).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCRATCH_TABLES,
  SCRATCH_VIEWS,
  SNAPSHOT_TABLE,
  TABLES,
  ident,
  inventory,
  oldName,
  wranglerExecutor,
} from './lib/migration-0026.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const RECONCILE_SQL = readFileSync(join(here, 'migration-0026-finalize.sql'), 'utf8')
  .split('\n')
  .filter((line) => !/^\s*--/.test(line))
  .join('\n');

/** @param {Record<string, unknown>[]} rows */
export function parseReconcile(rows) {
  const byCheck = new Map(rows.map((r) => [String(r.check), Number(r.n)]));
  const get = (name) => byCheck.get(name) ?? Number.NaN;
  const tables = TABLES.map((table) => {
    const old = get(`old:${table}`);
    const sameId = get(`same_id:${table}`);
    const identical = get(`identical:${table}`);
    const quarantined = get(`quarantined:${table}`);
    return {
      table,
      old,
      live: get(`live:${table}`),
      identical,
      quarantined,
      changed: sameId - identical,
      missing: old - sameId - quarantined,
      liveOnly: get(`live_only:${table}`),
      quarantineAlsoLive: get(`quarantine_also_live:${table}`),
    };
  });
  return { foreignKeys: get('fk:foreign_keys'), fkViolations: get('fk:violations'), tables };
}

/**
 * @param {ReturnType<typeof parseReconcile>} reconcile
 * @param {{ ackDrift?: number | null }} [options]
 */
export function evaluate(reconcile, options = {}) {
  const blockers = [];
  const review = [];
  if (reconcile.foreignKeys !== 1)
    blockers.push(
      'PRAGMA foreign_keys is not 1 on this connection; the contract is not enforced here, refusing',
    );
  if (reconcile.fkViolations !== 0)
    blockers.push(`${reconcile.fkViolations} foreign key violation(s) (PRAGMA foreign_key_check)`);
  let drift = 0;
  for (const t of reconcile.tables) {
    const numbers = [
      t.old,
      t.live,
      t.identical,
      t.quarantined,
      t.changed,
      t.missing,
      t.liveOnly,
      t.quarantineAlsoLive,
    ];
    if (numbers.some((n) => !Number.isFinite(n))) {
      blockers.push(`${t.table}: reconciliation rows are missing or unreadable`);
      continue;
    }
    if (t.missing < 0 || t.quarantineAlsoLive !== 0)
      blockers.push(
        `${t.table}: a quarantined id is also live, or the counts overlap (missing=${t.missing}, quarantine_also_live=${t.quarantineAlsoLive})`,
      );
    drift += Math.max(0, t.changed) + Math.max(0, t.missing) + t.liveOnly;
    if (t.changed + t.missing + t.liveOnly > 0)
      review.push(
        `${t.table}: changed=${t.changed} missing=${t.missing} live_only=${t.liveOnly} (old=${t.old}, live=${t.live}, quarantined=${t.quarantined})`,
      );
  }
  if (drift > 0 && options.ackDrift !== drift) {
    blockers.push(
      `the live tables differ from the kept originals by ${drift} row(s) (changed + missing + live_only). If you froze writers this is a defect: ` +
        `run scripts/migration-0026-recover.mjs. If traffic has resumed it is expected: read the rows above, then re-run with --ack-drift ${drift}`,
    );
  }
  return { ok: blockers.length === 0, blockers, review, drift };
}

/**
 * @param {{ query(sql: string): Promise<Record<string, unknown>[]>, run(statements: string[]): Promise<void> }} executor
 * @param {{ apply?: boolean, ackDrift?: number | null }} [options]
 */
export async function finalize(executor, options = {}) {
  const candidates = [...TABLES.map(oldName), SNAPSHOT_TABLE, ...SCRATCH_TABLES, ...SCRATCH_VIEWS];
  const present = await inventory(executor, candidates);
  const oldPresent = TABLES.filter((t) => present.has(oldName(t)));
  if (present.size === 0) return { status: 'nothing_to_finalize', removed: [], blockers: [], review: [] };
  if (oldPresent.length !== 0 && oldPresent.length !== TABLES.length) {
    return {
      status: 'refused',
      removed: [],
      review: [],
      blockers: [
        `only ${oldPresent.length} of ${TABLES.length} <table>_old tables exist (${oldPresent.map(oldName).join(', ')}): a half-restored or half-applied state. Run scripts/migration-0026-recover.mjs`,
      ],
    };
  }
  let review = [];
  if (oldPresent.length === TABLES.length) {
    const result = evaluate(parseReconcile(await executor.query(RECONCILE_SQL)), {
      ackDrift: options.ackDrift ?? null,
    });
    review = result.review;
    if (!result.ok) return { status: 'refused', removed: [], blockers: result.blockers, review };
  }
  // Views first (they reference the gate tables), then tables.
  const statements = [
    ...SCRATCH_VIEWS.filter((n) => present.has(n)).map((n) => `DROP VIEW ${ident(n)}`),
    ...candidates.filter((n) => present.get(n) === 'table').map((n) => `DROP TABLE ${ident(n)}`),
  ];
  const removed = candidates.filter((n) => present.has(n));
  if (!options.apply) return { status: 'reconciled', removed, blockers: [], review, statements };
  await executor.run(statements);
  return { status: 'finalized', removed, blockers: [], review, statements };
}

async function main() {
  const args = process.argv.slice(2);
  const at = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const database = at('--database');
  if (!database || (!args.includes('--remote') && !args.includes('--local'))) {
    console.error(
      'usage: node scripts/migration-0026-finalize.mjs --database <name> (--remote|--local) [--apply] [--ack-drift N]',
    );
    process.exit(2);
  }
  const ack = at('--ack-drift');
  const result = await finalize(wranglerExecutor({ database, remote: args.includes('--remote') }), {
    apply: args.includes('--apply'),
    ackDrift: ack === undefined ? null : Number(ack),
  });
  for (const line of result.review) console.log(`REVIEW  ${line}`);
  for (const line of result.blockers) console.log(`BLOCKER ${line}`);
  switch (result.status) {
    case 'nothing_to_finalize':
      console.log('finalize: nothing to finalize (no <table>_old and no scratch objects)');
      return;
    case 'refused':
      console.log('\nfinalize: REFUSED, nothing was dropped');
      process.exit(1);
      return;
    case 'reconciled':
      console.log(
        `finalize: everything reconciles. Would drop: ${result.removed.join(', ')}\n(add --apply to drop them; take a Time Travel bookmark first)`,
      );
      return;
    default:
      console.log(`finalize: dropped ${result.removed.join(', ')}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
