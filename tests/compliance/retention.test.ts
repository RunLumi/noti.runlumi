import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DATA_CATEGORIES,
  LEDGER_TABLES_OUTLIVING_PURGE,
  NOT_STORED,
  OPERATOR_TO_DECIDE,
  PLATFORM_STORES,
  RETENTION_MATRIX,
  type Deletion,
} from '../../src/compliance/retention';
import { renderRetentionDoc } from '../../src/compliance/render-retention';
import { JOB_CADENCE } from '../../src/observability/cadence';
import {
  DRAINED_BEFORE_ORGANIZATION_DELETE,
  DRAINED_VIA_INSTALLATION,
  LEGACY_OLD_TABLES,
  TENANT_TABLES,
} from '../../src/pipeline/purge';
import { AUDIT_RETENTION, DELIVERY_RETENTION } from '../../src/pipeline/retention';
import { createFakeD1 } from '../support/d1';

/**
 * F237: the retention matrix is complete and truthful. New tables force a retention decision,
 * and every removal mechanism a row claims must exist in the schema or in the code.
 */
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

/** Every `.ts` file under a directory of the repository, as repository-relative paths. */
function sourceFiles(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(rel);
    return entry.name.endsWith('.ts') ? [rel] : [];
  });
}

const { raw } = createFakeD1();

interface TableInfo {
  name: string;
}
interface ForeignKey {
  table: string;
  on_delete: string;
}

const tables = (
  raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as unknown as TableInfo[]
).map((t) => t.name);

const columnsOf = (table: string): string[] =>
  (raw.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as unknown as TableInfo[]).map(
    (c) => c.name,
  );

const foreignKeys = (table: string): ForeignKey[] =>
  raw
    .prepare(`SELECT "table", on_delete FROM pragma_foreign_key_list('${table}')`)
    .all() as unknown as ForeignKey[];

const deletions = (kind: Deletion['kind']) =>
  RETENTION_MATRIX.flatMap((row) => row.deletion.filter((d) => d.kind === kind).map((d) => ({ row, d })));

describe('retention matrix completeness', () => {
  it('has a row for every table the migrations create, and no row for a table that does not exist', () => {
    const covered = new Set(RETENTION_MATRIX.map((r) => r.table));
    expect(tables.filter((t) => !covered.has(t))).toEqual([]);
    expect([...covered].filter((t) => !tables.includes(t))).toEqual([]);
  });

  it('has unique row ids and known categories', () => {
    const ids = RETENTION_MATRIX.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of RETENTION_MATRIX) expect(DATA_CATEGORIES, row.id).toContain(row.category);
  });

  it('accounts for every column of a table that is split into column families, exactly once', () => {
    for (const table of tables) {
      const rows = RETENTION_MATRIX.filter((r) => r.table === table);
      if (rows.every((r) => r.columns === undefined)) {
        expect(rows.length, `${table} has one row`).toBe(1);
        continue;
      }
      expect(
        rows.every((r) => r.columns !== undefined),
        `${table}: split tables list columns on every row`,
      ).toBe(true);
      const listed = rows.flatMap((r) => r.columns ?? []);
      const real = columnsOf(table);
      expect(
        listed.filter((c) => !real.includes(c)),
        `${table}: unknown columns`,
      ).toEqual([]);
      // key_salt, dek_wrapped and kek_version are credential columns and appear in the credentials family only.
      expect(
        real.filter((c) => !listed.includes(c)),
        `${table}: columns missing from the matrix`,
      ).toEqual([]);
      expect(listed.length, `${table}: a column is listed twice`).toBe(new Set(listed).size);
    }
  });

  it('leaves every legal-basis and role field to the operator', () => {
    for (const row of RETENTION_MATRIX) {
      expect(row.legalBasis, row.id).toBe(OPERATOR_TO_DECIDE);
      expect(row.controllerRole, row.id).toBe(OPERATOR_TO_DECIDE);
    }
  });

  it('states a deletion mechanism, a retention and an export position for every row', () => {
    for (const row of RETENTION_MATRIX) {
      expect(row.deletion.length, row.id).toBeGreaterThan(0);
      expect(row.dataHeld.length, row.id).toBeGreaterThan(10);
      expect(row.purpose.length, row.id).toBeGreaterThan(10);
    }
    expect(PLATFORM_STORES.length).toBeGreaterThan(0);
  });

  it('never exports sealed credentials or anything from a credential-bearing family', () => {
    for (const row of RETENTION_MATRIX.filter((r) => r.category === 'tenant_credential_sealed')) {
      expect(row.inWorkspaceExport, row.id).toBe(false);
      expect(row.inAccountExport, row.id).toBe(false);
    }
  });
});

