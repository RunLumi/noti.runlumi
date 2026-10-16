import { readdirSync, readFileSync } from 'node:fs';
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
  // Every workflow, so a future one cannot skip the rules.
  const workflows = readdirSync(join(root, '.github', 'workflows'))
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => ({ f, text: stripComments(read(`.github/workflows/${f}`), /^\s*#/) }));

  it('pins every action in every workflow to a full commit SHA', () => {
    const offenders = workflows.flatMap(({ f, text }) =>
      [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)]
        .map((m) => m[1] ?? '')
        .filter((u) => !u.startsWith('./') && !/@[0-9a-f]{40}$/.test(u))
        .map((u) => `${f}: ${u}`),
    );
    expect(workflows.length).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it('grants no write or id-token permission in any workflow', () => {
    const offenders = workflows.filter(({ text }) =>
      /^\s+(contents|pull-requests|id-token|actions|packages|issues):\s*write\s*$/m.test(text),
    );
    expect(offenders.map((w) => w.f)).toEqual([]);
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
  const docs = [
    'docs/SECURITY.md',
    'docs/RELEASE_GATES.md',
    'docs/THREAT_MODEL.md',
    'docs/DSAR.md',
    'docs/DATA_RETENTION.md',
    'docs/SUBPROCESSORS.md',
    'docs/INCIDENT_RESPONSE.md',
    'SECURITY.md',
  ];

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

// These guards protect the privilege boundary between public PR checks and production writes.
describe('automatic deployment boundary', () => {
  const workflow = read('.github/workflows/ci.yml');
  const deploy = workflow.slice(workflow.indexOf('\n  deploy:'));

  it('requires both CI gates, the main branch and a push or explicit main rerun', () => {
    expect(deploy).toMatch(/needs: \[verify, integration\]/);
    expect(deploy).toContain("github.ref == 'refs/heads/main'");
    expect(deploy).toContain("github.event_name == 'push'");
    expect(deploy).toContain("github.event_name == 'workflow_dispatch'");
    expect(deploy).toMatch(/environment:\s*\n\s+name: production/);
  });

  it('serializes deploys and skips superseded main revisions', () => {
    expect(deploy).toMatch(/group: noti-production\s*\n\s+cancel-in-progress: false/);
    expect(deploy).toContain('git/ref/heads/main');
    expect(deploy).toContain('if: steps.revision.outputs.current');
    expect(deploy).toContain('ref: ${{ github.sha }}');
  });

  it('keeps deployment credentials out of the check jobs and installation', () => {
    const beforeDeploy = workflow.slice(0, workflow.indexOf('\n  deploy:'));
    expect(beforeDeploy).not.toContain('secrets.CLOUDFLARE_API_TOKEN');
    expect(deploy).toContain('npm ci --ignore-scripts');
    expect(deploy.indexOf('secrets.CLOUDFLARE_API_TOKEN')).toBeGreaterThan(
      deploy.indexOf('npm run build:web'),
    );
    expect(deploy).toContain('node scripts/check-deployment-migrations.mjs');
    expect(deploy).toContain('npm run smoke');
    expect(deploy).not.toMatch(/d1 migrations apply|secret (put|bulk|delete)|migration-0026-finalize/);
  });
});
