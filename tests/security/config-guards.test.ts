import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Guards over auth configuration, CI and the risk register (F234, F239, F241). */
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const read = (p: string): string => readFileSync(join(root, p), 'utf8');
const stripComments = (text: string, marker: RegExp): string =>
  text
    .split('\n')
    .filter((l) => !marker.test(l))
    .join('\n');

describe('session configuration (AR-1, F234)', () => {
  const source = stripComments(read('src/auth/better-auth.ts'), /^\s*(\/\/|\*|\/\*)/);

  it('keeps session.cookieCache off so revocation is immediate', () => {
    expect(source).not.toMatch(/cookieCache/);
  });

  it('trusts exactly the configured app origin', () => {
    expect(source).toMatch(/trustedOrigins:\s*\[\s*env\.APP_ORIGIN\s*\]/);
  });
});

describe('CI workflow hygiene (F239)', () => {
  const code = stripComments(read('.github/workflows/ci.yml'), /^\s*#/);

  it('pins every action to a full commit SHA', () => {
    const uses = [...code.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1] ?? '');
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.filter((u) => !/@[0-9a-f]{40}$/.test(u))).toEqual([]);
  });

  it('never uses pull_request_target and declares read-only permissions', () => {
    expect(code).not.toMatch(/pull_request_target/);
    expect(code).toMatch(/^permissions:\s*\n\s+contents:\s*read\s*$/m);
    expect(code).not.toMatch(/contents:\s*write/);
  });

  it('runs the audit gate and cancels superseded PR runs', () => {
    expect(code).toMatch(/npm run audit:gate/);
    expect(code).toMatch(/cancel-in-progress/);
  });

  it('dependabot covers npm and github-actions', () => {
    const cfg = read('.github/dependabot.yml');
    expect(cfg).toMatch(/package-ecosystem:\s*npm/);
    expect(cfg).toMatch(/package-ecosystem:\s*github-actions/);
  });
});

describe('accepted-risk register (F241)', () => {
  const defined = new Set(
    [...read('docs/THREAT_MODEL.md').matchAll(/^\|\s*(AR-\d+)\s*\|/gm)].map((m) => m[1]),
  );
  const docs = ['docs/SECURITY.md', 'docs/RELEASE_GATES.md', 'docs/THREAT_MODEL.md', 'SECURITY.md'];

  it('defines the registered risks', () => {
    expect(defined.size).toBeGreaterThanOrEqual(12);
  });

  it('every AR-n referenced in security docs is defined in the register', () => {
    const missing: string[] = [];
    for (const f of docs) {
      for (const m of read(f).matchAll(/\bAR-\d+\b/g)) {
        if (!defined.has(m[0])) missing.push(`${f}: ${m[0]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('release gates (F240)', () => {
  it('names all four mandatory gates', () => {
    const gates = read('docs/RELEASE_GATES.md');
    for (const gate of [
      'Real-provider end-to-end',
      'Tenant isolation',
      'Secret handling',
      'Rollback rehearsal',
    ]) {
      expect(gates).toContain(gate);
    }
  });
});
