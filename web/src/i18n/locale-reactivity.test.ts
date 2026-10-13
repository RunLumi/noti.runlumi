import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * `t()` is a plain function: a component shows a new language only if it renders again. So
 * every component (an upper-case function that returns JSX) must call `useLocale()`, a
 * `useSyncExternalStore` subscription. Without it, a language switch would leave that
 * component's text stale until something else re-rendered it. If this fails, add
 * `useLocale();` as the first line of the component (import from `i18n/LocaleProvider`).
 */
const SRC = join(__dirname, '..');
const EXEMPT = new Set(['i18n/LocaleProvider.tsx']);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const hasJsx = (node: ts.Node): boolean => {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
};

export function componentsMissingUseLocale(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const missing: string[] = [];
  const check = (name: string, fn: ts.FunctionLikeDeclaration) => {
    if (!/^[A-Z]/.test(name) || !fn.body || !hasJsx(fn.body)) return;
    if (!/\buseLocale\(/.test(fn.body.getText(file))) missing.push(name);
  };
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name) check(n.name.text, n);
    else if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    )
      check(n.name.text, n.initializer);
    ts.forEachChild(n, visit);
  };
  visit(file);
  return missing;
}

describe('every component re-renders on a language change', () => {
  const files = walk(SRC).filter((file) => {
    const rel = relative(SRC, file).split(sep).join('/');
    return (
      file.endsWith('.tsx') &&
      !/\.test\.tsx$/.test(rel) &&
      !rel.startsWith('a11y/testing') &&
      !EXEMPT.has(rel)
    );
  });

  it('scans a meaningful number of files', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('calls useLocale() in every component', () => {
    const offenders = files.flatMap((file) =>
      componentsMissingUseLocale(file, readFileSync(file, 'utf8')).map(
        (name) => `${relative(SRC, file)}: ${name}`,
      ),
    );
    expect(offenders, `Add useLocale(); to:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('detects a component that forgot', () => {
    expect(componentsMissingUseLocale('x.tsx', 'export function A() { return <p>hi</p>; }')).toEqual(['A']);
    expect(
      componentsMissingUseLocale('x.tsx', 'export const B = () => { useLocale(); return <p/>; };'),
    ).toEqual([]);
    expect(componentsMissingUseLocale('x.tsx', 'export const c = () => <p/>;')).toEqual([]);
  });
});
