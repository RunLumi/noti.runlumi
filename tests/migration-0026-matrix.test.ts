import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MODES,
  TABLES,
  cloneBase,
  contracted,
  countRows,
  dispose,
  dumpState,
  hasTable,
  lostRows,
  migrationSql,
  originalRows,
  rowsWithoutOrg,
  runPrefix,
  runSql,
  scratchObjects,
  schemaOf,
  splitStatements,
  tableNames,
  type Mode,
} from './support/migration-0026-harness';

/**
 * The failure matrix for migration 0026 (docs/adr/0021). The file never drops an original; this
 * proves it under every runner (rolled back, aborting, carrying on), with foreign keys off, with
 * `defer_foreign_keys`, over a leftover `_old`, with a sabotaged copy, a late writer, and with the
 * process killed between any two statements, then proves the recovery script restores the original
 * schema and data from every one of those states.
 */
const LONG = { timeout: 180_000 };
const VERIFY = '-- --- 4. verify';
const SWAP = '-- --- 5. swap';
const LATE_ROW = `INSERT INTO deliveries(id,integration_id,state,organization_id,created_at) VALUES('d-late','i-ok','sent','org-a','2026-02-01');\n`;
const lostDelivery = (table: string) =>
  `DELETE FROM ${table}_v4 WHERE rowid = (SELECT MIN(rowid) FROM ${table}_v4);\n`;

interface Executor {
  query(sql: string): Promise<Record<string, unknown>[]>;
  run(statements: string[]): Promise<void>;
}
interface Plan {
  statements: string[];
  restored: string[];
  blockers: string[];
  notes: string[];
}
interface FinalizeResult {
  status: 'nothing_to_finalize' | 'refused' | 'reconciled' | 'finalized';
  removed: string[];
  blockers: string[];
  review: string[];
}
interface Scripts {
  planRecovery: (e: Executor, o?: { discardLiveChanges?: boolean }) => Promise<Plan>;
  finalize: (
    e: Executor,
    o?: { apply?: boolean; ackDrift?: number | null; ackChanged?: number | null },
  ) => Promise<FinalizeResult>;
}
const recoverPath = '../scripts/migration-0026-recover.mjs';
const finalizePath = '../scripts/migration-0026-finalize.mjs';
const { planRecovery } = (await import(/* @vite-ignore */ recoverPath)) as Pick<Scripts, 'planRecovery'>;
const { finalize } = (await import(/* @vite-ignore */ finalizePath)) as Pick<Scripts, 'finalize'>;

const over = (raw: DatabaseSync): Executor => ({
  query: (sql) => Promise.resolve(raw.prepare(sql).all() as Record<string, unknown>[]),
  run: (statements) => {
    for (const s of statements) raw.exec(s);
    return Promise.resolve();
  },
});

async function recover(raw: DatabaseSync, discard = false): Promise<Plan> {
  const plan = await planRecovery(over(raw), { discardLiveChanges: discard });
  if (plan.blockers.length === 0) await over(raw).run(plan.statements);
  return plan;
}

const original = originalRows();
const pristine = schemaOf(cloneBase());
/** Triggers the seed removed to simulate legacy rows; a blocked run legitimately re-creates them. */
const SEEDED_AWAY = new Set([
  'trigger:integrations_org_required_insert',
  'trigger:integrations_source_same_org',
]);

function happy(): { raw: DatabaseSync; dump: string } {
  const raw = cloneBase();
  expect(runSql(raw, migrationSql(), 'abort')).toEqual([]);
  return { raw, dump: dumpState(raw) };
}
const happyDump = happy().dump;
const withoutSnapshot = (dump: string): string =>
  dump
    .split('\n')
    .filter((line) => !line.startsWith('_snapshot_0026:'))
    .join('\n');

