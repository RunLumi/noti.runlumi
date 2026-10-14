import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Spec 01 F01/F02/F05: the gates are configuration, so the only way to know they stay on is to assert the
 * configuration. These are not tests of the tooling; they stop a later edit from quietly switching a gate off.
 */
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const read = (p: string): string => readFileSync(join(root, p), 'utf8');
const code = (p: string): string =>
  read(p)
    .split('\n')
    .filter((l) => !/^\s*(#|\/\/)/.test(l))
    .join('\n');
const CI = '.github/workflows/ci.yml';

describe('platform gates', () => {
  it('keeps exactOptionalPropertyTypes on for the worker and its tests (F01)', () => {
    expect(code('tsconfig.json')).toMatch(/"exactOptionalPropertyTypes":\s*true/);
  });

  it('enforces a coverage floor with every threshold set (F02)', () => {
    const config = code('vitest.config.ts');
    for (const metric of ['statements', 'branches', 'functions', 'lines'])
      expect(config, metric).toMatch(new RegExp(`${metric}:\\s*\\d{2}`));
    expect(code(CI)).toContain('npm run test:coverage');
  });

  it('runs the real-wrangler migration chain as its own CI job (F02, F05)', () => {
    const ci = code(CI);
    expect(ci).toMatch(/^ {2}integration:/m);
    expect(ci).toContain('npm run test:integration');
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
    expect(scripts['test:integration']).toContain('migration-0026-d1');
    // That file is what runs `wrangler d1 migrations apply --local` from an empty database.
    expect(read('tests/migration-0026-d1.test.ts')).toContain('migrations');
  });

  it('checks migration immutability in CI, against the base branch on pull requests (F05)', () => {
    const ci = code(CI);
    expect(ci).toContain('npm run migrations:check');
    expect(ci).toContain('migration-seal.mjs --check --base "origin/$BASE_REF"');
    // The base ref reaches the shell as an environment variable, never interpolated into the script.
    expect(ci).not.toMatch(/run:[^\n]*\$\{\{\s*[a-z]+\.base_ref/);
  });
});