describe('every claimed removal mechanism exists', () => {
  it('cron_job: the job is scheduled in src/index.ts and its source file deletes from the table', () => {
    const scheduled = new Set([...read('src/index.ts').matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1]));
    const files: Record<string, string> = {
      expired_auth_purge: 'src/pipeline/expired-records.ts',
      retention_purge: 'src/pipeline/retention.ts',
      outbox_reconcile: 'src/delivery/claim.ts',
      routing_decisions_purge: 'src/routing/provenance.ts',
      noise_purge: 'src/routing/noise-store.ts',
      dedup_purge: 'src/delivery/dedup.ts',
      rate_limit_prune: 'src/security/rate-limit.ts',
    };
    const claims = deletions('cron_job');
    expect(claims.length).toBeGreaterThan(0);
    for (const { row, d } of claims) {
      if (d.kind !== 'cron_job') continue;
      expect(scheduled.has(d.job), `${row.id}: ${d.job} is not scheduled`).toBe(true);
      const file = files[d.job];
      expect(file, `${row.id}: no source file known for ${d.job}`).toBeDefined();
      const source = read(file ?? '');
      const deletesFrom = new RegExp(
        `DELETE FROM (${row.table}|\\$\\{OUTBOX_TABLE\\}|\\$\\{table\\}|"?${row.table}"?)`,
      );
      const viaConstant = row.table === 'notification_outbox' && source.includes('${OUTBOX_TABLE}');
      expect(
        deletesFrom.test(source) || viaConstant,
        `${row.id}: ${file} never deletes from ${row.table}`,
      ).toBe(true);
    }
  });

  it('workspace_purge: the route is backed by the purge code', () => {
    for (const { row, d } of deletions('workspace_purge')) {
      if (d.kind !== 'workspace_purge') continue;
      switch (d.route) {
        case 'tenant_tables':
          expect(TENANT_TABLES as readonly string[], row.id).toContain(row.table);
          break;
        case 'drained':
          expect(DRAINED_BEFORE_ORGANIZATION_DELETE as readonly string[], row.id).toContain(row.table);
          break;
        case 'via_installation':
          expect(DRAINED_VIA_INSTALLATION as readonly string[], row.id).toContain(row.table);
          break;
        case 'legacy_old':
          expect(LEGACY_OLD_TABLES as readonly string[], row.id).toContain(row.table);
          break;
        case 'organization_delete':
          expect(row.table).toBe('organization');
          expect(read('src/pipeline/purge.ts')).toContain('DELETE FROM organization WHERE id=?');
          break;
      }
    }
  });

  it('fk_cascade: the migrations declare ON DELETE CASCADE to that parent', () => {
    const claims = deletions('fk_cascade');
    expect(claims.length).toBeGreaterThan(0);
    for (const { row, d } of claims) {
      if (d.kind !== 'fk_cascade') continue;
      const parent = d.parent === 'user' ? 'user' : d.parent === 'organization' ? 'organization' : d.parent;
      const found = foreignKeys(row.table).some((fk) => fk.table === parent && fk.on_delete === 'CASCADE');
      expect(found, `${row.id}: no ON DELETE CASCADE to ${parent}`).toBe(true);
    }
  });

  it('customer_delete: an API route deletes from the table', () => {
    const api = `${read('src/api/integrations.ts')}\n${read('src/api/sources.ts')}`;
    for (const { row } of deletions('customer_delete')) {
      expect(api, row.id).toContain(`DELETE FROM ${row.table}`);
    }
  });

  it('account_erasure: the route exists and each table is reached by it or by a cascade', () => {
    const route = read('src/api/account.ts');
    for (const { row } of deletions('account_erasure')) {
      const cascades = foreignKeys(row.table).some((fk) => fk.table === 'user' && fk.on_delete === 'CASCADE');
      const explicit =
        route.includes(`DELETE FROM "${row.table}"`) || route.includes(`DELETE FROM ${row.table}`);
      expect(cascades || explicit, `${row.id}: not reached by DELETE /api/workspace/me`).toBe(true);
    }
  });
});