/** Every table a clean run leaves behind, and nothing else beyond the live tables. */
const expectNoLoss = (raw: DatabaseSync, label = ''): void => {
  expect(lostRows(raw, original), label).toEqual([]);
};
const expectSchemaRestored = (raw: DatabaseSync, label = ''): void => {
  const now = schemaOf(raw);
  for (const [key, sql] of pristine) expect(now.get(key), `${label} ${key}`).toBe(sql);
  for (const key of now.keys())
    expect(pristine.has(key) || SEEDED_AWAY.has(key), `${label} unexpected ${key}`).toBe(true);
};
const expectOriginalsLive = (raw: DatabaseSync, label = ''): void => {
  for (const t of TABLES) {
    expect(contracted(raw, t), `${label} ${t} contracted`).toBe(false);
    expect(rowsWithoutOrg(raw, t), `${label} ${t} rows`).toEqual(original[t]);
  }
  expect(
    tableNames(raw).filter((n) => n.endsWith('_old')),
    label,
  ).toEqual([]);
};

afterAll(() => {
  dispose();
});

describe('0026 can destroy nothing: static scan of the file', () => {
  const OWNED = [...TABLES, ...TABLES.map((t) => `${t}_old`)];
  const SCRATCH = [
    '_gate_0026_ok',
    '_gate_0026_verified',
    '_fk_required',
    '_alter_mode',
    '_old_absent',
    '_live_present',
    '_contract_verify',
    '_swap_verify',
    ...TABLES.flatMap((t) => [`${t}_v4`, `_guard_${t}`]),
  ];
  /** The table a statement destroys rows or structure of, if it does. */
  const destroyedTarget = (statement: string): string | null => {
    const m =
      /^\s*DROP\s+TABLE(?:\s+IF\s+EXISTS)?\s+"?(\w+)"?/i.exec(statement) ??
      /^\s*DELETE\s+FROM\s+"?(\w+)"?/i.exec(statement) ??
      /^\s*TRUNCATE(?:\s+TABLE)?\s+"?(\w+)"?/i.exec(statement) ??
      /^\s*(?:INSERT\s+OR\s+REPLACE|REPLACE)\s+INTO\s+"?(\w+)"?/i.exec(statement) ??
      /^\s*ALTER\s+TABLE\s+"?(\w+)"?\s+DROP\s+COLUMN/i.exec(statement) ??
      /^\s*UPDATE\s+OR\s+REPLACE\s+"?(\w+)"?/i.exec(statement);
    return m?.[1] ?? null;
  };

  it('has no DROP, DELETE, TRUNCATE or REPLACE that targets an original or an `_old` table', () => {
    for (const statement of splitStatements(migrationSql())) {
      const target = destroyedTarget(statement);
      expect(OWNED, statement.slice(0, 80)).not.toContain(target);
    }
  });

  it('only drops scratch objects, and only deletes from its own snapshot', () => {
    const drops = splitStatements(migrationSql()).flatMap((s) => {
      const t = /^\s*DROP\s+TABLE(?:\s+IF\s+EXISTS)?\s+(\w+)/i.exec(s);
      return t?.[1] ? [t[1]] : [];
    });
    expect(drops.length).toBeGreaterThan(20);
    for (const name of drops) expect(SCRATCH, name).toContain(name);
    const deletes = splitStatements(migrationSql()).flatMap((s) => {
      const t = /^\s*DELETE\s+FROM\s+(\w+)/i.exec(s);
      return t?.[1] ? [t[1]] : [];
    });
    // The only DELETEs are the snapshot refresh and the body of the sources trigger (which names integrations).
    expect(deletes.filter((n) => n !== 'integrations')).toEqual(['_snapshot_0026']);
  });

  it('gates every statement that writes data on the tripwire table, and every ALTER is a RENAME', () => {
    const statements = splitStatements(migrationSql());
    const writes = statements.filter((s) => /^\s*(INSERT\s+INTO|UPDATE)\s+(\w+)/i.test(s));
    const gated = writes.filter(
      (s) =>
        !/^\s*INSERT INTO (_fk_required|_alter_mode|_old_absent|_live_present|_contract_verify|_swap_verify)\b/i.test(
          s,
        ),
    );
    expect(gated.length).toBeGreaterThanOrEqual(15);
    for (const s of gated) expect(s, s.slice(0, 70)).toContain('_gate_0026_ok');
    for (const s of statements.filter((x) => /^\s*ALTER\s+TABLE/i.test(x))) expect(s).toMatch(/RENAME TO/i);
  });

  it('the scanner flags what it is meant to', () => {
    for (const bad of [
      'DROP TABLE integrations_old;',
      'DROP TABLE IF EXISTS deliveries;',
      'DELETE FROM held_events WHERE 1;',
      'TRUNCATE routing_decisions;',
      'INSERT OR REPLACE INTO noise_open_failures VALUES (1);',
      'ALTER TABLE notification_outbox DROP COLUMN state;',
    ])
      expect(OWNED).toContain(destroyedTarget(bad));
    expect(destroyedTarget('DROP TABLE integrations_v4;')).toBe('integrations_v4');
  });
});

