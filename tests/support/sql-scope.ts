import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { must } from './must';

/**
 * Static scanner behind `tests/security/tenant-query-scope.test.ts` (F26, F233).
 *
 * It parses every TypeScript file with the compiler API, collects the SQL string literals
 * (plain, template, `+` concatenation, and `${CONST}` interpolation of string constants), splits
 * each statement into subquery scopes, and reports every SELECT / UPDATE / DELETE / INSERT..SELECT
 * that touches a tenant table without an `organization_id` comparison.
 *
 * LIMITS (stated here and in docs/AUTHORIZATION.md, not hidden):
 *  - It sees only SQL that is written as literals in the source. SQL assembled from pieces at
 *    runtime (arrays joined, a variable concatenated in a loop) is seen piecewise: a fragment
 *    that does not itself begin with a statement keyword is invisible.
 *  - It proves an `organization_id` comparison EXISTS in the statement, not that the bound value is
 *    the caller's organization. That half is covered by the cross-workspace tests and the drill.
 *  - A `${expr}` it cannot resolve in a table position is treated as a tenant table.
 *  - Comma joins (`FROM a, b`) are not parsed; the repository has none and the test below fails if
 *    one appears.
 */

export interface SqlStatement {
  readonly file: string;
  readonly line: number;
  readonly sql: string;
}

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly table: string;
  readonly kind: 'read-or-write' | 'insert-columns' | 'comma-join';
  readonly sql: string;
}

const DYNAMIC = '\u0000';
const STATEMENT_START = /^\s*(WITH|SELECT|UPDATE|DELETE|INSERT|REPLACE)\b/;
const NOT_ALIAS = new Set(
  'WHERE ON LEFT RIGHT INNER OUTER CROSS JOIN GROUP ORDER LIMIT SET USING UNION HAVING WINDOW RETURNING NATURAL VALUES SELECT'.split(
    ' ',
  ),
);

export function listTsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return listTsFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.d.ts') ? [full] : [];
  });
}

// ---------------------------------------------------------------------------------------------
// 1. Collect statements from source
// ---------------------------------------------------------------------------------------------

interface Parsed {
  readonly file: string;
  readonly source: ts.SourceFile;
}

interface Def {
  readonly file: string;
  readonly expr: ts.Expression;
}

interface Env {
  readonly local: ReadonlyMap<string, ReadonlyMap<string, Def[]>>;
  readonly global: ReadonlyMap<string, Def[]>;
}

function collectConstants(files: readonly Parsed[]): Env {
  const local = new Map<string, Map<string, Def[]>>();
  const global = new Map<string, Def[]>();
  for (const { file, source } of files) {
    const mine = new Map<string, Def[]>();
    local.set(file, mine);
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (node.parent.flags & ts.NodeFlags.Const) !== 0
      ) {
        const def = { file, expr: node.initializer };
        mine.set(node.name.text, [...(mine.get(node.name.text) ?? []), def]);
        global.set(node.name.text, [...(global.get(node.name.text) ?? []), def]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { local, global };
}

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) {
    e = e.expression;
  }
  return e;
}

function lookup(env: Env, file: string, name: string): Def | null {
  const here = env.local.get(file)?.get(name);
  if (here) return here.length === 1 ? (here[0] ?? null) : null; // two in one file: ambiguous, not guessed
  const any = env.global.get(name);
  return any && any.length === 1 ? (any[0] ?? null) : null;
}

/**
 * Evaluate a string-valued expression; anything unknown becomes DYNAMIC. null = not a string.
 * `${parts.join(' AND ')}` over a const array literal evaluates to the array's INITIAL elements:
 * the base predicate that every dynamic WHERE builder starts from. Later `.push()` calls add
 * conditions and cannot remove it, so the initial elements are the part that matters here.
 */
