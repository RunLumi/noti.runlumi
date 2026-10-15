import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parseFilters, readStoredFilters } from '../../src/routing/filter-input';
import { compileGlob, globMatches } from '../../src/routing/glob';

/**
 * Routing filters are globs, never regular expressions (spec 10 F127, spec 11 F167, ADR 0010, and the
 * "No regex in filters" non-goal in docs/ROADMAP.md). A pattern written in a regex dialect is refused
 * when it uses syntax a glob does not have (`? [ ] { } +`, a backslash class, a leading `!`); one made only
 * of characters a glob treats literally (`^ $ ( ) | .`) is a literal and never acquires regex meaning, so
 * `^main$` matches no branch (git forbids `^` in ref names). No RegExp is built from input.
 */
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const REGEX_DIALECT = [
  'release-\\d+',
  '[a-z]+',
  'feat/(login|signup)?',
  'v{1,2}',
  'hotfix+',
  '.*?',
  '\\w*',
  '!main',
];

function errorFields(raw: unknown): string[] {
  const r = parseFilters(raw);
  return r.ok ? [] : r.errors.map((e) => e.field);
}

describe('routing filters reject regex patterns (F167: glob only)', () => {
  it.each(REGEX_DIALECT)('refuses %s in every branch list', (pattern) => {
    for (const id of ['branch', 'baseBranch'] as const) {
      for (const list of ['allow', 'deny'] as const) {
        expect(errorFields({ [id]: { [list]: [pattern] } })).toEqual([`filters.${id}.${list}[0]`]);
      }
    }
  });

  it('refuses a stored document that carries a regex-dialect pattern (fails closed)', () => {
    for (const pattern of REGEX_DIALECT)
      expect(readStoredFilters(JSON.stringify({ v: 1, branch: { deny: [pattern] } }))).toEqual({
        kind: 'invalid',
      });
  });

  it('refuses a RegExp value, a $regex operator and a regex option', () => {
    expect(errorFields({ branch: { allow: [/main/] } })).toEqual(['filters.branch.allow[0]']);
    expect(errorFields({ branch: { allow: [{ $regex: '^main$' }] } })).toEqual(['filters.branch.allow[0]']);
    expect(errorFields({ branch: { allow: ['main'], regex: true } })).toEqual(['filters.branch.regex']);
    expect(errorFields({ regex: { branch: '^main$' } })).toEqual(['filters.regex']);
  });

  it.each([
    // `^`, `$`, `(`, `)`, `|` and `.` are taken literally: none of these regexes matches what it would as a regex.
    ['^main$', 'main'],
    ['(main|dev)', 'main'],
    ['main|dev', 'dev'],
    ['feat/.*', 'feat/login'],
  ])('treats %s literally, so it does not match %s', (pattern, branch) => {
    const c = compileGlob(pattern);
    expect(c.ok).toBe(true);
    if (c.ok) expect(globMatches(c.glob, branch)).toBe(false);
  });

  it('builds no RegExp in src/routing (no new RegExp or RegExp(...) call)', () => {
    const dir = join(root, 'src', 'routing');
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const source = ts.createSourceFile(file, readFileSync(join(dir, file), 'utf8'), ts.ScriptTarget.Latest);
      const visit = (n: ts.Node): void => {
        if (
          (ts.isNewExpression(n) || ts.isCallExpression(n)) &&
          ts.isIdentifier(n.expression) &&
          n.expression.text === 'RegExp'
        )
          offenders.push(file);
        ts.forEachChild(n, visit);
      };
      visit(source);
    }
    expect(offenders).toEqual([]);
  });
});