describe('workspace purge covers every tenant table', () => {
  it('purges, or deliberately keeps as a ledger, every table that has an organization_id column', () => {
    const purged = new Set<string>([
      ...TENANT_TABLES,
      ...DRAINED_BEFORE_ORGANIZATION_DELETE,
      ...LEGACY_OLD_TABLES,
      ...tables.filter((t) =>
        foreignKeys(t).some((fk) => fk.table === 'organization' && fk.on_delete === 'CASCADE'),
      ),
    ]);
    const tenantScoped = tables.filter((t) => columnsOf(t).some((c) => c === 'organization_id'));
    const unhandled = tenantScoped.filter(
      (t) => !purged.has(t) && !LEDGER_TABLES_OUTLIVING_PURGE.includes(t),
    );
    expect(unhandled).toEqual([]);
    for (const ledger of LEDGER_TABLES_OUTLIVING_PURGE) {
      expect(RETENTION_MATRIX.find((r) => r.table === ledger)?.retention.kind).toBe('indefinite');
    }
  });
});

describe('temporary tables', () => {
  it('every `<table>_old` has a temporary retention with a stated drop-by, and the doc says so', () => {
    const rows = RETENTION_MATRIX.filter((r) => r.retention.kind === 'temporary');
    expect(rows.map((r) => r.table).sort()).toEqual([...LEGACY_OLD_TABLES, '_snapshot_0026'].sort());
    for (const r of rows) {
      expect(r.retention.kind === 'temporary' && r.retention.dropBy).toMatch(/migration-0026-finalize/);
    }
    expect(renderRetentionDoc()).toContain('TEMPORARY.');
  });
});

describe('periods are the ones the code and the configuration use', () => {
  const wrangler = read('wrangler.jsonc');
  const variable = (name: string): string | undefined =>
    new RegExp(`"${name}":\\s*"(\\d+)"`).exec(wrangler)?.[1];

  it('matches the Worker vars and bounds for the configurable stores', () => {
    const day = 86_400_000;
    const expected = {
      DELIVERY_RETENTION_DAYS: DELIVERY_RETENTION,
      AUDIT_RETENTION_DAYS: AUDIT_RETENTION,
    } as const;
    const configurable = RETENTION_MATRIX.filter((r) => r.retention.kind === 'configurable');
    expect(configurable.map((r) => r.id).sort()).toEqual(['audit_events', 'deliveries', 'delivery_attempts']);
    for (const row of configurable) {
      if (row.retention.kind !== 'configurable') continue;
      const bounds = expected[row.retention.variable as keyof typeof expected];
      expect(row.retention.defaultMs).toBe(bounds.default * day);
      expect(row.retention.minMs).toBe(bounds.min * day);
      expect(row.retention.maxMs).toBe(bounds.max * day);
      expect(Number(variable(row.retention.variable)), `${row.retention.variable} in wrangler.jsonc`).toBe(
        bounds.default,
      );
    }
  });

  it('keeps the documented session lifetime in step with the auth configuration', () => {
    const session = RETENTION_MATRIX.find((r) => r.id === 'session');
    // The row's period is the outer bound (90 days after sign-in); the 30-day idle expiry is in the notes.
    expect(session?.retention).toMatchObject({ kind: 'until_expiry', expiryMs: 90 * 86_400_000 });
    expect(session?.notes).toContain('30 days after its last refresh');
    expect(read('src/auth/better-auth.ts')).toContain('expiresIn: SESSION_EXPIRES_IN_SECONDS');
    expect(read('src/auth/session-policy.ts')).toContain('SESSION_ABSOLUTE_SECONDS = 60 * 60 * 24 * 90');
  });
});

