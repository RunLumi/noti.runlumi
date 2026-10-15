import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { auditStatement } from '../../src/audit/audit';
import { OUTBOX_TABLE } from '../../src/delivery/claim';
import { DRAINED_BEFORE_ORGANIZATION_DELETE, TENANT_TABLES } from '../../src/pipeline/purge';
import { createFakeD1, seedOrganization } from '../support/d1';

/**
 * F236 (ADR 0039): `audit_events` is append-only, and the proof is in code.
 *
 * D1 has no per-table grants, and the schema (migration 0008) refuses UPDATE but not DELETE, because the
 * retention purge and the organization purge delete by design. So "no UPDATE or DELETE against audit_events"
 * is enforced by two things, both here:
 *
 *  1. A static scan of `src/` and `scripts/`. Every string literal and template is read from the TypeScript
 *     AST. A statement that names `audit_events` after UPDATE or DELETE FROM is a violation unless it is in
 *     the explicit allow-list below, with its reason. A statement whose table is an interpolation (`${x}`) is
 *     classified too: each such site is listed, and the tables it can reach are checked against the constants.
 *  2. A behavioural check on the real migrations: the trigger refuses UPDATE, and the writer's rows survive a
 *     refused update unchanged.
 *
 * LIMITS (also in docs/adr/0039): SQL assembled from pieces at run time that the scan cannot see (a `+` of
 * non-literal pieces other than the trailing keyword), and any change made outside this repository, are not
 * covered. A new DELETE of audit_events fails this test until it is added here with a reason.
 */
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

interface Site {
  readonly file: string;
  readonly keyword: 'UPDATE' | 'DELETE FROM';
  readonly kind: 'literal' | 'dynamic';
  readonly line: number;
}

/** Literal statements that may name audit_events in UPDATE or DELETE. Nothing may UPDATE it. */
const ALLOWED_LITERAL_SITES: ReadonlyArray<Pick<Site, 'file' | 'keyword'> & { reason: string }> = [
  {
    file: 'src/pipeline/retention.ts',
    keyword: 'DELETE FROM',
    reason:
      'PURGE_AUDIT_SQL: the audit retention window (AUDIT_RETENTION_DAYS, F237). It deletes by age only, and never a key.destroy row.',
  },
];

/**
 * Interpolated table names that can reach audit_events. Each entry is a function of the constants below, so a
 * change to any of them fails the test.
 */
