import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyMigration, createFakeD1 } from './support/d1';
import { seedLegacy } from './support/legacy-0026';

/** scripts/migration-0026-preflight.sql and .mjs: what an operator must read before applying 0026. */
interface Check {
  check: string;
  n: number;
}
interface Preflight {
  ROW_CEILING: number;
  rowsOf: (raw: unknown) => Check[];
  evaluate: (
    rows: Check[],
    options?: { ackOrphans?: number | null },
  ) => { ok: boolean; blockers: string[]; review: string[]; orphanTotal: number };
}
const scriptPath = '../scripts/migration-0026-preflight.mjs';
const { ROW_CEILING, rowsOf, evaluate } = (await import(/* @vite-ignore */ scriptPath)) as Preflight;
const SQL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'migration-0026-preflight.sql'),
  'utf8',
);

/** The file is many statements (workerd allows at most 5 compound SELECT terms each); run them all. */
const STATEMENTS = SQL.replace(/--[^\n]*/g, '')
  .split(/;\s*(?:\n|$)/)
  .map((x) => x.trim())
  .filter((x) => x.length > 0);
const runAll = (raw: ReturnType<typeof createFakeD1>['raw']): Check[] =>
  STATEMENTS.flatMap((statement) => raw.prepare(statement).all() as unknown as Check[]);

function preflight(): { rows: Check[]; truth: number } {
  const { raw } = createFakeD1({ before: '0026' });
  seedLegacy(raw);
  const rows = runAll(raw);
  applyMigration(raw, '0026_tenant_contract.sql');
  const truth = (raw.prepare('SELECT COUNT(*) AS n FROM legacy_orphaned_rows').get() as { n: number }).n;
  return { rows, truth };
}
const get = (rows: Check[], check: string): number => rows.find((r) => r.check === check)?.n ?? -1;

describe('migration 0026 preflight', () => {
  it('reports the counts an operator must review, and its orphan estimate equals what the migration quarantines', () => {
    const { rows, truth } = preflight();
    expect(get(rows, 'total:integrations')).toBe(8);
    expect(get(rows, 'total:deliveries')).toBe(7);
    expect(get(rows, 'orphan:integrations')).toBe(5); // orphan, dangling, empty, long and the case-mismatched one
    expect(rows.filter((r) => r.check.startsWith('orphan:')).reduce((s, r) => s + r.n, 0)).toBe(truth);
    expect(get(rows, 'case_mismatch:integrations')).toBe(1);
    expect(get(rows, 'review:delivery_org_differs_from_integration_org')).toBe(1);
  });

  it('is read-only', () => {
    expect(SQL.replace(/--[^\n]*/g, '')).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i);
  });

  it('blocks until the exact orphan count is acknowledged', () => {
    const { rows, truth } = preflight();
    const blocked = evaluate(rows);
    expect(blocked.ok).toBe(false);
    expect(blocked.blockers.join('\n')).toContain(`--ack-orphans ${truth}`);
    expect(evaluate(rows, { ackOrphans: truth - 1 }).ok).toBe(false);
    const acknowledged = evaluate(rows, { ackOrphans: truth });
    expect(acknowledged.ok).toBe(true);
    expect(acknowledged.review.join('\n')).toMatch(/only by case/);
    expect(acknowledged.review.join('\n')).toMatch(/delivery_org_differs_from_integration_org/);
  });

  it('passes a clean database with no acknowledgement', () => {
    const { raw } = createFakeD1({ before: '0026' });
    const rows = runAll(raw);
    expect(evaluate(rows)).toMatchObject({ ok: true, blockers: [], orphanTotal: 0 });
  });

  it('blocks a table above the size ceiling whatever is acknowledged', () => {
    const rows = [{ check: 'total:deliveries', n: ROW_CEILING + 1 }];
    const result = evaluate(rows, { ackOrphans: 0 });
    expect(result.ok).toBe(false);
    expect(result.blockers.join('\n')).toContain('above the ceiling');
  });

  it('refuses output it cannot read', () => {
    expect(evaluate(rowsOf({ not: 'wrangler output' })).ok).toBe(false);
    const wrangler = [{ results: [{ check: 'total:deliveries', n: 3 }], success: true }];
    expect(rowsOf(wrangler)).toEqual([{ check: 'total:deliveries', n: 3 }]);
  });
});

