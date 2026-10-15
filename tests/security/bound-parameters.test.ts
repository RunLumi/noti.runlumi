import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Bound-parameter guard (docs/specs/01-platform-runtime.md F09: "no query interpolates user input;
 * bindings only"). A heuristic over source text, like the other static guards: it finds every SQL
 * string handed to `.prepare(` / `db.exec(` and every template literal that opens with an SQL verb,
 * in `src/**` and `scripts/*.mjs`, and requires each dynamic part to be one we have reviewed.
 *
 *  - A template literal may interpolate only a constant (ALL_CAPS) or an expression on
 *    {@link ALLOWED_FRAGMENTS}. A NEW interpolation fails with its text, so adding one is a reviewed
 *    decision with a reason, not an accident.
 *  - Every identifier an allowed fragment rests on must be DECLARED in the same file, from literals
 *    (or be a named parameter of a reviewed builder), and never from request-derived names.
 *  - A non-literal argument must be a constant, `x.sql` of a query builder, or on the reviewed list.
 *  - Nothing may follow a SQL string that extends it: `+`, `.concat(`, `.replace(`, `.join(`, ...
 *  - `prepare` may not be aliased (`const p = db.prepare`), because the guard could no longer see the call.
 *  - Whatever the allow-list says, an interpolated expression may never mention request-derived names.
 */
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function filesUnder(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? filesUnder(full, ext) : full.endsWith(ext) ? [full] : [];
  });
}

/**
 * Reviewed dynamic fragments, each built from code and never from a request. Keep this list SHORT;
 * the reason is the review.
 */
const ALLOWED_FRAGMENTS: Readonly<Record<string, string>> = {
  guard: 'a fixed WHERE clause chosen by a boolean (audit.ts, provenance.ts)',
  filters: "fixed ' AND ...' clauses with ? placeholders, one per filter that is set (audit-view.ts whereOf)",
  keyset: 'a fixed cursor clause chosen by whether a cursor exists (provenance.ts)',
  metadataColumn: "either '?' or the fixed json_object(?, changes()) chosen by a boolean option (audit.ts)",
  notLegacy: 'a fixed NOT EXISTS clause (github route)',
  suspended: "either 'CURRENT_TIMESTAMP' or 'NULL' (lifecycle.ts)",
  from: 'FROM_VIEW, or FROM_VIEW with the fixed INDEXED BY deliveries_org_correlation, chosen by whether a correlation filter exists (delivery-queries.ts)',
  table:
    'iterated from the TENANT_TABLES constant list (purge.ts) or passed as a literal (expired-records.ts)',
  column: 'passed as a literal by the boundedDelete callers (expired-records.ts)',
  predicate: 'built in noise-release.ts from fixed clauses with ? placeholders',
  sql: 'a builder-local string assembled from constants (noise-release.ts, retention.ts, setup-progress.ts)',
  "sets.join(',')": 'column=? assignments whose column names come from code (integrations.ts, sources.ts)',
  "where.join(' AND ')":
    'clauses with ? placeholders built by buildListQuery (delivery-queries.ts) and queriesOf (bulk-replay.ts)',
  q: 'the numeric percentile parameter of pct(), called with 50 and 95 (slis.ts)',
  'pct(50)': 'integer percentile arithmetic over a numeric literal (slis.ts)',
  'pct(95)': 'integer percentile arithmetic over a numeric literal (slis.ts)',
  valueSql: 'END_TO_END_SQL / QUEUE_DELAY_SQL, the only two arguments (slis.ts)',
  "from.map(() => '?').join(',')": 'a placeholder list sized by the array (lifecycle.ts)',
  "chunk.map(() => '?').join(',')": 'a placeholder list sized by the chunk (repos.ts)',
  "chunk.map(() => '(?,?,?)').join(',')": 'a placeholder list sized by the chunk (repos.ts)',
  "chunk.map(() => '(?,?)').join(',')":
    'a VALUES list sized by the chunk of integration ids (audit.ts enabledIntegrationAudits, ADR 0058)',
};

/**
 * Fragments of the operator scripts (`scripts/*.mjs`). Each interpolated value is validated in the
 * script before it is used (an integer in 1..1000, a closed reason list, a restricted actor pattern,
 * a UUID) and `tests/security/kek-destroy-check.test.ts` feeds hostile input to every one.
 */
