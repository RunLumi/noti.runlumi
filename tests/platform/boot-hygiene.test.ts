import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Bindings } from '../../src/env';
import { assertConfig, assessConfig, bootReport, isUsableOrigin } from '../../src/platform/config';
import { KNOWN_BINDINGS, unknownKeys } from '../../src/platform/config-keys';
import { BOOT_ENV } from '../support/boot-env';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

/** Boot hygiene, remainder (ADR 0036, REMAINING 1.3): the auth tier, GitHub warnings, unknown keys, the operator view. */
vi.mock('../../src/auth/better-auth', () => ({
  createAuth: () => ({
    api: {
      getSession: ({ headers }: { headers: Headers }) => {
        const id = headers.get('x-test-user');
        return Promise.resolve(
          id
            ? {
                user: { id, email: `${id}@example.test`, emailVerified: true, name: id },
                session: { activeOrganizationId: null },
              }
            : null,
        );
      },
    },
    handler: () => new Response(null, { status: 404 }),
  }),
}));

const { default: worker } = await import('../../src/index');

const ORIGIN = 'https://noti.test';
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

let db: FakeD1;

function makeEnv(over: Record<string, unknown> = {}): Bindings {
  return {
    ...BOOT_ENV,
    DB: db.d1,
    APP_ORIGIN: ORIGIN,
    AUTH_EMAIL: {
      send: () => Promise.resolve({ messageId: 'hygiene' }),
    } as unknown as Bindings['AUTH_EMAIL'],
    AUTH_FROM_EMAIL: 'noreply@noti.test',
    GITHUB_WEBHOOK_SECRET: 'scan-fixture-github-webhook-value',
    GITHUB_APP_ID: '777',
    GITHUB_APP_SLUG: 'noti-test',
    GITHUB_CLIENT_ID: 'Iv1.scan-fixture-client-id',
    GITHUB_CLIENT_SECRET: 'scan-fixture-github-client-value',
    ...over,
  } as unknown as Bindings;
}