const ALLOWED_DYNAMIC_SITES: ReadonlyArray<Pick<Site, 'file' | 'keyword'> & { reason: string }> = [
  {
    file: 'src/pipeline/purge.ts',
    keyword: 'DELETE FROM',
    reason:
      'boundedDeletes: the organization purge drains audit_events in bounded rounds before the organization row is removed (DRAINED_BEFORE_ORGANIZATION_DELETE). The workspace it removes is the one that is being deleted.',
  },
  {
    file: 'src/delivery/claim.ts',
    keyword: 'UPDATE',
    reason:
      'The outbox claim, dispatch and release statements: their table is OUTBOX_TABLE (notification_outbox).',
  },
  {
    file: 'src/delivery/claim.ts',
    keyword: 'DELETE FROM',
    reason: 'PURGE_OUTBOX_SQL: the outbox table, OUTBOX_TABLE (notification_outbox).',
  },
  {
    file: 'src/pipeline/expired-records.ts',
    keyword: 'DELETE FROM',
    reason: 'boundedDelete: the auth and session tables, passed as literals (checked below).',
  },
];

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return /\.(ts|mjs|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

/**
 * Every string-like piece of a file: plain literals, template literals, and the text of each template
 * interpolation position, which is a `\uE000` placeholder (a private-use character, so no regex needs a control character). Comments are not string literals, so they are not
 * read at all.
 */
function sqlPieces(file: string, text: string): { line: number; text: string }[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: { line: number; text: string }[] = [];
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push({ line: lineOf(node), text: node.text });
    } else if (ts.isTemplateExpression(node)) {
      const joined = [node.head.text, ...node.templateSpans.map((s) => `\uE000${s.literal.text}`)].join('');
      out.push({ line: lineOf(node), text: joined });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Where UPDATE or DELETE FROM names a table: a literal table, an interpolated one, or a `+` concatenation. */
function sitesIn(file: string, source: string): Site[] {
  const rel = file.slice(root.length + 1);
  return sqlPieces(file, source).flatMap(({ line, text }) => {
    const found: Site[] = [];
    const literal = /\b(UPDATE|DELETE\s+FROM)\s+["`]?audit_events\b/gi;
    for (const m of text.matchAll(literal)) {
      found.push({ file: rel, keyword: normaliseKeyword(m[1] ?? ''), kind: 'literal', line });
    }
    // Keywords are upper case in this repository's SQL; a lower-case "update ..." in prose is not a statement.
    const dynamic = /\b(UPDATE|DELETE FROM)\s+["`]?\uE000/g;
    for (const m of text.matchAll(dynamic)) {
      found.push({ file: rel, keyword: normaliseKeyword(m[1] ?? ''), kind: 'dynamic', line });
    }
    // A statement assembled by `+`: the keyword ends one literal and the table is the next expression.
    if (/\b(UPDATE|DELETE FROM)\s*$/.test(text) && text.length > 0) {
      const keyword = /DELETE FROM\s*$/.test(text) ? 'DELETE FROM' : 'UPDATE';
      found.push({ file: rel, keyword, kind: 'dynamic', line });
    }
    return found;
  });
}

function normaliseKeyword(raw: string): Site['keyword'] {
  return /^DELETE/i.test(raw) ? 'DELETE FROM' : 'UPDATE';
}

const scanned = ['src', 'scripts'].flatMap((dir) => listSourceFiles(join(root, dir)));
const allSites = scanned.flatMap((file) => sitesIn(file, readFileSync(file, 'utf8')));
const allowedKey = (s: Pick<Site, 'file' | 'keyword'>) => `${s.file}|${s.keyword}`;

describe('audit_events is append-only in code (F236)', () => {
  it('scans the code it claims to: every source file under src/ and scripts/', () => {
    expect(scanned.length).toBeGreaterThan(150);
    expect(scanned.some((f) => f.endsWith('src/pipeline/retention.ts'))).toBe(true);
    expect(scanned.some((f) => f.endsWith('scripts/force-destroy-revoked.mjs'))).toBe(true);
  });

  it('no statement UPDATEs audit_events, anywhere', () => {
    const updates = allSites.filter((s) => s.kind === 'literal' && s.keyword === 'UPDATE');
    expect(updates.map((s) => `${s.file}:${s.line}`)).toEqual([]);
  });

  it('a literal DELETE of audit_events is only the retention purge', () => {
    const literalDeletes = allSites.filter((s) => s.kind === 'literal' && s.keyword === 'DELETE FROM');
    const allowed = new Set(ALLOWED_LITERAL_SITES.map(allowedKey));
    const unexpected = literalDeletes.filter((s) => !allowed.has(allowedKey(s)));
    expect(unexpected.map((s) => `${s.file}:${s.line}`)).toEqual([]);
    expect(literalDeletes.map(allowedKey).sort()).toEqual(ALLOWED_LITERAL_SITES.map(allowedKey).sort());
  });

  it('every interpolated UPDATE or DELETE is a known site, so a new one must be reviewed', () => {
    const dynamic = allSites.filter((s) => s.kind === 'dynamic');
    const allowed = new Set(ALLOWED_DYNAMIC_SITES.map(allowedKey));
    const unknown = dynamic.filter((s) => !allowed.has(allowedKey(s)));
    expect(unknown.map((s) => `${s.file}:${s.line} ${s.keyword}`)).toEqual([]);
  });

  it('every allow-list entry still matches a real statement (no stale exceptions)', () => {
    const found = new Set(allSites.map(allowedKey));
    const stale = [...ALLOWED_LITERAL_SITES, ...ALLOWED_DYNAMIC_SITES].filter(
      (a) => !found.has(allowedKey(a)),
    );
    expect(stale.map(allowedKey)).toEqual([]);
  });

  it('the interpolated sites can reach audit_events only where it is allowed', () => {
    // The outbox constant, and the three tables boundedDeletes iterates over.
    expect(OUTBOX_TABLE).not.toBe('audit_events');
    expect(TENANT_TABLES).not.toContain('audit_events');
    expect(DRAINED_BEFORE_ORGANIZATION_DELETE).toContain('audit_events');
    // boundedDelete is called with literal table names: none of them is the audit log.
    const expired = readFileSync(join(root, 'src/pipeline/expired-records.ts'), 'utf8');
    const tables = [...expired.matchAll(/boundedDelete\('([a-z_]+)'/g)].map((m) => m[1] ?? '');
    expect(tables.length).toBeGreaterThan(0);
    expect(tables).not.toContain('audit_events');
  });

  it('the scan sees the statements it must catch and ignores what it must (a self-test on synthetic source)', () => {
    const sample = [
      "const a = `UPDATE audit_events SET action='x'`;",
      "const b = 'delete from AUDIT_EVENTS where 1';",
      'const c = `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table})`;',
      "const d = 'DELETE FROM ' + table;",
      "const e = 'INSERT INTO audit_events(id) VALUES(?)';",
      "const f = 'Failed to update the row'; // UPDATE audit_events in a comment is not a statement",
      "const g = 'SELECT 1 FROM audit_events';",
    ].join('\n');
    const sites = sitesIn('src/synthetic.ts', sample).map((s) => `${s.kind} ${s.keyword} ${s.line}`);
    expect(sites).toEqual([
      'literal UPDATE 1',
      'literal DELETE FROM 2',
      'dynamic DELETE FROM 3',
      'dynamic DELETE FROM 4',
    ]);
  });
});

describe('the migrated schema refuses UPDATE, and the writer rows survive a refused update', () => {
  it('UPDATE is refused by the append-only trigger; the row written by the writer is unchanged', async () => {
    const { raw, d1 } = createFakeD1();
    seedOrganization(raw, 'org-a');
    await auditStatement(d1, {
      organizationId: 'org-a',
      actorId: 'alice',
      action: 'source.update',
      subjectType: 'source',
      subjectId: 'src-1',
      outcome: 'success',
      metadata: { enabled: false },
    }).run();
    expect(() => raw.prepare("UPDATE audit_events SET action='access.denied'").run()).toThrow(/append-only/);
    expect(() => raw.prepare("UPDATE audit_events SET metadata_json='{}'").run()).toThrow(/append-only/);
    const row = raw.prepare('SELECT action, metadata_json FROM audit_events').get() as Record<string, string>;
    expect(row).toEqual({ action: 'source.update', metadata_json: '{"enabled":false}' });
  });

  it('the schema does not refuse DELETE: the retention and organization purges need it, so the scan above is the guard', () => {
    // Documented limit (ADR 0039). If a DELETE trigger is ever added, the purges must change first, and this test
    // must be rewritten with them.
    const { raw } = createFakeD1();
    expect(() => raw.exec("DELETE FROM audit_events WHERE action = 'nothing-matches'")).not.toThrow();
  });
});
