import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Plain ESM scripts (an operator runs them without a build step); no type declarations.
interface Predeploy {
  ALLOWED_PLACEHOLDER_KEYS: Set<string>;
  OPTIONAL_PLACEHOLDERS: Set<string>;
  parseWrangler: (text: string) => Record<string, unknown>;
  placeholders: (config: unknown) => [string, string][];
  evaluatePredeploy: (config: Record<string, unknown>) => { fatal: string[]; warnings: string[] };
}
interface Smoke {
  smoke: (origin: string, fetchImpl: typeof fetch) => Promise<{ ok: boolean; lines: string[] }>;
}
const predeployPath = '../scripts/predeploy-check.mjs';
const smokePath = '../scripts/smoke-health.mjs';
const predeploy = (await import(/* @vite-ignore */ predeployPath)) as Predeploy;
const { smoke } = (await import(/* @vite-ignore */ smokePath)) as Smoke;

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const committed = predeploy.parseWrangler(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));

const GOOD = {
  d1_databases: [{ binding: 'DB', database_id: '0123abcd-0000-0000-0000-000000000000' }],
  vars: {
    APP_ORIGIN: 'https://noti.runlumi.app',
    ENVIRONMENT_NAME: 'production',
    KEK_CHECK_V1: 'f1621faf533fef4f46147282d75bc6f0',
    GITHUB_APP_ID: '123',
  },
};

describe('the committed wrangler.jsonc (CI check)', () => {
  it('contains placeholders only under keys on the allow-list', () => {
    const found = predeploy.placeholders(committed).map(([key]) => key);
    expect(found.filter((k) => !predeploy.ALLOWED_PLACEHOLDER_KEYS.has(k))).toEqual([]);
  });

  it('accepts the configured production deployment', () => {
    expect(predeploy.evaluatePredeploy(committed).fatal).toEqual([]);
    expect(predeploy.placeholders(committed)).toEqual([]);
  });

  it('refuses an unconfigured template, naming what to set', () => {
    const template = {
      ...GOOD,
      d1_databases: [{ binding: 'DB', database_id: 'REPLACE_WITH_D1_DATABASE_ID' }],
      vars: {
        ...GOOD.vars,
        KEK_CHECK_V1: 'REPLACE_WITH_KEK_CHECK_V1',
        GITHUB_APP_ID: 'REPLACE_WITH_GITHUB_APP_ID',
      },
    };
    const { fatal, warnings } = predeploy.evaluatePredeploy(template);
    expect(fatal.join('\n')).toMatch(/KEK_CHECK_V1/);
    expect(fatal.join('\n')).toMatch(/database_id/);
    // The GitHub App identifiers only warn: that feature stays closed by design.
    expect(warnings.join('\n')).toMatch(/GITHUB_APP_ID/);
    expect(fatal.join('\n')).not.toMatch(/GITHUB_/);
  });
});

describe('evaluatePredeploy', () => {
  it('passes a fully configured production file, warning only about optional placeholders', () => {
    expect(predeploy.evaluatePredeploy(GOOD)).toEqual({ fatal: [], warnings: [] });
    const withOptional = { ...GOOD, vars: { ...GOOD.vars, GITHUB_APP_SLUG: 'REPLACE_WITH_GITHUB_APP_SLUG' } };
    const result = predeploy.evaluatePredeploy(withOptional);
    expect(result.fatal).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });

  it('refuses a REPLACE_WITH_ in any var that is not optional', () => {
    const bad = { ...GOOD, vars: { ...GOOD.vars, APP_ORIGIN: 'https://REPLACE_WITH_HOST' } };
    expect(predeploy.evaluatePredeploy(bad).fatal.join('\n')).toMatch(/APP_ORIGIN/);
    const noD1 = { ...GOOD, d1_databases: [{ binding: 'DB', database_id: 'REPLACE_WITH_D1_DATABASE_ID' }] };
    expect(predeploy.evaluatePredeploy(noD1).fatal.join('\n')).toMatch(/database_id/);
  });

  it('refuses a development name or a malformed check value in a deployment', () => {
    const dev = { ...GOOD, vars: { ...GOOD.vars, ENVIRONMENT_NAME: 'development' } };
    expect(predeploy.evaluatePredeploy(dev).fatal.join('\n')).toMatch(/ENVIRONMENT_NAME/);
    const badCheck = { ...GOOD, vars: { ...GOOD.vars, KEK_CHECK_V1: 'not-a-check-value' } };
    expect(predeploy.evaluatePredeploy(badCheck).fatal.join('\n')).toMatch(/KEK_CHECK_V1 must be 32 hex/);
  });

  it('allows staging', () => {
    const staging = { ...GOOD, vars: { ...GOOD.vars, ENVIRONMENT_NAME: 'staging' } };
    expect(predeploy.evaluatePredeploy(staging).fatal).toEqual([]);
  });
});

describe('post-deploy smoke check', () => {
  const respond =
    (status: number, body = '{}') =>
    () =>
      Promise.resolve(new Response(body, { status }));

  it('passes when /health and /health/ready answer 200', async () => {
    const seen: string[] = [];
    const result = await smoke('https://noti.example', ((url: URL) => {
      seen.push(url.pathname);
      return respond(200)();
    }) as unknown as typeof fetch);
    expect(result.ok).toBe(true);
    expect(seen).toEqual(['/health', '/health/ready']);
  });

  it('fails on a 503, showing the (value-free) body so the operator sees which binding', async () => {
    const result = await smoke(
      'https://noti.example',
      respond(503, '{"ok":false,"misconfigured":["KEK_CHECK_V1"]}'),
    );
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('KEK_CHECK_V1');
  });

  it('fails when the Worker is unreachable', async () => {
    const result = await smoke('https://noti.example', () => Promise.reject(new Error('ECONNREFUSED')));
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('unreachable');
  });
});
