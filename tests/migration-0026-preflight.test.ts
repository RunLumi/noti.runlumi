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

function preflight(): { rows: Check[]; truth: number } {
  const { raw } = createFakeD1({ before: '0026' });
  seedLegacy(raw);
  const rows = raw.prepare(SQL).all() as unknown as Check[];
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
    const rows = raw.prepare(SQL).all() as unknown as Check[];
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