describe('0026 in every runner', () => {
  it.each(MODES)('%s: completes, keeps every original in `<table>_old`, and leaves no scratch', (mode) => {
    const raw = cloneBase();
    expect(runSql(raw, migrationSql(), mode)).toEqual([]);
    for (const t of TABLES) {
      expect(contracted(raw, t), t).toBe(true);
      expect(rowsWithoutOrg(raw, `${t}_old`), `${t}_old`).toEqual(original[t]);
    }
    expect(scratchObjects(raw)).toEqual([]);
    expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(dumpState(raw)).toBe(happyDump);
    expectNoLoss(raw);
  });

  it('with PRAGMA defer_foreign_keys=ON (the way a DROP guard was defeated): nothing is lost', () => {
    for (const mode of MODES) {
      const raw = cloneBase({ deferForeignKeys: true });
      expect(runSql(raw, migrationSql(), mode), mode).toEqual([]);
      for (const t of TABLES)
        expect(rowsWithoutOrg(raw, `${t}_old`), `${mode} ${t}_old`).toEqual(original[t]);
      expect(dumpState(raw), mode).toBe(happyDump);
    }
  });
});

describe('tripwires', () => {
  it.each(MODES)('foreign keys off (%s): trips, and changes no original', (mode) => {
    const raw = cloneBase({ foreignKeys: false });
    const errors = runSql(raw, migrationSql(), mode);
    expect(errors.join('\n')).toContain('foreign_keys_must_be_on');
    expectOriginalsLive(raw);
    // Backfill is gated too: even the organization column is exactly as seeded.
    expect(raw.prepare("SELECT organization_id AS o FROM integrations WHERE id='i-src'").get()).toEqual({
      o: null,
    });
    expect(hasTable(raw, 'legacy_orphaned_rows') ? countRows(raw, 'legacy_orphaned_rows') : 0).toBe(0);
    expectNoLoss(raw);
  });

  it.each(MODES)(
    'legacy_alter_table=ON, the sqlite3 shell default (%s): the file switches it off itself and completes',
    (mode) => {
      const raw = cloneBase({ legacyAlterTable: true });
      expect(runSql(raw, migrationSql(), mode)).toEqual([]);
      for (const t of TABLES) {
        expect(contracted(raw, t), t).toBe(true);
        expect(countRows(raw, t), `${t} is not empty`).toBeGreaterThan(0);
        expect(rowsWithoutOrg(raw, `${t}_old`), `${t}_old`).toEqual(original[t]);
      }
      expect(dumpState(raw)).toBe(happyDump);
    },
  );

  describe('a runner that ignores the pragma (statement removed): the tripwire and the gates hold', () => {
    const withoutPragma = (): string => migrationSql().replace('PRAGMA legacy_alter_table=OFF;', '');
    it.each(MODES)('%s: trips, and nothing is lost', (mode) => {
      const raw = cloneBase({ legacyAlterTable: true });
      expect(runSql(raw, withoutPragma(), mode).join('\n')).toContain('legacy_alter_table_must_be_off');
      expectNoLoss(raw);
      if (mode !== 'continue') expectOriginalsLive(raw);
    });

    it('a carrying-on runner may swap empty copies; recovery restores everything, even with an empty snapshot', async () => {
      const raw = cloneBase({ legacyAlterTable: true });
      runSql(raw, withoutPragma(), 'continue');
      expectNoLoss(raw);
      // The snapshot is populated even though a tripwire fired; empty it anyway: recovery has a fallback.
      expect(countRows(raw, '_snapshot_0026')).toBeGreaterThan(20);
      raw.exec('DELETE FROM _snapshot_0026');
      raw.exec('PRAGMA legacy_alter_table=OFF');
      const plan = await recover(raw);
      expect(plan.blockers).toEqual([]);
      expect(plan.notes.join('\n')).toContain('empty or missing');
      expectOriginalsLive(raw);
      expectSchemaRestored(raw);
      expect(runSql(raw, migrationSql(), 'abort')).toEqual([]);
      expect(dumpState(raw)).toBe(happyDump);
    });
  });

  it.each(MODES)(
    'a leftover `<table>_old` (%s): trips before any rename or copy and changes nothing',
    (mode) => {
      const { raw, dump } = happy();
      const errors = runSql(raw, migrationSql(), mode);
      expect(errors.join('\n')).toContain(
        'old_tables_from_an_earlier_run_must_be_finalized_or_restored_first',
      );
      expect(dumpState(raw, { skipScratch: true })).toBe(dump);
      for (const t of TABLES) expect(rowsWithoutOrg(raw, `${t}_old`)).toEqual(original[t]);
    },
  );

  it('a runner that carries on runs NO dependent of a tripped wire (every gated statement fails)', () => {
    const { raw } = happy();
    const errors = runSql(raw, migrationSql(), 'continue');
    const dependents = splitStatements(migrationSql()).filter((s) =>
      s.includes('EXISTS (SELECT 1 FROM _gate_0026_ok)'),
    );
    expect(dependents.length).toBeGreaterThanOrEqual(16);
    expect(errors.filter((e) => /no such table: (main\.)?_gate_0026_ok/.test(e))).toHaveLength(
      dependents.length,
    );
    // And every rename was refused (the name is taken, or the poison view objected).
    expect(
      errors.filter((e) => /already another table|error in view _gate_0026_poison/.test(e)),
    ).toHaveLength(splitStatements(migrationSql()).filter((s) => /^ALTER TABLE/i.test(s)).length);
  });

  it('the swap-time gate holds when the file is run over a half-applied state (live table missing)', () => {
    for (const mode of MODES) {
      const raw = cloneBase();
      raw.exec('DROP TRIGGER sources_delete_integrations');
      raw.exec('ALTER TABLE deliveries RENAME TO deliveries_old');
      const errors = runSql(raw, migrationSql(), mode);
      expect(errors.join('\n'), mode).toMatch(/old_tables_from_an_earlier_run|all_six_tenant_tables/);
      expect(hasTable(raw, 'deliveries'), mode).toBe(false);
      expect(rowsWithoutOrg(raw, 'deliveries_old'), mode).toEqual(original.deliveries);
      expectNoLoss(raw, mode);
    }
  });
});

