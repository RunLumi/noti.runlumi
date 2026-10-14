#!/usr/bin/env node
/**
 * Puts the database back to its pre-0026 shape after migration 0026 failed part way, or after it
 * completed and you decided to back out BEFORE traffic resumed on the new tables (docs/RUNBOOK.md,
 * docs/adr/0021). Everything it needs is in the database: the kept originals (`<table>_old`) and
 * `_snapshot_0026`, the verbatim DDL of every index and trigger 0026 drops.
 *
 *   node scripts/migration-0026-recover.mjs --database lumi-noti --remote            # plan, changes nothing
 *   node scripts/migration-0026-recover.mjs --database lumi-noti --remote --apply
 *
 * For each table that has a `<table>_old`: drop the live table if one exists (the rebuilt copy, or
 * nothing), rename `<table>_old` back, then recreate the table's indexes and triggers from the
 * snapshot, triggers first. The `sources_delete_integrations` trigger is dropped before anything
 * else because a trigger that names a missing table makes ALTER TABLE ... RENAME fail. Scratch
 * objects (copies, gates, the poison view, guard tables of the first version) are dropped.
 *
 * REFUSES (exit 1) when a live table holds a row that `<table>_old` does not hold exactly, because
 * dropping it would discard a write made after the swap. Pass --discard-live-changes only after
 * reading the count. It never touches a table without a `<table>_old`.
 *
 * After it, re-run migration 0026 (it re-creates `_old`) or stay on the old schema: the previous
 * Worker keeps working. Idempotent: run it again and it plans nothing.
 */
import {
  SCRATCH_TABLES,
  SCRATCH_VIEWS,
  CORRELATION_TABLES,
  LATER_MIGRATION_OBJECTS,
  correlationStatements,
  SNAPSHOT_TABLE,
  TABLES,
  compareColumns,
  ident,
  inventory,
  oldName,
  wranglerExecutor,
} from './lib/migration-0026.mjs';

const SOURCES_TRIGGER = 'sources_delete_integrations';

/**
 * @param {{ query(sql: string): Promise<Record<string, unknown>[]>, run(statements: string[]): Promise<void> }} executor
 * @param {{ discardLiveChanges?: boolean }} [options]
 * @returns {Promise<{ statements: string[], restored: string[], blockers: string[], notes: string[] }>}
 */