describe('a fixed period names a constant that the code really uses', () => {
  it('cites an exported constant in the file it names, and that constant is used by the purge code', () => {
    const fixed = RETENTION_MATRIX.filter((r) => r.retention.kind === 'fixed');
    expect(fixed.length).toBeGreaterThan(5);
    for (const row of fixed) {
      if (row.retention.kind !== 'fixed') continue;
      const match = /^([A-Z][A-Z0-9_]+) \((src\/[^)]+)\)$/.exec(row.retention.basis);
      expect(match, `${row.id}: basis "${row.retention.basis}" names a constant and a file`).not.toBeNull();
      if (!match) continue;
      const name = match[1] ?? '';
      const file = match[2] ?? '';
      const mentions = (path: string): number =>
        (read(path).match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length;
      expect(read(file), `${row.id}: ${file} exports ${name}`).toMatch(new RegExp(`export const ${name}\\b`));
      // The declaration counts once; a use is any other mention in the file or in another source file
      // outside the matrix, so a purge that hard-codes its own number leaves the constant unused.
      const elsewhere = sourceFiles('src')
        .filter((path) => path !== file && !path.startsWith('src/compliance/'))
        .reduce((sum, path) => sum + mentions(path), 0);
      expect(
        mentions(file) - 1 + elsewhere,
        `${row.id}: ${name} is used by the purge code`,
      ).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('every purge job is also watched for staleness', () => {
  it('each cron job that deletes data is in the cadence table the job_stale alert reads (F190, F192)', () => {
    const jobs = deletions('cron_job');
    expect(jobs.length).toBeGreaterThan(0);
    for (const { row, d } of jobs) {
      if (d.kind !== 'cron_job') continue;
      expect(Object.keys(JOB_CADENCE), `${row.id}: ${d.job}`).toContain(d.job);
    }
  });
});

describe('data the spec lists that the code does not store', () => {
  it('records each as a decision, with an id and a reason', () => {
    expect(new Set(NOT_STORED.map((n) => n.id)).size).toBe(NOT_STORED.length);
    for (const n of NOT_STORED) expect(n.reason.length, n.id).toBeGreaterThan(30);
  });

  it('has no table for the object-level dedup the spec mentions, and no column for a provider body', () => {
    expect(tables).not.toContain('semantic_dedup');
    const bodies = tables.flatMap((t) =>
      columnsOf(t)
        // A body or a raw payload is stored as itself; `body_hash` (a digest) is not one.
        .filter((c) => /(^raw|raw_|_raw$|^body$|_body$|request_json|response_json)/i.test(c))
        .map((c) => `${t}.${c}`),
    );
    expect(bodies).toEqual([]);
  });

  it('is rendered into the doc', () => {
    expect(renderRetentionDoc()).toContain('## Not stored (spec rows that do not apply)');
  });
});

describe('docs/DATA_RETENTION.md', () => {
  it('is the generator output (run `npm run docs:retention`)', () => {
    expect(read('docs/DATA_RETENTION.md')).toBe(renderRetentionDoc());
  });

  it('names every table, and discloses what is not enforced', () => {
    const doc = renderRetentionDoc();
    for (const table of tables) expect(doc).toContain(`\`${table}\``);
    expect(doc).toContain('NOT ENFORCED');
    expect(doc).toContain('Time Travel');
    expect(doc).toContain('No formal security audit has been performed');
  });
});