function evaluate(
  expr: ts.Expression,
  env: Env,
  file: string,
  seen: ReadonlySet<string> = new Set(),
): string | null {
  const e = unwrap(expr);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isTemplateExpression(e)) {
    let text = e.head.text;
    for (const span of e.templateSpans) {
      text += (evaluate(span.expression, env, file, seen) ?? DYNAMIC) + span.literal.text;
    }
    return text;
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = evaluate(e.left, env, file, seen);
    const r = evaluate(e.right, env, file, seen);
    if (l === null && r === null) return null;
    return (l ?? DYNAMIC) + (r ?? DYNAMIC);
  }
  if (ts.isIdentifier(e)) {
    const def = lookup(env, file, e.text);
    const key = `${file}:${e.text}`;
    // Ambiguous (same name defined twice) or cyclic references are not guessed at.
    if (!def || seen.has(key)) return DYNAMIC;
    return evaluate(def.expr, env, def.file, new Set([...seen, key])) ?? DYNAMIC;
  }
  if (
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    e.expression.name.text === 'join' &&
    ts.isIdentifier(e.expression.expression)
  ) {
    const def = lookup(env, file, e.expression.expression.text);
    const array = def ? unwrap(def.expr) : null;
    const sepArg = e.arguments[0];
    if (array && ts.isArrayLiteralExpression(array) && sepArg) {
      const sep = evaluate(sepArg, env, file, seen);
      const parts = array.elements.map((x) => evaluate(x, env, must(def).file, seen) ?? DYNAMIC);
      if (sep !== null && parts.length > 0) return parts.join(sep);
    }
    return DYNAMIC;
  }
  return null;
}

export function collectStatements(files: readonly { file: string; text: string }[]): SqlStatement[] {
  const parsed: Parsed[] = files.map(({ file, text }) => ({
    file,
    source: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true),
  }));
  const env = collectConstants(parsed);
  const out: SqlStatement[] = [];
  for (const { file, source } of parsed) {
    const visit = (node: ts.Node): void => {
      const isStringish =
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node) ||
        (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken);
      if (isStringish) {
        const value = evaluate(node, env, file);
        if (value !== null) {
          const clean = value.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ' ');
          if (STATEMENT_START.test(clean) && /\b(FROM|INTO|UPDATE|JOIN)\b/.test(clean)) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
            out.push({ file, line: line + 1, sql: clean.replace(/\s+/g, ' ').trim() });
          }
          return; // the outermost string expression is one statement: do not rescan its parts
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}

export function readSources(root: string, dir = 'src'): { file: string; text: string }[] {
  return listTsFiles(join(root, dir)).map((f) => ({
    file: f.slice(root.length + 1),
    text: readFileSync(f, 'utf8'),
  }));
}

// ---------------------------------------------------------------------------------------------
// 2. Analyse one statement
// ---------------------------------------------------------------------------------------------

interface Scope {
  readonly id: number;
  /** One entry per UNION arm; `?subN` placeholders refer to `subs`. */
  readonly parts: readonly string[];
  readonly subs: ReadonlyMap<number, Scope>;
}

/** Cut `(SELECT ...)` groups out into their own scopes, leaving `?subN` behind. */
function splitScopes(sql: string, counter: { n: number }): Scope {
  let text = sql;
  const subs = new Map<number, Scope>();
  const re = /\(\s*(?:SELECT|WITH)\b/i;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 0;
    let i = m.index;
    for (; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && --depth === 0) break;
    }
    const inner = text.slice(m.index + 1, i);
    const id = ++counter.n;
    subs.set(id, splitScopes(inner, counter));
    text = `${text.slice(0, m.index)} ?sub${id} ${text.slice(i + 1)}`;
  }
  return { id: ++counter.n, parts: text.split(/\bUNION(?:\s+ALL)?\b/i), subs };
}

interface TableRef {
  readonly table: string;
  readonly alias: string;
  readonly role: 'from' | 'write-target';
}

function stripQuotedLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