export async function planRecovery(executor, options = {}) {
  const present = await inventory(executor, [
    ...TABLES,
    ...TABLES.map(oldName),
    ...SCRATCH_TABLES,
    ...SCRATCH_VIEWS,
    SNAPSHOT_TABLE,
    SOURCES_TRIGGER,
    'd1_migrations',
  ]);
  const has = (name) => present.has(name);
  const restore = TABLES.filter((t) => has(oldName(t)));
  const blockers = [];
  const notes = [];

  // A live table that diverged from its kept original would lose those rows when dropped.
  for (const table of restore) {
    if (!has(table)) continue;
    const [row] = await executor.query(
      `SELECT COUNT(*) AS n FROM (SELECT ${compareColumns(table)} FROM ${ident(table)} EXCEPT SELECT ${compareColumns(table)} FROM ${ident(oldName(table))})`,
    );
    const diverged = Number(row?.n ?? 0);
    if (diverged > 0 && !options.discardLiveChanges) {
      blockers.push(
        `${table} holds ${diverged} row(s) that ${oldName(table)} does not hold exactly (written or changed after the swap); ` +
          'restoring would discard them. Read them, then re-run with --discard-live-changes, or restore from the Time Travel bookmark',
      );
    } else if (diverged > 0) {
      notes.push(
        `${table}: discarding ${diverged} row(s) written or changed after the swap (--discard-live-changes)`,
      );
    }
  }

  // 0027 added `correlation_id` to the live tables only. If it is applied (d1_migrations lists it) or the live
  // table has the column, the restored original needs it back, or the current Worker's INSERTs fail.
  const needsCorrelation = [];
  if (restore.some((t) => CORRELATION_TABLES.includes(t))) {
    const [applied] = has('d1_migrations')
      ? await executor.query("SELECT COUNT(*) AS n FROM d1_migrations WHERE name LIKE '0027%'")
      : [{ n: 0 }];
    const hasColumn = await executor.query(
      "SELECT m.name AS t FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name IN ('deliveries','notification_outbox') AND p.name = 'correlation_id'",
    );
    const live = new Set(hasColumn.map((r) => String(r.t)));
    for (const t of restore)
      if (CORRELATION_TABLES.includes(t) && (Number(applied?.n ?? 0) > 0 || live.has(t)))
        needsCorrelation.push(t);
  }

  /** @type {string[]} */
  const statements = [];
  const drop = (kind, name) => statements.push(`DROP ${kind} IF EXISTS ${ident(name)}`);

  // 1. The poison view blocks every rename; a trigger that names a table we are about to drop blocks them too.
  for (const view of SCRATCH_VIEWS) if (has(view)) drop('VIEW', view);
  if (restore.length > 0 && has(SOURCES_TRIGGER)) drop('TRIGGER', SOURCES_TRIGGER);
  for (const name of SCRATCH_TABLES) if (has(name)) drop('TABLE', name);

  // 2. Put each kept original back under its own name.
  for (const table of restore) {
    if (has(table)) drop('TABLE', table);
    statements.push(`ALTER TABLE ${ident(oldName(table))} RENAME TO ${ident(table)}`);
  }

  // 3. Recreate what 0026 dropped, verbatim: triggers first, then indexes. The source is the snapshot; for
  // anything it does not hold (an empty or missing snapshot) the objects now on the live rebuilt table, which
  // 0026 creates from the same text (the schema-diff test pins that), read BEFORE that table is dropped.
  if (restore.length > 0) {
    const fromSnapshot = has(SNAPSHOT_TABLE)
      ? await executor.query(`SELECT type, name, tbl_name, sql FROM ${ident(SNAPSHOT_TABLE)} ORDER BY name`)
      : [];
    const fromLive = await executor.query(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name",
    );
    const known = new Set(fromSnapshot.map((r) => String(r.name)));
    const candidates = [
      ...fromSnapshot,
      ...fromLive.filter(
        (r) =>
          !known.has(String(r.name)) &&
          !LATER_MIGRATION_OBJECTS.has(String(r.name)) &&
          !/_old\b/.test(String(r.sql)),
      ),
    ];
    const wanted = candidates.filter(
      (r) =>
        restore.includes(String(r.tbl_name)) ||
        (r.name === SOURCES_TRIGGER && restore.includes('integrations')),
    );
    if (fromSnapshot.length === 0)
      notes.push(
        `${SNAPSHOT_TABLE} is empty or missing: recreating indexes and triggers from the live rebuilt tables`,
      );
    const triggers = wanted.filter((r) => r.type === 'trigger');
    const indexes = wanted.filter((r) => r.type === 'index');
    for (const r of triggers) {
      drop('TRIGGER', String(r.name));
      statements.push(String(r.sql));
    }
    for (const r of indexes) {
      drop('INDEX', String(r.name));
      statements.push(String(r.sql));
    }
    for (const t of needsCorrelation) statements.push(...correlationStatements(t));
    if (needsCorrelation.length > 0)
      notes.push(`re-adding correlation_id (migration 0027) to: ${needsCorrelation.join(', ')}`);
    if (restore.includes('integrations') && !triggers.some((r) => r.name === SOURCES_TRIGGER))
      blockers.push(
        `no ${SOURCES_TRIGGER} in ${SNAPSHOT_TABLE} or on the live tables; restore from the Time Travel bookmark`,
      );
  }
  return { statements, restored: restore, blockers, notes };
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
      'usage: node scripts/migration-0026-recover.mjs --database <name> (--remote|--local) [--apply] [--discard-live-changes]',
    );
    process.exit(2);
  }
  const executor = wranglerExecutor({ database, remote: args.includes('--remote') });
  const plan = await planRecovery(executor, { discardLiveChanges: args.includes('--discard-live-changes') });
  for (const note of plan.notes) console.log(`NOTE    ${note}`);
  for (const blocker of plan.blockers) console.log(`BLOCKER ${blocker}`);
  if (plan.statements.length === 0 && plan.blockers.length === 0) {
    console.log('recover: nothing to do (no <table>_old and no scratch objects)');
    return;
  }
  for (const s of plan.statements) console.log(`  ${s.replace(/\s+/g, ' ').slice(0, 160)}`);
  if (plan.blockers.length > 0) {
    console.log('\nrecover: REFUSED');
    process.exit(1);
  }
  if (!args.includes('--apply')) {
    console.log(`\nrecover: ${plan.statements.length} statement(s) planned, nothing changed (add --apply)`);
    return;
  }
  await executor.run(plan.statements);
  console.log(
    `\nrecover: applied ${plan.statements.length} statement(s); restored ${plan.restored.join(', ') || 'no table'}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
