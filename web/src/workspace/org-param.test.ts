import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The server refuses a write that does not name its workspace (`?org=`) from a person in several
 * workspaces (`400 org is required`). This scans the dashboard's API modules so a new mutation
 * cannot forget it: every POST, PUT, PATCH or DELETE `fetch` option must be in a call whose path
 * is built with `withOrg(...)` (or already carries `org=`). The one exception is switching the
 * active workspace itself, which names its target in the body.
 */
const SRC = join(__dirname, '..');
const EXEMPT_PATHS = ['/api/workspace/active'];
const SKIP_FILES = new Set(['sources/snippets.ts']); // sample code shown to the user, not a call

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const MUTATION = /method:\s*'(POST|PUT|PATCH|DELETE)'/g;

export function mutationsWithoutOrg(source: string): string[] {
  const offenders: string[] = [];
  for (const match of source.matchAll(MUTATION)) {
    const before = source.slice(Math.max(0, match.index - 220), match.index);
    const call = before.slice(Math.max(before.lastIndexOf('request('), before.lastIndexOf('api<'), 0));
    const named = /withOrg\(|org=|\bpath\b/.test(before) || EXEMPT_PATHS.some((p) => call.includes(p));
    if (!named) offenders.push(before.trim().split('\n').slice(-3).join(' | '));
  }
  return offenders;
}

describe('every dashboard write names its workspace', () => {
  it('detector flags a mutation without ?org=', () => {
    expect(mutationsWithoutOrg("api('/api/things', { method: 'POST', body: '{}' })")).toHaveLength(1);
    expect(mutationsWithoutOrg("api(withOrg('/api/things', orgId), { method: 'POST' })")).toHaveLength(0);
    expect(mutationsWithoutOrg("api('/api/workspace/active', { method: 'POST' })")).toHaveLength(0);
  });

  it('finds the API modules (guards against a vacuous pass)', () => {
    const count = walk(SRC)
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f))
      .reduce((n, f) => n + [...readFileSync(f, 'utf8').matchAll(MUTATION)].length, 0);
    expect(count).toBeGreaterThanOrEqual(10);
  });

  it('has no dashboard mutation without it', () => {
    const offenders = walk(SRC)
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f))
      .filter((f) => !SKIP_FILES.has(relative(SRC, f).split(sep).join('/')))
      .flatMap((f) => mutationsWithoutOrg(readFileSync(f, 'utf8')).map((o) => `${relative(SRC, f)}: ${o}`));
    expect(offenders).toEqual([]);
  });
});