describe('a copy that does not balance, or a writer that outlives the freeze', () => {
  describe.each(MODES)('%s', (mode) => {
    it.each(TABLES)(
      'a row missing from %s_v4 stops every rename; nothing is lost; triggers survive',
      (table) => {
        const raw = cloneBase();
        const sql = migrationSql().replace(VERIFY, `${lostDelivery(table)}${VERIFY}`);
        expect(sql).toContain(lostDelivery(table));
        const errors = runSql(raw, sql, mode);
        expect(errors.join('\n')).toContain('row_counts_must_match');
        expectOriginalsLive(raw, table);
        expectNoLoss(raw, table);
        expect(
          raw.prepare("SELECT sql FROM sqlite_master WHERE name='sources_delete_integrations'").get(),
          'sources trigger',
        ).toMatchObject({ sql: expect.stringContaining('DELETE FROM integrations WHERE') as string });
        if (mode === 'continue') expectSchemaRestored(raw, table);
        // Whatever state it is in, a plain re-run completes (the scratch is dropped, nothing was swapped).
        // The snapshot may legitimately differ: a carried-on run re-created the two triggers the seed removed.
        expect(runSql(raw, migrationSql(), 'abort')).toEqual([]);
        expect(withoutSnapshot(dumpState(raw))).toBe(withoutSnapshot(happyDump));
      },
    );

    it('a row written to the original after the verify is kept in `<table>_old` and reported', () => {
      const raw = cloneBase();
      const errors = runSql(raw, migrationSql().replace(SWAP, `${LATE_ROW}${SWAP}`), mode);
      if (mode === 'transaction') {
        expectOriginalsLive(raw);
        expect(errors.join('\n')).toContain('swap_counts_must_match');
        return;
      }
      expect(errors.join('\n')).toContain('swap_counts_must_match');
      const late = raw.prepare("SELECT id FROM deliveries_old WHERE id='d-late'").all();
      expect(late).toHaveLength(1);
      expect(raw.prepare("SELECT id FROM deliveries WHERE id='d-late'").all()).toHaveLength(0);
    });
  });

  it('finalize refuses the late-writer state (missing=1) and recovery restores it with the row', async () => {
    const raw = cloneBase();
    runSql(raw, migrationSql().replace(SWAP, `${LATE_ROW}${SWAP}`), 'continue');
    const refused = await finalize(over(raw), { apply: true });
    expect(refused.status).toBe('refused');
    expect(refused.blockers.join('\n')).toMatch(/1 original row\(s\) are missing/);
    expect(hasTable(raw, 'deliveries_old')).toBe(true);
    const plan = await recover(raw);
    expect(plan.blockers).toEqual([]);
    expect(raw.prepare("SELECT id FROM deliveries WHERE id='d-late'").all()).toHaveLength(1);
    expectSchemaRestored(raw);
  });
});

