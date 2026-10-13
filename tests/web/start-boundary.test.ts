import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ADR 0017: TanStack Start is the dashboard's build and routing layer, nothing more. Its server
 * functions and server routes are not used, and in production the Worker never routes a request to
 * Start's handler (src/worker.ts), so none of them could run. These tests keep it that way: a
 * state-changing action that bypassed the Hono API would also bypass the central same-origin
 * check (src/security/csrf.ts) and the tenant-scoped authorisation behind it.
 */
const root = join(__dirname, '..', '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const sourceFiles = (dir: string) => walk(join(root, dir)).filter((f) => /\.(ts|tsx)$/.test(f));
const rel = (file: string) => relative(root, file).split(sep).join('/');

/** Handler objects of a server route, and every server-side Start API. */
const SERVER_SURFACE =
  /\bserver\s*:\s*\{|\bhandlers\s*:|createServerFn|createServerFileRoute|createMiddleware|createStart\b|createIsomorphicFn/;

describe('TanStack Start stays out of application code', () => {
  const all = sourceFiles('web/src');
  const generated = (f: string) => f.endsWith('routeTree.gen.ts');
  const webFiles = all.filter((f) => !generated(f));

  it('scans a meaningful number of files', () => {
    expect(webFiles.length).toBeGreaterThan(40);
    expect(all.some(generated)).toBe(true);
  });

  it('web/src never imports @tanstack/react-start (no server functions, middleware or server routes)', () => {
    const offenders = webFiles.filter((f) => /@tanstack\/(react-)?start/.test(readFileSync(f, 'utf8')));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('no file in web/src, generated or not, defines a server handler or uses a server-side Start API', () => {
    const offenders = all.filter((f) => SERVER_SURFACE.test(readFileSync(f, 'utf8')));
    // The generated tree only carries Start's type registration (`import type { createStart }`).
    const allowed = all.filter(generated).filter((f) => {
      const code = readFileSync(f, 'utf8');
      return (
        !/\bserver\s*:\s*\{|\bhandlers\s*:|createServerFn|createServerFileRoute|createMiddleware/.test(
          code,
        ) &&
        (code.match(/createStart\b/g) ?? []).length === 1 &&
        /import type \{ createStart \} from '@tanstack\/react-start'/.test(code)
      );
    });
    expect(offenders.filter((f) => !allowed.includes(f)).map(rel)).toEqual([]);
  });

  it('the generated route tree imports nothing from Start at runtime', () => {
    for (const file of all.filter(generated))
      for (const line of readFileSync(file, 'utf8').split('\n'))
        if (/from '@tanstack\/react-start/.test(line)) expect(line).toMatch(/^import type /);
  });

  it('the Worker reaches Start only through its server-entry, loaded lazily', () => {
    const worker = readFileSync(join(root, 'src', 'worker.ts'), 'utf8');
    expect(worker).toMatch(/await import\('@tanstack\/react-start\/server-entry'\)/);
    expect(worker).not.toMatch(/^import .* from '@tanstack\/react-start/m);
  });

  it('src (the API) imports Start only in the Worker entry', () => {
    const offenders = sourceFiles('src')
      .filter((f) => rel(f) !== 'src/worker.ts')
      .filter((f) => /@tanstack\/(react-)?start/.test(readFileSync(f, 'utf8')));
    expect(offenders.map(rel)).toEqual([]);
  });
});

describe('the Worker entry keeps the three handlers', () => {
  it('exports fetch, scheduled and queue from the API module', () => {
    const worker = readFileSync(join(root, 'src', 'worker.ts'), 'utf8');
    expect(worker).toMatch(/app\.scheduled\(/);
    expect(worker).toMatch(/queue: app\.queue/);
    expect(worker).toMatch(/isBackendPath\(/);
  });
});