const SCRIPT_FRAGMENTS: Readonly<Record<string, string>> = {
  'integrationDependents(v, options.legacyOld === true)':
    'v is assertVersion(); the boolean only chooses whether integrations_old is added',
  "dependents('sources', v)": 'v is assertVersion()',
  'integrationDependents(version, legacyOld)':
    'version is assertVersion(); legacyOld is a boolean from the operator database check',
  "dependents('sources', version)": 'version is assertVersion()',
  'entry.actor': 'matched against [A-Za-z0-9@._-]{1,80} first',
  id: 'a UUID matched against [0-9a-f-]{36}',
  actor: 'assertActor(): [A-Za-z0-9@._-]{1,80}, in scripts/force-destroy-revoked.mjs',
  auditId: 'a UUID from crypto, re-validated by assertName() in scripts/force-destroy-revoked.mjs',
  org: 'assertName(): [A-Za-z0-9_-]{1,64}, in scripts/force-destroy-revoked.mjs',
  where:
    'a WHERE clause assembled in scripts/force-destroy-revoked.mjs from assertName() ids and an integer cutoff, never a request',
  kind: "the literal 'integration' or 'source', chosen by which flag the operator passed (scripts/force-destroy-revoked.mjs)",
  metadata: 'JSON.stringify of an integer, a closed reason and an integer',
  version: 'assertVersion()',
  hex: 'an 8-character upper-case hex of assertVersion()',
  table: 'one of two string literals passed by the same file',
  old: 'ident(oldName(t.table)) over the fixed list of six tables, in scripts/migration-0026-finalize.mjs',
  'compareColumns(t.table)':
    'a fixed column list or * chosen by a table name from the fixed list of six tables (scripts/lib/migration-0026.mjs)',
  'compareColumns(table)': 'same: the table is from the fixed list of six tables',
  't.table': 'a name from the fixed list of six tables in scripts/lib/migration-0026.mjs',
  list: 'a join of fixed table names from scripts/lib/migration-0026.mjs, each quoted by the same file',
  'ident(table)':
    'ident() throws unless the name matches [A-Za-z_][A-Za-z0-9_]*; the names are the fixed list of six',
  'ident(oldName(table))': 'ident() as above, over a fixed table name plus a literal suffix',
  'ident(SNAPSHOT_TABLE)': 'a string constant of scripts/lib/migration-0026.mjs, validated by ident()',
};

/** Parameters of reviewed builders: the caller passes constants (see ALLOWED_FRAGMENTS). */
const REVIEWED_PARAMETERS: ReadonlySet<string> = new Set([
  'table',
  'column',
  'valueSql',
  'chunk',
  'from',
  'sql',
  'version',
  'q',
]);

/** Non-literal SQL arguments that are reviewed query builders or constants. */
const ALLOWED_ARGUMENTS: ReadonlySet<string> = new Set([
  'query.sql',
  'count.sql',
  'claim.sql',
  'sql',
  'latencySql(valueSql)',
]);

const CONSTANT = /^[A-Z][A-Z0-9_]*$/;
const REQUEST_DERIVED =
  /\b(req|request|body|param|params|searchParams|header|headers|cookie|input|payload)\b|\bc\./;