describe('the process dies between any two statements', () => {
  const statements = splitStatements(migrationSql());

  it('has a statement count worth testing', () => {
    expect(statements.length).toBeGreaterThan(130);
  });

  it(
    'loses nothing in any state, and a re-run in every runner either completes or changes nothing',
    LONG,
    () => {
      for (let k = 0; k <= statements.length; k++) {
        const killed = cloneBase();
        runPrefix(killed, statements, k);
        expectNoLoss(killed, `prefix ${k}`);
        for (const mode of MODES) {
          const raw = cloneBase();
          runPrefix(raw, statements, k);
          const before = dumpState(raw, { skipScratch: true });
          const hadOld = hasTable(raw, 'integrations_old') || hasTable(raw, 'deliveries_old');
          runSql(raw, migrationSql(), mode);
          expectNoLoss(raw, `prefix ${k} then ${mode}`);
          if (hadOld) {
            // Tripped: the originals and the new tables are exactly as they were (scratch aside).
            for (const t of TABLES) {
              if (hasTable(raw, `${t}_old`))
                expect(rowsWithoutOrg(raw, `${t}_old`), `prefix ${k} ${mode} ${t}_old`).toEqual(original[t]);
            }
            if (scratchObjects(killed).length === 0)
              expect(dumpState(raw, { skipScratch: true }), `prefix ${k} ${mode}`).toBe(before);
          } else {
            // Nothing was swapped yet: the re-run completes and equals a clean run.
            expect(dumpState(raw), `prefix ${k} ${mode}`).toBe(happyDump);
          }
        }
      }
    },
  );

  it(
    'recovery restores the original schema and data from every state, and the re-run then equals a clean run',
    LONG,
    async () => {
      let swapped = 0;
      for (let k = 0; k <= statements.length; k++) {
        const raw = cloneBase();
        runPrefix(raw, statements, k);
        if (hasTable(raw, 'integrations_old') || hasTable(raw, 'deliveries_old')) swapped++;
        const plan = await recover(raw);
        expect(plan.blockers, `prefix ${k}`).toEqual([]);
        expectNoLoss(raw, `prefix ${k}`);
        expectOriginalsLive(raw, `prefix ${k}`);
        expect(scratchObjects(raw), `prefix ${k}`).toEqual([]);
        expectSchemaRestored(raw, `prefix ${k}`);
        // The tenant triggers of `sources` are back, naming the live table.
        expect(
          (
            raw.prepare("SELECT sql FROM sqlite_master WHERE name='sources_delete_integrations'").get() as {
              sql: string;
            }
          ).sql,
          `prefix ${k}`,
        ).toContain('DELETE FROM integrations WHERE');
        // Idempotent: nothing left to do.
        expect((await planRecovery(over(raw))).statements).toEqual([]);
        expect(runSql(raw, migrationSql(), 'abort'), `prefix ${k}`).toEqual([]);
        expect(dumpState(raw), `prefix ${k}`).toBe(happyDump);
      }
      expect(swapped).toBeGreaterThan(60);
    },
  );

  it('recovers a sabotaged, carried-on run, and a clean run that has not yet seen traffic', async () => {
    for (const table of TABLES) {
      const raw = cloneBase();
      runSql(raw, migrationSql().replace(VERIFY, `${lostDelivery(table)}${VERIFY}`), 'continue');
      await recover(raw);
      expectOriginalsLive(raw, table);
      expectSchemaRestored(raw, table);
    }
    const { raw } = happy();
    expect((await recover(raw)).restored).toHaveLength(TABLES.length);
    expectOriginalsLive(raw);
    expectNoLoss(raw);
    expect(runSql(raw, migrationSql(), 'abort')).toEqual([]);
    expect(dumpState(raw)).toBe(happyDump);
  });

  it('refuses to discard a write made after the swap, and does so only on request', async () => {
    const { raw } = happy();
    raw
      .prepare(
        "INSERT INTO deliveries(id,integration_id,state,organization_id,created_at) VALUES('d-traffic','i-ok','sent','org-a','2026-03-01')",
      )
      .run();
    const refused = await planRecovery(over(raw));
    expect(refused.blockers.join('\n')).toMatch(/deliveries holds 1 row/);
    expect(hasTable(raw, 'deliveries_old')).toBe(true);
    const forced = await recover(raw, true);
    expect(forced.notes.join('\n')).toMatch(/discarding 1 row/);
    expectOriginalsLive(raw);
  });
});