function tableRefs(text: string): { refs: TableRef[]; commaJoin: boolean } {
  const refs: TableRef[] = [];
  const name = `("?[A-Za-z_][\\w]*"?|${DYNAMIC})`;
  const fromJoin = new RegExp(`\\b(?:FROM|JOIN)\\s+${name}(?:\\s+(?:AS\\s+)?([A-Za-z_]\\w*))?`, 'gi');
  for (let m = fromJoin.exec(text); m; m = fromJoin.exec(text)) {
    const alias = m[2] && !NOT_ALIAS.has(m[2].toUpperCase()) ? m[2] : '';
    refs.push({ table: must(m[1]).replace(/"/g, ''), alias, role: 'from' });
  }
  const target = new RegExp(
    `^\\s*(?:UPDATE(?:\\s+OR\\s+\\w+)?|INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO)\\s+${name}`,
    'i',
  );
  const t = target.exec(text);
  if (t) refs.push({ table: must(t[1]).replace(/"/g, ''), alias: '', role: 'write-target' });
  const commaJoin = new RegExp(`\\bFROM\\s+${name}(?:\\s+(?:AS\\s+)?[A-Za-z_]\\w*)?\\s*,`, 'i').test(text);
  return { refs, commaJoin };
}

/** The part of a scope that can hold a predicate: after the first WHERE / ON (not ON CONFLICT). */
function predicateRegion(text: string): string {
  const m = /\b(?:WHERE|ON(?!\s+CONFLICT))\b/i.exec(text);
  return m ? text.slice(m.index) : '';
}

/**
 * What the predicate can really rely on. A parenthesised group that contains OR proves nothing
 * about any single term inside it, so it is cut out; an OR left at the top level makes the whole
 * WHERE non-conjunctive, so nothing in it scopes the statement. `NOT organization_id` is refused:
 * it is a predicate against the tenant, not for it.
 */
function conjunctiveRegion(region: string): string | null {
  let out = '';
  let depth = 0;
  let group = '';
  for (const ch of region) {
    if (ch === '(') {
      if (depth++ === 0) {
        group = '(';
        continue;
      }
    } else if (ch === ')' && depth > 0 && --depth === 0) {
      group += ')';
      out += /\bOR\b/i.test(group) ? ' ?grp ' : group;
      continue;
    }
    if (depth > 0) group += ch;
    else out += ch;
  }
  if (/\bOR\b/i.test(out)) return null;
  if (/\bNOT\s+(?:\w+\.)?organization_id\b/i.test(out)) return null;
  return out;
}

/** A bind parameter or a scoped-subquery placeholder: a value the caller supplies. */
const BOUND = String.raw`(?:\(\s*)?(?:\?\d*|\?sub\d+)`;

/** True when `qualifier.organization_id` (or the bare column) is compared to a bound value. */
function boundToParam(region: string, qualifier: string, unqualified: boolean): boolean {
  const q = qualifier.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&');
  const col = unqualified ? String.raw`(?:(?<![\w.])|${q}\.)organization_id` : `${q}\\.organization_id`;
  return (
    new RegExp(String.raw`${col}\b\s*(?:=|IN\b|IS\b)\s*${BOUND}`, 'i').test(region) ||
    new RegExp(String.raw`${BOUND}\s*=\s*${col}\b`, 'i').test(region)
  );
}

function viaScopedSubquery(
  region: string,
  table: string,
  subScoped: ReadonlyMap<number, Set<string>>,
): boolean {
  for (const m of region.matchAll(/\b(?:rowid|id)\s+IN\s+\?sub(\d+)/gi)) {
    if (subScoped.get(Number(m[1]))?.has(table)) return true;
  }
  return false;
}

/**
 * Returns the tables this scope is org-scoped for, so `DELETE .. WHERE rowid IN (scoped
 * subquery)` passes. A tenant table is scoped when its `organization_id` is compared to a bound
 * value, or equals the `organization_id` of another table in the same scope that is (a join the
 * caller's organization flows through), or of a table outside the scope (a correlated subquery,
 * whose outer scope is checked on its own).
 */
function analyseScope(
  scope: Scope,
  tenantTables: ReadonlySet<string>,
  childTables: ReadonlyMap<string, string>,
  onViolation: (table: string, kind: Violation['kind']) => void,
): Set<string> {
  const scopedHere = new Set<string>();
  const subScoped = new Map<number, Set<string>>();
  for (const [id, sub] of scope.subs) {
    subScoped.set(id, analyseScope(sub, tenantTables, childTables, onViolation));
  }

  for (const text of scope.parts) {
    const { refs, commaJoin } = tableRefs(text);
    const tenantRefs = refs.filter((r) => r.table === DYNAMIC || tenantTables.has(r.table));
    const childRefs = refs.filter((r) => childTables.has(r.table));
    if (commaJoin && (tenantRefs.length > 0 || childRefs.length > 0)) {
      onViolation(must(tenantRefs[0] ?? childRefs[0]).table, 'comma-join');
    }
    // A region that is not conjunctive (a top-level OR, a NOT on the tenant) scopes nothing.
    const region = conjunctiveRegion(predicateRegion(text)) ?? '';
    const qualifierOf = (r: TableRef): string => r.alias || r.table;
    const insertColumns = (r: TableRef): string | null =>
      /^\s*INSERT/i.test(text) && r.role === 'write-target'
        ? (new RegExp(`INTO\\s+"?${r.table}"?\\s*\\(([^)]*)\\)`, 'i').exec(text)?.[1] ?? '')
        : null;

    const reads: TableRef[] = [];
    for (const r of tenantRefs) {
      const cols = insertColumns(r);
      if (cols === null) reads.push(r);
      else if (/\borganization_id\b/i.test(cols)) scopedHere.add(r.table);
      else onViolation(r.table, 'insert-columns');
    }

    const satisfied = new Set<TableRef>();
    for (const r of reads) {
      if (boundToParam(region, qualifierOf(r), reads.length === 1)) satisfied.add(r);
    }
    // Propagate through `a.organization_id = b.organization_id` joins, to a fixed point.
    const links = [...region.matchAll(/\b(\w+)\.organization_id\s*=\s*(\w+)\.organization_id\b/gi)];
    const inScope = new Set(reads.map(qualifierOf));
    for (let changed = true; changed;) {
      changed = false;
      for (const [, a, b] of links) {
        for (const [x, y] of [
          [must(a), must(b)],
          [must(b), must(a)],
        ] as const) {
          const rx = reads.find((r) => qualifierOf(r) === x);
          if (!rx || satisfied.has(rx)) continue;
          const ry = reads.find((r) => qualifierOf(r) === y);
          if ((ry && satisfied.has(ry)) || (!ry && !inScope.has(y))) {
            satisfied.add(rx);
            changed = true;
          }
        }
      }
    }
    for (const r of reads) {
      if (satisfied.has(r) || viaScopedSubquery(region, r.table, subScoped)) scopedHere.add(r.table);
      else onViolation(r.table, 'read-or-write');
    }

    // Child tables carry no organization_id of their own: they are scoped by their parent row.
    for (const r of childRefs) {
      const parent = must(childTables.get(r.table));
      const cols = insertColumns(r);
      const keyed = new RegExp(String.raw`\binstallation_row_id\s*(?:=|IN\b)\s*${BOUND}`, 'i');
      const viaParent = reads.some((x) => x.table === parent && satisfied.has(x));
      const insertOk = cols !== null && /\binstallation_row_id\b/i.test(cols);
      if (insertOk || keyed.test(region) || viaParent || viaScopedSubquery(region, r.table, subScoped)) {
        scopedHere.add(r.table);
      } else onViolation(r.table, 'read-or-write');
    }
  }
  return scopedHere;
}

export function findViolations(
  statements: readonly SqlStatement[],
  tenantTables: ReadonlySet<string>,
  childTables: ReadonlyMap<string, string> = new Map(),
): Violation[] {
  const out: Violation[] = [];
  for (const s of statements) {
    const scope = splitScopes(stripQuotedLiterals(s.sql), { n: 0 });
    analyseScope(scope, tenantTables, childTables, (table, kind) =>
      out.push({
        file: s.file,
        line: s.line,
        table: table === DYNAMIC ? '(dynamic)' : table,
        kind,
        sql: s.sql.replaceAll(DYNAMIC, '${...}'),
      }),
    );
  }
  return out;
}