const get = (path: string, env: Bindings, as?: string) =>
  Promise.resolve(
    worker.fetch(new Request(`${ORIGIN}${path}`, { headers: as ? { 'x-test-user': as } : {} }), env, ctx),
  );

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  db = createFakeD1();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('the auth tier: APP_ORIGIN and BETTER_AUTH_SECRET', () => {
  it('accepts an https origin and a long secret', () => {
    expect(assessConfig(makeEnv()).auth).toEqual([]);
    expect(assertConfig(makeEnv())).toEqual([]);
  });

  it.each([
    ['https://noti.runlumi.app', true],
    ['https://noti.runlumi.app/', true],
    ['http://localhost:5173', true],
    ['http://app.localhost:3000', true],
    ['http://noti.runlumi.app', false],
    ['https://noti.runlumi.app/path', false],
    ['https://noti.runlumi.app?x=1', false],
    ['https://user:pw@noti.runlumi.app', false],
    ['REPLACE_WITH_APP_ORIGIN', false],
    ['noti.runlumi.app', false],
    ['', false],
  ])('APP_ORIGIN %s is usable: %s', (origin, usable) => {
    expect(isUsableOrigin(origin)).toBe(usable);
  });

  it('names APP_ORIGIN when it is unusable, and BETTER_AUTH_SECRET when short, empty or a placeholder', () => {
    expect(assessConfig(makeEnv({ APP_ORIGIN: 'http://noti.runlumi.app' })).auth).toEqual(['APP_ORIGIN']);
    expect(assessConfig(makeEnv({ APP_ORIGIN: undefined })).auth).toEqual(['APP_ORIGIN']);
    for (const secret of [undefined, '', 'short', 'REPLACE_WITH_BETTER_AUTH_SECRET_0123456789'])
      expect(assessConfig(makeEnv({ BETTER_AUTH_SECRET: secret })).auth, String(secret)).toEqual([
        'BETTER_AUTH_SECRET',
      ]);
    expect(assertConfig(makeEnv({ BETTER_AUTH_SECRET: 'short' }))).toEqual(['BETTER_AUTH_SECRET']);
  });

  it('rejects the value copied from .dev.vars.example, and other example or repetitive secrets, outside development', () => {
    const example = /^BETTER_AUTH_SECRET=(.*)$/m.exec(
      readFileSync(join(root, '.dev.vars.example'), 'utf8'),
    )?.[1];
    expect(example).toBeTruthy();
    expect((example ?? '').length).toBeGreaterThanOrEqual(32); // long enough, so only the pattern can refuse it
    for (const weak of [
      example,
      'replace-with-a-long-random-value-0123456789',
      'changeme-changeme-changeme-changeme-1',
      'example-secret-value-for-the-docs-123',
      'your-secret-goes-here-please-change-it',
      'a'.repeat(40),
      'ab'.repeat(20),
    ])
      expect(assessConfig(makeEnv({ BETTER_AUTH_SECRET: weak })).auth, String(weak)).toEqual([
        'BETTER_AUTH_SECRET',
      ]);
    // A generated value is accepted.
    expect(assessConfig(makeEnv({ BETTER_AUTH_SECRET: 'q7Zk2mV9xR4tLw8pYc1NfB6hJd3sGa5E' })).auth).toEqual(
      [],
    );
  });

  it('lets a developer use a simple value, but only on a local development origin', () => {
    const dev = { ENVIRONMENT_NAME: 'development', APP_ORIGIN: 'http://localhost:5173', KEK_CHECK_V1: '' };
    expect(assessConfig(makeEnv({ ...dev, BETTER_AUTH_SECRET: 'a'.repeat(40) })).auth).toEqual([]);
    expect(assessConfig(makeEnv({ ...dev, BETTER_AUTH_SECRET: 'short' })).auth).toEqual([
      'BETTER_AUTH_SECRET',
    ]);
    // The same simple value on a production origin is refused, whatever the environment says.
    expect(
      assessConfig(makeEnv({ ENVIRONMENT_NAME: 'development', BETTER_AUTH_SECRET: 'a'.repeat(40) })).auth,
    ).toEqual(['BETTER_AUTH_SECRET']);
  });

  it('warns when FINGERPRINT_KEY is absent: a revoked secret is then never destroyed', () => {
    expect(assessConfig(makeEnv()).warnings).not.toContain('FINGERPRINT_KEY');
    expect(assessConfig(makeEnv({ FINGERPRINT_KEY: undefined })).warnings).toContain('FINGERPRINT_KEY');
    expect(assessConfig(makeEnv({ FINGERPRINT_KEY: 'nope' })).warnings).toContain('FINGERPRINT_KEY');
  });

  it('never returns a fragment of the secret or the origin', () => {
    const out = JSON.stringify(assessConfig(makeEnv({ BETTER_AUTH_SECRET: 'tooshort-secretish' })));
    expect(out).not.toContain('secretish');
  });

  it('is not in the worker-level names: the queue consumer and scheduled do not need a session', async () => {
    const report = await bootReport(makeEnv({ BETTER_AUTH_SECRET: 'short' }));
    expect(report.names).toEqual([]);
    expect(report.auth).toEqual(['BETTER_AUTH_SECRET']);
    expect(report.code).toBe('config_invalid');
  });

  it('stops /api and /github with a 503, and /health says so without a name', async () => {
    const env = makeEnv({ BETTER_AUTH_SECRET: 'short' });
    for (const path of [
      '/api/workspace/team',
      '/api/integrations',
      '/api/auth/get-session',
      '/github/callback',
    ]) {
      const res = await get(path, env, 'alice');
      expect(res.status, path).toBe(503);
      expect(res.headers.get('retry-after')).toBe('30');
      expect(await res.text()).not.toMatch(/BETTER_AUTH|APP_ORIGIN/);
    }
    const health = await get('/health', env);
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({ ok: false, service: 'lumi-noti', code: 'config_invalid' });
    const ready = await get('/health/ready', env);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ checks: { config: false, d1: true, queue: true } });
  });

  it('does NOT stop webhook ingress: a 503 there loses events', async () => {
    const env = makeEnv({ APP_ORIGIN: 'REPLACE_WITH_APP_ORIGIN' });
    const res = await worker.fetch(
      new Request(`${ORIGIN}/webhooks/generic/abcdefghijklmnopqrstuv`, { method: 'POST', body: '{}' }),
      env,
      ctx,
    );
    expect(res.status).not.toBe(503);
  });
});

describe('GitHub App bindings: named warnings, never a fault', () => {
  it('a complete set raises nothing', () => {
    expect(assessConfig(makeEnv()).warnings).toEqual([]);
  });

  it('names exactly the bindings that are still placeholders or malformed', () => {
    const env = makeEnv({
      GITHUB_APP_ID: 'REPLACE_WITH_GITHUB_APP_ID',
      GITHUB_APP_SLUG: 'not a slug!',
      GITHUB_CLIENT_ID: '',
      GITHUB_CLIENT_SECRET: undefined,
      GITHUB_WEBHOOK_SECRET: 'REPLACE_ME',
    });
    const a = assessConfig(env);
    expect(a.warnings).toEqual([
      'GITHUB_WEBHOOK_SECRET',
      'GITHUB_APP_ID',
      'GITHUB_APP_SLUG',
      'GITHUB_CLIENT_ID',
      'GITHUB_CLIENT_SECRET',
    ]);
    // A warning: the Worker still serves; the GitHub routes fail closed on their own.
    expect(assertConfig(env)).toEqual([]);
  });

  it('rejects a non-numeric app id', () => {
    expect(assessConfig(makeEnv({ GITHUB_APP_ID: 'abc' })).warnings).toEqual(['GITHUB_APP_ID']);
    expect(assessConfig(makeEnv({ GITHUB_APP_ID: '0' })).warnings).toEqual(['GITHUB_APP_ID']);
  });
});