/** What may follow a SQL string without extending it. Anything else that chains is an extension. */
const EXTENDS_SQL =
  /^\s*(?:\+|\.\s*(?:concat|replace|replaceAll|join|padEnd|padStart|repeat|slice|substring|substr|trim\w*|at)\s*\()/;

export interface SqlSite {
  readonly kind: 'template' | 'literal' | 'expression' | 'alias';
  readonly interpolations: string[];
  readonly text: string;
  /** Source text right after the string or argument. */
  readonly tail: string;
}

/** A template literal that opens with an SQL verb is SQL wherever it is built (query builders). */
const SQL_TEMPLATE = /`\s*\(?\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE)\b/g;
/** `.prepare` not directly called, `['prepare']`, and `String.raw` handed to prepare. */
const ALIAS = /\.prepare\b(?!\s*\()|\[\s*['"]prepare['"]\s*\]/g;

/**
 * Every SQL string in `source`: the first argument of `.prepare(…)` / `db.exec(…)`, any template
 * literal that opens with an SQL verb (so a builder that returns `{ sql: \`SELECT …\` }` is covered,
 * not only the `.prepare` that later receives it), and every aliasing of `prepare`.
 */
export function sqlSites(source: string): SqlSite[] {
  const sites: SqlSite[] = [];
  for (const m of source.matchAll(ALIAS))
    sites.push({ kind: 'alias', interpolations: [], text: m[0], tail: '' });
  const starts = new Set<number>();
  // A comment between the parenthesis and the argument does not hide it.
  for (const m of source.matchAll(
    /(?:\.prepare|\b(?:db|DB)\.exec)\s*\((?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/g,
  ))
    starts.add((m.index ?? 0) + m[0].length);
  for (const m of source.matchAll(SQL_TEMPLATE)) starts.add(m.index ?? 0);
  for (const start of [...starts].sort((a, b) => a - b)) {
    const first = source.charAt(start);
    if (first === '`') {
      let j = start + 1;
      const interpolations: string[] = [];
      while (j < source.length && source.charAt(j) !== '`') {
        if (source.charAt(j) === '\\') {
          j += 2;
          continue;
        }
        if (source.charAt(j) === '$' && source.charAt(j + 1) === '{') {
          let k = j + 2;
          let depth = 1;
          while (depth > 0 && k < source.length) {
            if (source.charAt(k) === '{') depth++;
            else if (source.charAt(k) === '}') depth--;
            k++;
          }
          interpolations.push(source.slice(j + 2, k - 1).trim());
          j = k;
          continue;
        }
        j++;
      }
      sites.push({
        kind: 'template',
        interpolations,
        text: source.slice(start, j + 1),
        tail: source.slice(j + 1, j + 200),
      });
    } else if (first === "'" || first === '"') {
      const end = source.indexOf(first, start + 1);
      sites.push({
        kind: 'literal',
        interpolations: [],
        text: source.slice(start, end + 1),
        tail: source.slice(end + 1, end + 200),
      });
    } else {
      const arg = /^[\w.]+(?:\([^)]*\))?/.exec(source.slice(start))?.[0] ?? source.slice(start, start + 40);
      sites.push({
        kind: 'expression',
        interpolations: [],
        text: arg,
        tail: source.slice(start + arg.length, start + arg.length + 200),
      });
    }
  }
  return sites;
}

/** Leading identifier of an expression: `sets.join(',')` -> `sets`. */
const baseIdentifier = (expr: string): string => /^[A-Za-z_$][\w$]*/.exec(expr)?.[0] ?? '';

/**
 * Is `ident` declared in `source` in a way the guard can trust? A constant must be declared or
 * imported. Anything else must be a `const`/`let` whose initialiser contains a string or template
 * literal and no request-derived name, or a named parameter of a reviewed builder.
 */
export function declaredSafely(ident: string, source: string): boolean {
  if (ident === '') return false;
  const name = ident.replace(/\$/g, '\\$');
  if (CONSTANT.test(ident))
    return new RegExp(
      `(?:const|let|var|function)\\s+${name}\\b|import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`,
    ).test(source);
  const declaration = new RegExp(`(?:const|let)\\s+${name}\\b[^=;]*=([^;]*);`).exec(source);
  if (declaration) {
    const initialiser = declaration[1] ?? '';
    return /['"`]/.test(initialiser) && !REQUEST_DERIVED.test(initialiser);
  }
  const asParameter = new RegExp(
    `(?:\\(|,\\s*|\\b)${name}\\s*(?::[^,)=]+)?(?:,|\\)\\s*(?::[^={]+)?(?:=>|\\{)|\\s*=>)`,
  ).test(source);
  return asParameter && REVIEWED_PARAMETERS.has(ident);
}

/** Why a site is not acceptable, or null. `fragments` is the allow-list for this kind of file. */
export function violation(
  site: SqlSite,
  source: string,
  fragments: Readonly<Record<string, string>> = ALLOWED_FRAGMENTS,
): string | null {
  if (site.kind === 'alias') return `prepare is aliased, so the guard cannot see its calls: ${site.text}`;
  if (EXTENDS_SQL.test(site.tail))
    return `SQL extended after its literal (concatenation or a string method): ${site.text.slice(0, 40)}`;
  if (site.kind === 'literal') return null;
  if (site.kind === 'template') {
    for (const expr of site.interpolations) {
      if (REQUEST_DERIVED.test(expr)) return `interpolates a request-derived value: \${${expr}}`;
      if (!CONSTANT.test(expr) && !(expr in fragments)) return `unreviewed interpolation: \${${expr}}`;
      const base = baseIdentifier(expr);
      if (
        base !== '' &&
        !/^(?:id|input)$/.test(base) &&
        !declaredSafely(base, source) &&
        !(expr in SCRIPT_FRAGMENTS)
      )
        return `\${${expr}} rests on '${base}', which is not declared from literals in this file`;
    }
    return null;
  }
  const arg = site.text.trim();
  if (arg.includes('+')) return `SQL built by concatenation: ${arg}`;
  if (arg.startsWith('String.raw')) return `String.raw hides interpolation from the guard: ${arg}`;
  return CONSTANT.test(arg) || ALLOWED_ARGUMENTS.has(arg) ? null : `unreviewed SQL argument: ${arg}`;
}

const srcFiles = filesUnder(join(root, 'src'), '.ts');
const scriptFiles = filesUnder(join(root, 'scripts'), '.mjs');

describe('the detector (so the guard cannot pass vacuously)', () => {
  const bad = (code: string) => sqlSites(code).map((s) => violation(s, code));

  it('flags interpolated request data, concatenation and unreviewed fragments', () => {
    expect(bad('db.prepare(`SELECT * FROM t WHERE a=${c.req.query("a")}`)')[0]).toMatch(/request-derived/);
    expect(bad('db.prepare(`SELECT * FROM t WHERE a=${body.a}`)')[0]).toMatch(/request-derived/);
    expect(bad("db.prepare('SELECT * FROM t WHERE a=' + id)")[0]).toMatch(/extended/);
    expect(bad('db.prepare(`SELECT ${columns} FROM t`)')[0]).toMatch(/unreviewed interpolation/);
    expect(bad('db.prepare(userSql)')[0]).toMatch(/unreviewed SQL argument/);
  });

  it('flags a `+` after a template literal, and after a newline with any indentation', () => {
    expect(bad('db.prepare(`SELECT 1 FROM t WHERE a=?` + extra)')[0]).toMatch(/extended/);
    expect(bad("db.prepare('SELECT 1 FROM t WHERE a=?'\n            \t   + extra)")[0]).toMatch(/extended/);
    expect(bad('db.prepare(`SELECT 1`\n\n      + suffix)')[0]).toMatch(/extended/);
    expect(bad('db.prepare(PREFIX + suffix)')[0]).toMatch(/extended/);
  });

  it('flags SQL extended by string methods', () => {
    for (const method of [
      '.concat(x)',
      '.replace("a", x)',
      '.replaceAll("a", x)',
      '.join(",")',
      '.padEnd(9, x)',
      '.repeat(3)',
    ])
      expect(bad(`db.prepare('SELECT 1'${method})`)[0], method).toMatch(/extended/);
    expect(bad('db.prepare(`SELECT 1`.concat(x))')[0]).toMatch(/extended/);
    expect(bad("db.prepare(['SELECT', x].join(' '))")[0]).toMatch(/unreviewed SQL argument/);
  });

  it('flags String.raw and aliased prepare', () => {
    expect(bad('db.prepare(String.raw`SELECT ${x}`)')[0]).toMatch(/String\.raw/);
    expect(
      bad('const p = db.prepare.bind(db);\np(`SELECT ${x}`)').some((v) => v !== null && /aliased/.test(v)),
    ).toBe(true);
    expect(bad("const p = db['prepare'];").some((v) => v !== null && /aliased/.test(v))).toBe(true);
    expect(bad('const p = db.prepare;').some((v) => v !== null && /aliased/.test(v))).toBe(true);
  });

  it('requires an allow-listed identifier to be declared from literals in the same file', () => {
    // `guard` is allow-listed by name, but this file builds it from a request value.
    expect(
      bad('const guard = `AND a=${c.req.query("a")}`;\ndb.prepare(`SELECT 1 WHERE b=? ${guard}`)'),
    ).toContain("${guard} rests on 'guard', which is not declared from literals in this file");
    // ... or does not declare it at all.
    expect(bad('db.prepare(`SELECT 1 WHERE b=? ${guard}`)')[0]).toMatch(/not declared/);
    // A literal initialiser is fine.
    expect(bad("const guard = 'AND a=?';\ndb.prepare(`SELECT 1 WHERE b=? ${guard}`)")).toEqual([null]);
    // A constant must be declared or imported, not merely look like one.
    expect(bad('db.prepare(`SELECT ${SELECT_COLUMNS} FROM t`)')[0]).toMatch(/not declared/);
    expect(
      bad("import { SELECT_COLUMNS } from './x';\ndb.prepare(`SELECT ${SELECT_COLUMNS} FROM t`)"),
    ).toEqual([null]);
  });

  it('accepts reviewed fragments and plain literals', () => {
    expect(
      bad("const CREDENTIAL_COLUMNS = 'id';\ndb.prepare(`SELECT ${CREDENTIAL_COLUMNS} FROM t WHERE id=?`)"),
    ).toEqual([null]);
    expect(bad("const sets = ['a=?'];\ndb.prepare(`UPDATE t SET ${sets.join(',')} WHERE id=?`)")).toEqual([
      null,
    ]);
    expect(bad("db.prepare('SELECT 1')")).toEqual([null]);
    expect(bad("const LIST_SQL = 'SELECT 1';\ndb.prepare(LIST_SQL)")).toEqual([null]);
  });

  it('finds sites in the real source (not an empty scan)', () => {
    const sites = srcFiles.flatMap((f) => sqlSites(readFileSync(f, 'utf8')));
    expect(sites.length).toBeGreaterThan(150);
    expect(sites.filter((s) => s.kind === 'template' && s.interpolations.length > 0).length).toBeGreaterThan(
      10,
    );
    expect(scriptFiles.flatMap((f) => sqlSites(readFileSync(f, 'utf8'))).length).toBeGreaterThanOrEqual(2);
  });
});

describe('src/ SQL uses bound parameters only (F09)', () => {
  it('every dynamic part of every SQL string is reviewed, declared from literals, and not request-derived', () => {
    const offenders: string[] = [];
    for (const file of srcFiles) {
      const source = readFileSync(file, 'utf8');
      for (const site of sqlSites(source)) {
        const why = violation(site, source);
        if (why) offenders.push(`${relative(root, file)}: ${why}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the operator scripts follow the same rule, with their own reviewed fragments', () => {
    const offenders: string[] = [];
    for (const file of scriptFiles) {
      const source = readFileSync(file, 'utf8');
      for (const site of sqlSites(source)) {
        const why = violation(site, source, SCRIPT_FRAGMENTS);
        if (why) offenders.push(`${relative(root, file)}: ${why}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every allow-listed fragment is still used (the lists do not rot)', () => {
    const used = (files: string[]) =>
      new Set(files.flatMap((f) => sqlSites(readFileSync(f, 'utf8')).flatMap((s) => s.interpolations)));
    const inSrc = used(srcFiles);
    const inScripts = used(scriptFiles);
    expect(Object.keys(ALLOWED_FRAGMENTS).filter((k) => !inSrc.has(k))).toEqual([]);
    expect(Object.keys(SCRIPT_FRAGMENTS).filter((k) => !inScripts.has(k) && !inSrc.has(k))).toEqual([]);
  });
});

/**
 * `no_query_exceeds_100_bound_parameters` (docs/specs/01-platform-runtime.md F09, ADR 0036). D1 allows 100
 * bound parameters per statement. A static count of the placeholders in every SQL text, plus the
 * arithmetic of the builders that size a placeholder list at run time.
 */
const D1_MAX_BOUND_PARAMETERS = 100;

/** Placeholders a SQL text binds: the highest `?N`, or the number of bare `?`, whichever is larger. */
export function boundParameterCount(sql: string): number {
  const text = sql.replace(/\$\{[^}]*\}/g, ''); // interpolated fragments are sized by the builders below
  const numbered = Math.max(0, ...Array.from(text.matchAll(/\?(\d+)/g), (m) => Number(m[1])));
  const bare = (text.match(/\?(?!\d)/g) ?? []).length;
  return Math.max(numbered, bare);
}

describe('no_query_exceeds_100_bound_parameters', () => {
  it('counts numbered and bare placeholders, and ignores interpolated fragments', () => {
    expect(boundParameterCount('SELECT 1 WHERE a=? AND b=? AND c=?')).toBe(3);
    expect(boundParameterCount('UPDATE t SET a=?1 WHERE b=?7 AND c=?1')).toBe(7);
    expect(boundParameterCount('SELECT 1 WHERE id IN (${chunk.map(() => "?").join(",")})')).toBe(0);
    expect(boundParameterCount('SELECT 1')).toBe(0);
  });

  it('no SQL text in src/ binds more than 100 parameters', () => {
    const over: string[] = [];
    let counted = 0;
    for (const file of srcFiles) {
      const source = readFileSync(file, 'utf8');
      for (const site of sqlSites(source)) {
        if (site.kind !== 'template' && site.kind !== 'literal') continue;
        const n = boundParameterCount(site.text);
        if (n > 0) counted++;
        if (n > D1_MAX_BOUND_PARAMETERS)
          over.push(`${relative(root, file)}: ${n} parameters: ${site.text.slice(0, 60)}`);
      }
    }
    expect(over).toEqual([]);
    expect(counted).toBeGreaterThan(100); // the scan is not vacuous
  });

  it('the operator scripts stay under the limit too', () => {
    const over = scriptFiles.flatMap((file) =>
      sqlSites(readFileSync(file, 'utf8'))
        .filter((s) => s.kind === 'template' || s.kind === 'literal')
        .filter((s) => boundParameterCount(s.text) > D1_MAX_BOUND_PARAMETERS)
        .map((s) => `${relative(root, file)}: ${s.text.slice(0, 60)}`),
    );
    expect(over).toEqual([]);
  });

  /** A constant declared in a source file, read from the text so a changed value fails here. */
  const constantIn = (file: string, name: string): number => {
    const found = new RegExp(`(?:const|let)\\s+${name}\\s*(?::[^=]+)?=\\s*(\\d+)`).exec(
      readFileSync(join(root, file), 'utf8'),
    );
    if (!found) throw new Error(`${name} not found in ${file}`);
    return Number(found[1]);
  };

  it('the run-time sized placeholder lists stay under the limit at their largest chunk', () => {
    const repos = 'src/connectors/sources/' + 'git' + 'hub/repos.ts';
    // INSERT ... VALUES (?,?,?) per row.
    expect(constantIn(repos, 'ROWS_PER_STATEMENT') * 3).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    // DELETE ... WHERE installation_row_id=? AND repository_id IN (<chunk>)
    const deleteChunk = Number(/chunks\(repos, (\d+)\)/.exec(readFileSync(join(root, repos), 'utf8'))?.[1]);
    expect(deleteChunk + 1).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    // The noise-release claim binds its predicate twice (outer and subselect) plus four fixed values and
    // the token, the expiry and the LIMIT: 2 * (4 + keys) + 3.
    const keys = constantIn('src/pipeline/noise-release.ts', 'CLAIM_KEYS_PER_CALL');
    expect(2 * (4 + keys) + 3).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    // ADR 0058: per-integration audit rows bind 2 per row plus 8 shared values; the pause binds 1 per id plus 1.
    expect(constantIn('src/audit/audit.ts', 'AUDIT_ROWS_PER_STATEMENT') * 2 + 8).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );
    const disconnect = 'src/connectors/sources/' + 'git' + 'hub/disconnect.ts';
    expect(constantIn(disconnect, 'IDS_PER_PAUSE') + 1).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
  });

  it('a digest scope binds at most the listed group keys, which the renderer bounds', async () => {
    const { DIGEST_LIST_MAX, DIGEST_MAX_PARTS } = await import('../../src/routing/noise-render');
    // `keys` of one part plus `leftoverOutside` (every key of every part) plus the other fixed values.
    const listed = DIGEST_LIST_MAX * DIGEST_MAX_PARTS;
    expect(DIGEST_LIST_MAX + listed + 10).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
  });
});