describe('finalize: the only step that drops the originals', () => {
  it('reconciles a clean run, drops only after --apply, and is idempotent', async () => {
    const { raw } = happy();
    const check = await finalize(over(raw));
    expect(check.status).toBe('reconciled');
    expect(check.removed).toEqual(
      expect.arrayContaining(['integrations_old', 'noise_open_failures_old', '_snapshot_0026']),
    );
    expect(hasTable(raw, 'integrations_old')).toBe(true);
    const done = await finalize(over(raw), { apply: true });
    expect(done.status).toBe('finalized');
    expect(tableNames(raw).filter((n) => n.endsWith('_old') || n.startsWith('_snapshot'))).toEqual([]);
    expect(contracted(raw, 'deliveries')).toBe(true);
    expect(countRows(raw, 'legacy_orphaned_rows')).toBeGreaterThan(0);
    expect((await finalize(over(raw), { apply: true })).status).toBe('nothing_to_finalize');
    // A migration run after finalize starts a new cycle and leaves `_old` again.
    expect(runSql(raw, migrationSql(), 'abort')).toEqual([]);
    expect(hasTable(raw, 'deliveries_old')).toBe(true);
  });

  it('refuses, dropping nothing, when a kept row changed, a row is live-only, or foreign keys are off', async () => {
    const changed = happy().raw;
    changed.exec("UPDATE deliveries SET state='failed' WHERE id='d-set'");
    const a = await finalize(over(changed), { apply: true });
    expect(a.status).toBe('refused');
    expect(a.review.join('\n')).toContain('deliveries: changed=1');
    expect(hasTable(changed, 'deliveries_old')).toBe(true);

    const extra = happy().raw;
    extra.exec(
      "INSERT INTO deliveries(id,integration_id,state,organization_id) VALUES('d-new','i-ok','sent','org-a')",
    );
    expect((await finalize(over(extra), { apply: true })).blockers.join('\n')).toMatch(
      /missing from the live table/,
    );

    const off = happy().raw;
    off.exec('PRAGMA foreign_keys=OFF');
    const b = await finalize(over(off), { apply: true });
    expect(b.status).toBe('refused');
    expect(b.blockers.join('\n')).toContain('PRAGMA foreign_keys is not 1');
    expect(hasTable(off, 'deliveries_old')).toBe(true);
  });

  it('accepts post-traffic drift only with the exact counts, lists the ids, and drops nothing without --apply', async () => {
    const { raw } = happy();
    // A write that a count never shows (the dead-letter consumer marking a delivery during the freeze) ...
    raw.exec("UPDATE deliveries SET state='failed' WHERE id='d-set'");
    // ... and a row the original never had.
    raw.exec(
      "INSERT INTO deliveries(id,integration_id,state,organization_id) VALUES('d-new','i-ok','sent','org-a')",
    );
    const refused = await finalize(over(raw), { ackDrift: 1 });
    expect(refused.status).toBe('refused');
    expect(refused.blockers.join('\n')).toContain('--ack-changed 1');
    expect(refused.review.join('\n')).toContain('deliveries changed ids (first 20): d-set');
    expect(refused.review.join('\n')).toContain('deliveries live_only ids (first 20): d-new');
    expect((await finalize(over(raw), { ackChanged: 1 })).blockers.join('\n')).toContain('--ack-drift 1');
    expect((await finalize(over(raw), { ackDrift: 2, ackChanged: 1 })).status).toBe('refused');
    expect((await finalize(over(raw), { ackDrift: 1, ackChanged: 1 })).status).toBe('reconciled');
    expect(hasTable(raw, 'deliveries_old')).toBe(true);
    expect((await finalize(over(raw), { ackDrift: 1, ackChanged: 1, apply: true })).status).toBe('finalized');
    expect(hasTable(raw, 'deliveries_old')).toBe(false);
  });

  it('never accepts an EMPTY live table over a non-empty original, whatever is acknowledged', async () => {
    const { raw } = happy();
    raw.exec('DELETE FROM held_events');
    const result = await finalize(over(raw), { ackDrift: 1, ackChanged: 0, apply: true });
    expect(result.status).toBe('refused');
    expect(result.blockers.join('\n')).toContain('held_events: the live table is EMPTY');
    expect(hasTable(raw, 'held_events_old')).toBe(true);
  });

  it('allows an empty live table when every original row was quarantined', async () => {
    const { raw } = happy();
    raw.exec('DELETE FROM noise_open_failures');
    raw.exec("DELETE FROM noise_open_failures_old WHERE organization_id='org-a'");
    const result = await finalize(over(raw));
    expect(result.blockers.join('\n')).not.toContain('noise_open_failures: the live table is EMPTY');
    expect(result.status).toBe('reconciled');
  });

  it('lists the ids of originals that vanished without a quarantine entry', async () => {
    const { raw } = happy();
    raw.exec("DELETE FROM deliveries WHERE id='d-set'");
    const result = await finalize(over(raw), { ackDrift: 1 });
    expect(result.status).toBe('reconciled');
    expect(result.review.join('\n')).toContain(
      'deliveries missing (no live row, no quarantine entry) ids (first 20): d-set',
    );
  });

  it('refuses a half-restored state and a deleted kept row', async () => {
    const { raw } = happy();
    raw.exec('DROP TABLE held_events_old');
    const half = await finalize(over(raw), { apply: true });
    expect(half.status).toBe('refused');
    expect(half.blockers.join('\n')).toContain('only 5 of 6');

    const lost = happy().raw;
    lost.exec("DELETE FROM deliveries WHERE id='d-set'");
    const missing = await finalize(over(lost), { apply: true });
    expect(missing.status).toBe('refused');
    expect(missing.review.join('\n')).toContain('missing=1');
    expect(hasTable(lost, 'deliveries_old')).toBe(true);
  });

  it('cleans scratch left by a run that tripped before swapping, and reports nothing to do on a clean database', async () => {
    const raw = cloneBase({ foreignKeys: false });
    runSql(raw, migrationSql(), 'abort');
    raw.exec('PRAGMA foreign_keys=ON');
    expect(scratchObjects(raw).length).toBeGreaterThan(0);
    expect((await finalize(over(raw), { apply: true })).status).toBe('finalized');
    expect(scratchObjects(raw)).toEqual([]);
    expect((await finalize(over(cloneBase()), { apply: true })).status).toBe('nothing_to_finalize');
  });
});

describe('modes are what they claim', () => {
  it('abort stops at the first error and continue does not', () => {
    const a = cloneBase({ foreignKeys: false });
    const c = cloneBase({ foreignKeys: false });
    const modes: Mode[] = ['abort', 'continue'];
    const errors = modes.map((m) => runSql(m === 'abort' ? a : c, migrationSql(), m).length);
    expect(errors[0]).toBe(1);
    expect(errors[1]).toBeGreaterThan(20);
  });
});