describe('migration 0026 preflight prediction equals the migration (M3)', () => {
  const perTable = (rows: Check[]) =>
    Object.fromEntries(rows.filter((r) => r.check.startsWith('orphan:')).map((r) => [r.check.slice(7), r.n]));
  const actual = (raw: ReturnType<typeof createFakeD1>['raw']) =>
    Object.fromEntries(
      (
        raw.prepare('SELECT source_table AS t, COUNT(*) AS n FROM legacy_orphaned_rows GROUP BY 1').all() as {
          t: string;
          n: number;
        }[]
      ).map((r) => [r.t, r.n]),
    );
  const withZeros = (o: Record<string, number>) => ({
    integrations: 0,
    deliveries: 0,
    notification_outbox: 0,
    held_events: 0,
    routing_decisions: 0,
    noise_open_failures: 0,
    ...o,
  });

  it('counts rows derived to a dangling or case-mismatched organization as quarantined', () => {
    const { raw } = createFakeD1({ before: '0026' });
    seedLegacy(raw);
    // Rows whose integration has a dangling / case-mismatched organization: the migration derives the
    // bad id, copies nothing valid, and quarantines them.
    raw.exec(`
      INSERT INTO deliveries(id,integration_id,state,organization_id,created_at) VALUES
        ('d-to-ghost','i-dangling','sent',NULL,'2026-01-06'), ('d-to-case','i-case','sent','','2026-01-06');
      INSERT INTO notification_outbox(id,payload_json,state,organization_id) VALUES
        ('o-to-ghost','{"integrationId":"i-dangling"}','pending',NULL), ('d-to-case','{}','pending',NULL);
    `);
    const predicted = perTable(runAll(raw));
    applyMigration(raw, '0026_tenant_contract.sql');
    expect(withZeros(predicted)).toEqual(withZeros(actual(raw)));
  });

  it('matches on pseudo-random legacy data', () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const orgs: (string | null)[] = [null, '', 'org-a', 'org-b', 'ghost', 'ORG-A'];
    for (let round = 0; round < 25; round++) {
      const { raw } = createFakeD1({ before: '0026' });
      seedLegacy(raw);
      raw.exec('DELETE FROM notification_outbox; DELETE FROM deliveries; DELETE FROM integrations');
      for (let i = 0; i < 8; i++) {
        raw
          .prepare(
            'INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id,source_id) VALUES(?,?,?,?,?,?,?)',
          )
          .run(
            `i${i}`,
            'r',
            '[]',
            'slack',
            'x',
            orgs[rnd(orgs.length)] ?? null,
            rnd(3) === 0 ? 'src-a' : null,
          );
        raw
          .prepare('INSERT INTO deliveries(id,integration_id,state,organization_id) VALUES(?,?,?,?)')
          .run(`d${i}`, `i${rnd(10)}`, 'sent', orgs[rnd(orgs.length)] ?? null);
        raw
          .prepare('INSERT INTO notification_outbox(id,payload_json,state,organization_id) VALUES(?,?,?,?)')
          .run(
            `d${rnd(10)}x${i}`,
            rnd(2) ? `{"integrationId":"i${rnd(10)}"}` : 'nope',
            'pending',
            orgs[rnd(orgs.length)] ?? null,
          );
      }
      const predicted = perTable(runAll(raw));
      applyMigration(raw, '0026_tenant_contract.sql');
      expect(withZeros(predicted), `round ${round}`).toEqual(withZeros(actual(raw)));
    }
  });
});