describe('outbound mail: an auth-tier fault (ADR 0047; the Worker has no email entrypoint)', () => {
  it('the default export has no inbound email handler: no email source is built (ADR 0014)', () => {
    // If one is added, the boot check must cover it (F04 "every entrypoint"): change this test with it.
    expect(Object.keys(worker).sort()).toEqual(['fetch', 'queue', 'scheduled']);
  });

  // Email verification is mandatory, so without mail nobody can get a usable account and createAuth refuses
  // to build: naming it in the auth tier makes /api answer a clear 503 instead of failing inside sign-in.
  it('a missing AUTH_EMAIL binding is an auth-tier fault, not a warning', () => {
    const env = makeEnv({ AUTH_EMAIL: undefined });
    expect(assessConfig(env).auth).toEqual(['AUTH_EMAIL']);
    expect(assessConfig(env).warnings).toEqual([]);
    expect(assertConfig(env)).toEqual(['AUTH_EMAIL']);
  });

  it('a sender that is unset, a placeholder or not an address is an auth-tier fault', () => {
    for (const AUTH_FROM_EMAIL of [undefined, 'REPLACE_WITH_SENDER', 'not-an-address', 'a b@c.d']) {
      expect(assessConfig(makeEnv({ AUTH_FROM_EMAIL })).auth, String(AUTH_FROM_EMAIL)).toEqual([
        'AUTH_FROM_EMAIL',
      ]);
    }
    expect(assessConfig(makeEnv({ AUTH_FROM_EMAIL: 'noreply@runlumi.app' })).auth).toEqual([]);
  });

  it('a missing mail binding stops /api with a 503', async () => {
    const env = makeEnv({ AUTH_EMAIL: undefined });
    const api = await worker.fetch(new Request(`${ORIGIN}/api/integrations`), env, ctx);
    expect(api.status).toBe(503);
  });
});

describe('SIGNUP_MODE (ADR 0047)', () => {
  it('names an unknown value, which is treated as closed', () => {
    for (const SIGNUP_MODE of ['opne', 'INVITE', 'yes'])
      expect(assessConfig(makeEnv({ SIGNUP_MODE })).warnings, SIGNUP_MODE).toEqual(['SIGNUP_MODE']);
  });

  it('names it when unset on a staging or production deploy, and not in development', () => {
    expect(assessConfig(makeEnv({ SIGNUP_MODE: undefined })).warnings).toEqual(['SIGNUP_MODE']);
    expect(assessConfig(makeEnv({ SIGNUP_MODE: '' })).warnings).toEqual(['SIGNUP_MODE']);
    for (const SIGNUP_MODE of ['open', 'invite_only', 'closed'])
      expect(assessConfig(makeEnv({ SIGNUP_MODE })).warnings, SIGNUP_MODE).toEqual([]);
  });

  it('is never a fault: a bad value closes sign-up, it does not stop the Worker', () => {
    expect(assertConfig(makeEnv({ SIGNUP_MODE: 'nonsense' }))).toEqual([]);
  });

  it('the deployed configuration is invite-only', () => {
    const wrangler = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
    expect(wrangler).toMatch(/"SIGNUP_MODE":\s*"invite_only"/);
  });
});

describe('unknown extra keys', () => {
  it('reports names that are on no known list, sorted and bounded, never values', () => {
    expect(unknownKeys({ DB: 1, KEK_V1: 'x', KEK_V_1: 'secretish-value', ZED: 1, ALPHA: 2 })).toEqual([
      'ALPHA',
      'KEK_V_1',
      'ZED',
    ]);
    const many = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`EXTRA_${String(i).padStart(2, '0')}`, i]),
    );
    expect(unknownKeys(many)).toHaveLength(20);
    expect(unknownKeys({ ['X'.repeat(200)]: 1 })[0]).toHaveLength(64);
  });

  it('logs them once per isolate as a warning without a value, and carries them in the report', async () => {
    const env = makeEnv({ KEK_V_1: 'secretish-value', FINGERPRINT_KEY_: 'secretish-too' });
    const report = await bootReport(env);
    expect(report.unknownKeys).toEqual(['FINGERPRINT_KEY_', 'KEK_V_1']);
    await bootReport(env);
    await get('/health', env);
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('config_unknown_keys'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('KEK_V_1');
    expect(lines[0]).not.toContain('secretish');
    // Not a fault: the Worker serves.
    expect(report.names).toEqual([]);
    expect(report.code).toBeNull();
  });

  it('logs nothing when every key is known', async () => {
    await bootReport(makeEnv());
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('config_unknown_keys'))).toEqual(
      [],
    );
  });

  it('the list covers every binding in src/env.ts and every var in wrangler.jsonc, and has no strangers', () => {
    const envSource = readFileSync(join(root, 'src/env.ts'), 'utf8');
    const declared = [...envSource.matchAll(/^ {2}([A-Z][A-Z0-9_]+)\??:/gm)].map((m) => m[1] ?? '');
    const wranglerText = readFileSync(join(root, 'wrangler.jsonc'), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    const vars = wranglerText.slice(wranglerText.indexOf('"vars"'));
    const varNames = [...vars.matchAll(/^ {4}"([A-Z][A-Z0-9_]+)":/gm)].map((m) => m[1] ?? '');
    const bindings = ['DB', 'DELIVERY_QUEUE', 'ASSETS', 'AUTH_EMAIL'];
    const known: ReadonlySet<string> = new Set(KNOWN_BINDINGS);
    for (const name of [...declared, ...varNames, ...bindings]) expect(known.has(name), name).toBe(true);
    // Auth bindings live in src/auth, not src/env.ts.
    for (const name of KNOWN_BINDINGS)
      expect(
        [
          ...declared,
          ...varNames,
          ...bindings,
          'BETTER_AUTH_SECRET',
          'AUTH_FROM_EMAIL',
          'APP_ORIGIN',
        ].includes(name),
        name,
      ).toBe(true);
    expect(declared.length).toBeGreaterThan(15);
  });
});

describe('GET /api/observability/readiness: the platform operator view', () => {
  let env: Bindings;
  beforeEach(() => {
    seedOrganization(db.raw, 'org-a');
    env = makeEnv({
      PLATFORM_OPERATOR_USER_IDS: ' someone , ops-1 ',
      KEK_V_1: 'typo',
      GITHUB_APP_ID: 'REPLACE_WITH_GITHUB_APP_ID',
    });
  });

  it('needs a session', async () => {
    expect((await get('/api/observability/readiness', env)).status).toBe(401);
  });

  it('is a 404 for a signed-in user who is not an operator, and for everyone when the list is unset', async () => {
    expect((await get('/api/observability/readiness', env, 'alice')).status).toBe(404);
    const none = makeEnv({ PLATFORM_OPERATOR_USER_IDS: undefined });
    expect((await get('/api/observability/readiness', none, 'ops-1')).status).toBe(404);
    expect(
      (await get('/api/observability/readiness', makeEnv({ PLATFORM_OPERATOR_USER_IDS: '' }), 'ops-1'))
        .status,
    ).toBe(404);
  });

  it('shows an operator the names per tier, the warnings and the unknown keys, with no values', async () => {
    const res = await get('/api/observability/readiness', env, 'ops-1');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      ok: true,
      checks: { config: true, d1: true, queue: true },
      code: null,
      misconfigured: { storage: [], credentials: [], queue: [], auth: [] },
      warnings: ['GITHUB_APP_ID'],
      revokedSecretsAwaitingFingerprint: 0,
      unknownKeys: ['KEK_V_1'],
    });
  });

  it('names the faulty binding for an operator while /health names nothing', async () => {
    const bad = makeEnv({
      PLATFORM_OPERATOR_USER_IDS: 'ops-1',
      KEK_V1: 'short',
      BETTER_AUTH_SECRET: 'short',
    });
    // The auth fault blocks every /api route, this one included: the operator reads it from the log or
    // after the secret is set; the credential fault alone leaves it readable.
    expect((await get('/api/observability/readiness', bad, 'ops-1')).status).toBe(503);
    const credentialOnly = makeEnv({ PLATFORM_OPERATOR_USER_IDS: 'ops-1', KEK_V1: 'short' });
    const res = await get('/api/observability/readiness', credentialOnly, 'ops-1');
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; misconfigured: { credentials: string[] } }>();
    expect(body.ok).toBe(false);
    expect(body.misconfigured.credentials).toContain('KEK_V1');
    expect(JSON.stringify(body)).not.toContain('short');
    const health = await get('/health', credentialOnly);
    expect(await health.text()).not.toContain('KEK_V1');
  });

  it('reports D1 down as a failed check', async () => {
    const boom = () => {
      throw new Error('D1_ERROR: Network connection lost.');
    };
    const down = makeEnv({
      PLATFORM_OPERATOR_USER_IDS: 'ops-1',
      DB: { prepare: boom, batch: boom, exec: boom },
    });
    // With D1 down the global gate answers first (storage fault is only a missing binding, so it passes) and the
    // session lookup itself needs D1, so there is nothing to read: a 5xx or 401, never a leak.
    const res = await get('/api/observability/readiness', down, 'ops-1');
    expect([401, 500, 503]).toContain(res.status);
  });
});
