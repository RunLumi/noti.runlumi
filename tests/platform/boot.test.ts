import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { configRetryDelaySeconds } from '../../src/index';
import type { Bindings, DeliveryMessage } from '../../src/env';
import { kekCheckValue, type EnvironmentName } from '../../src/crypto/fingerprint';
import { parseKeyHex } from '../../src/crypto/envelope';
import {
  assertConfig,
  assessConfig,
  bootReport,
  isLocalOrigin,
  kekMismatches,
} from '../../src/platform/config';
import { createFakeD1, type FakeD1 } from '../support/d1';

const KEK_1 = '11'.repeat(32);
const KEK_2 = '22'.repeat(32);
const LEGACY = 'aa'.repeat(32);
const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

let db: FakeD1;
const sends: DeliveryMessage[] = [];

async function check(kek: string, environment: EnvironmentName): Promise<string> {
  return kekCheckValue(parseKeyHex(kek), environment);
}

async function makeEnv(over: Partial<Bindings> = {}): Promise<Bindings> {
  return {
    DB: db.d1,
    DELIVERY_QUEUE: {
      send: (m: DeliveryMessage) => {
        sends.push(m);
        return Promise.resolve();
      },
    } as unknown as Queue<DeliveryMessage>,
    APP_ORIGIN: 'https://noti.test',
    GITHUB_WEBHOOK_SECRET: 'scan-fixture-github-webhook-value',
    GITHUB_APP_ID: '777',
    KEK_V1: KEK_1,
    KEK_V2: '',
    KMS_ACTIVE_VERSION: '1',
    ENCRYPTION_KEY: LEGACY,
    ENVIRONMENT_NAME: 'production',
    KEK_CHECK_V1: await check(KEK_1, 'production'),
    KEK_CHECK_V2: '',
    ...over,
  } as Bindings;
}

const get = (path: string, env: Bindings) =>
  Promise.resolve(worker.fetch(new Request(`https://noti.test${path}`), env, ctx));

/** A D1 whose every call fails like a platform outage. */
function downDb(): D1Database {
  const boom = () => {
    throw new Error('D1_ERROR: Network connection lost.');
  };
  return { prepare: boom, batch: boom, exec: boom } as unknown as D1Database;
}

beforeEach(() => {
  db = createFakeD1();
  sends.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('assessConfig tiers (F04, ADR 0022)', () => {
  it('accepts a complete configuration', async () => {
    expect(assessConfig(await makeEnv())).toEqual({ storage: [], credentials: [], queue: [], warnings: [] });
    expect(assertConfig(await makeEnv())).toEqual([]);
  });

  it('puts each binding in its tier', async () => {
    expect(assessConfig(await makeEnv({ DB: undefined as never })).storage).toEqual(['DB']);
    expect(assessConfig(await makeEnv({ DELIVERY_QUEUE: undefined as never })).queue).toEqual([
      'DELIVERY_QUEUE',
    ]);
    expect(assessConfig(await makeEnv({ ENVIRONMENT_NAME: 'prod' })).credentials).toEqual([
      'ENVIRONMENT_NAME',
    ]);
    expect(assessConfig(await makeEnv({ ENVIRONMENT_NAME: undefined as never })).credentials).toContain(
      'ENVIRONMENT_NAME',
    );
    const ring = assessConfig(await makeEnv({ KEK_V1: 'short', KMS_ACTIVE_VERSION: '3' }));
    expect(ring.credentials).toEqual(expect.arrayContaining(['KEK_V1', 'KEK_V2', 'KMS_ACTIVE_VERSION']));
  });

  it('requires a verifiable check value outside development, and rejects a malformed one', async () => {
    expect(assessConfig(await makeEnv({ KEK_CHECK_V1: '' })).credentials).toEqual(['KEK_CHECK_V1']);
    expect(assessConfig(await makeEnv({ KEK_CHECK_V1: 'xyz' })).credentials).toEqual(['KEK_CHECK_V1']);
  });

  it('a second KEK without a check value is a rotation-window warning, not a fault', async () => {
    const rotating = await makeEnv({ KEK_V2: KEK_2, KMS_ACTIVE_VERSION: '2' });
    const a = assessConfig(rotating);
    expect(a.credentials).toEqual([]);
    expect(a.warnings).toEqual(['KEK_CHECK_V2']);
    // After the old KEK is gone the remaining one must carry its own check value.
    const after = assessConfig(await makeEnv({ KEK_V1: '', KEK_V2: KEK_2, KMS_ACTIVE_VERSION: '2' }));
    expect(after.credentials).toEqual(['KEK_CHECK_V2']);
  });

  it('a malformed optional key is a warning, never a fault', async () => {
    const a = assessConfig(await makeEnv({ ENCRYPTION_KEY: 'nope', FINGERPRINT_KEY: 'nope' }));
    expect(a.credentials).toEqual([]);
    expect(a.warnings).toEqual(['ENCRYPTION_KEY', 'FINGERPRINT_KEY']);
    expect(assertConfig(await makeEnv({ ENCRYPTION_KEY: 'nope' }))).toEqual([]);
  });

  it('accepts development only on a local origin, so a deploy cannot opt out of the check', async () => {
    const dev = (origin: string) =>
      makeEnv({ ENVIRONMENT_NAME: 'development', KEK_CHECK_V1: '', APP_ORIGIN: origin });
    for (const ok of [
      'http://localhost:5173',
      'http://127.0.0.1:8787',
      'http://[::1]:3000',
      'http://app.localhost:3000',
    ])
      expect(assessConfig(await dev(ok)).credentials, ok).toEqual([]);
    for (const bad of ['https://noti.runlumi.app', 'https://localhost.evil.test', 'not a url', ''])
      expect(assessConfig(await dev(bad)).credentials, bad).toEqual(['ENVIRONMENT_NAME']);
    expect(isLocalOrigin(undefined)).toBe(false);
  });

  it('never returns a value, a length or a fragment of one', async () => {
    const env = await makeEnv({ KEK_V1: 'not-hex-but-secretish', ENCRYPTION_KEY: 'also-secretish' });
    const out = JSON.stringify([assertConfig(env), assessConfig(env)]);
    expect(out).not.toContain('secretish');
    expect(out).not.toContain(KEK_1);
  });
});

describe('KEK check value (F34 kek_environment_mismatch)', () => {
  it('is stable, one-way and differs by key and by environment', async () => {
    const a = await check(KEK_1, 'production');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await check(KEK_1, 'production')).toBe(a);
    expect(await check(KEK_1, 'staging')).not.toBe(a);
    expect(await check(KEK_2, 'production')).not.toBe(a);
    expect(a).not.toContain(KEK_1.slice(0, 8));
  });

  it('passes for the right KEK and names the binding for a foreign one', async () => {
    expect(await kekMismatches(await makeEnv())).toEqual([]);
    const foreign = await makeEnv({ KEK_V1: KEK_2, KEK_CHECK_V1: await check(KEK_1, 'production') });
    expect(await kekMismatches(foreign)).toEqual(['KEK_CHECK_V1']);
    const wrongEnv = await makeEnv({ KEK_CHECK_V1: await check(KEK_1, 'staging') });
    expect(await kekMismatches(wrongEnv)).toEqual(['KEK_CHECK_V1']);
  });

  it('reports the mismatch code, and tiers it as a credential fault', async () => {
    const report = await bootReport(await makeEnv({ KEK_V1: KEK_2 }));
    expect(report).toMatchObject({
      names: ['KEK_CHECK_V1'],
      credentials: ['KEK_CHECK_V1'],
      code: 'kek_environment_mismatch',
    });
    expect(await bootReport(await makeEnv({ ENVIRONMENT_NAME: 'x' }))).toMatchObject({
      code: 'config_invalid',
    });
  });

  it('never rejects: an error inside the check is a config_invalid report', async () => {
    const env = await makeEnv();
    Object.defineProperty(env, 'KEK_V1', {
      get() {
        throw new Error('boom');
      },
    });
    const report = await bootReport(env);
    expect(report).toMatchObject({ code: 'config_invalid', names: ['KEK_CHECK'] });
    // A result that could not be computed is not remembered: the next call computes again.
    await expect(bootReport(env)).resolves.toMatchObject({ code: 'config_invalid' });
  });
});

describe('GET /health (F10)', () => {
  it('is 200 with a minimal body', async () => {
    const res = await get('/health', await makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'lumi-noti' });
  });

  it('stays 200 when D1 is down: it is liveness and configuration, not a dependency probe', async () => {
    expect((await get('/health', await makeEnv({ DB: downDb() }))).status).toBe(200);
  });

  it('503s naming the binding for a bad key ring, never a value', async () => {
    const res = await get('/health', await makeEnv({ KEK_V1: 'short' }));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toContain('KEK_V1');
    expect(text).not.toContain('short');
    expect(JSON.parse(text)).toMatchObject({ ok: false, code: 'config_invalid' });
  });

  it('503s with kek_environment_mismatch when the KEK belongs to another environment', async () => {
    const res = await get('/health', await makeEnv({ KEK_V1: KEK_2 }));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      ok: false,
      service: 'lumi-noti',
      code: 'kek_environment_mismatch',
      misconfigured: ['KEK_CHECK_V1'],
    });
    expect(text).not.toContain(KEK_2);
    expect(text).not.toContain(await check(KEK_1, 'production'));
  });

  it('lists optional-binding faults as warnings on a 200', async () => {
    const res = await get('/health', await makeEnv({ ENCRYPTION_KEY: 'nope' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'lumi-noti', warnings: ['ENCRYPTION_KEY'] });
  });

  it('carries the security headers and a correlation id', async () => {
    const res = await get('/health', await makeEnv({ KEK_V1: 'short' }));
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('GET /health/ready (F10)', () => {
  it('is 200 with booleans only when config, D1 and the queue binding are fine', async () => {
    const res = await get('/health/ready', await makeEnv());
    expect(res.status).toBe(200);
    // A freshly migrated database still holds the 0026 `_old` originals: a warning, never a failure.
    expect(await res.json()).toEqual({
      ok: true,
      checks: { config: true, d1: true, queue: true },
      warnings: ['migration_0026_old_tables_present'],
    });
    expect(sends).toEqual([]); // a presence check, never a real message
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('503s naming the failing dependency when D1 is down', async () => {
    const res = await get('/health/ready', await makeEnv({ DB: downDb() }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, checks: { config: true, d1: false, queue: true } });
  });

  it('503s when D1 rejects asynchronously', async () => {
    const rejecting = {
      prepare: () => ({ first: () => Promise.reject(new Error('D1_ERROR: D1 DB is overloaded.')) }),
    } as unknown as D1Database;
    const res = await get('/health/ready', await makeEnv({ DB: rejecting }));
    expect(res.status).toBe(503);
    expect((await res.json<{ checks: { d1: boolean } }>()).checks.d1).toBe(false);
  });

  it('503s when the queue binding is missing', async () => {
    const res = await get('/health/ready', await makeEnv({ DELIVERY_QUEUE: undefined as never }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      checks: { config: false, d1: true, queue: false },
      warnings: ['migration_0026_old_tables_present'],
    });
  });

  it('503s on a bad key ring and a foreign KEK, and leaks no names or values', async () => {
    for (const over of [{ KEK_V1: 'short' }, { KEK_V1: KEK_2 }]) {
      const res = await get('/health/ready', await makeEnv(over));
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ ok: false, checks: { config: false } });
      expect(text).not.toMatch(/KEK|short|[0-9a-f]{32}/);
    }
  });

  it('caches the answer for 5 seconds per isolate, so a public caller cannot drive D1 queries', async () => {
    let probes = 0;
    const counting = {
      prepare: (sql: string) => {
        if (/SELECT 1 AS ok/.test(sql)) probes++;
        return db.d1.prepare(sql);
      },
    } as unknown as D1Database;
    const env = await makeEnv({ DB: counting });
    for (let i = 0; i < 5; i++) expect((await get('/health/ready', env)).status).toBe(200);
    expect(probes).toBe(1);
    vi.setSystemTime(Date.now() + 6000);
    expect((await get('/health/ready', env)).status).toBe(200);
    expect(probes).toBe(2);
  });

  it('clears its timeout timer once D1 has answered', async () => {
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    await get('/health/ready', await makeEnv());
    expect(clear).toHaveBeenCalled();
  });
});

describe('what a configuration fault stops (H3, M3)', () => {
  const post = (path: string, env: Bindings, method = 'POST') =>
    Promise.resolve(
      worker.fetch(
        new Request(`https://noti.test${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          ...(method === 'GET' ? {} : { body: '{}' }),
        }),
        env,
        ctx,
      ),
    );

  it('a KEK or check-value fault does NOT stop webhook ingress: nothing there opens a credential', async () => {
    for (const over of [
      { KEK_V1: KEK_2 },
      { KEK_V1: 'short' },
      { KEK_CHECK_V1: '' },
      { ENVIRONMENT_NAME: 'x' },
    ]) {
      const env = await makeEnv(over);
      const generic = await post('/webhooks/generic/abcdefghijklmnopqrstuv', env);
      expect(generic.status, JSON.stringify(over)).toBe(404);
      const github = await post('/webhooks/github', env);
      expect(github.status).not.toBe(503);
      const gitlab = await post('/webhooks/gitlab/abcdefghijklmnopqrstuv', env);
      expect(gitlab.status).not.toBe(503);
    }
  });

  it('a malformed optional ENCRYPTION_KEY, or a missing queue binding, stops no request', async () => {
    for (const over of [{ ENCRYPTION_KEY: 'nope' }, { DELIVERY_QUEUE: undefined as never }]) {
      const env = await makeEnv(over);
      expect((await post('/webhooks/generic/abcdefghijklmnopqrstuv', env)).status).toBe(404);
    }
  });

  it('only a missing D1 stops everything, and the probes still answer', async () => {
    const env = await makeEnv({ DB: undefined as never });
    for (const path of [
      '/webhooks/github',
      '/webhooks/generic/abcdefghijklmnopqrstuv',
      '/api/integrations',
    ]) {
      const res = await post(path, env, path.startsWith('/api') ? 'GET' : 'POST');
      expect(res.status, path).toBe(503);
      // A webhook sender also gets our correlation id (F50); the API's 503 body is unchanged.
      expect(await res.json()).toEqual({
        error: 'Service unavailable',
        ...(path.startsWith('/webhooks') ? { correlation_id: res.headers.get('x-request-id') } : {}),
      });
      expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(res.headers.get('x-request-id')).toBeTruthy();
    }
    expect((await get('/health', env)).status).toBe(503);
    expect((await get('/health/ready', env)).status).toBe(503);
  });
});

describe('queue entrypoint (H2)', () => {
  function batch(queue: string, attempts: number[]) {
    const messages = attempts.map((n) => ({ body: { id: 'x' }, attempts: n, ack: vi.fn(), retry: vi.fn() }));
    const retryAll = vi.fn();
    return { b: { queue, messages, retryAll } as unknown as MessageBatch<unknown>, messages, retryAll };
  }

  it('retries each delivery message on its own, growing delay, and consumes nothing', async () => {
    const { b, messages, retryAll } = batch('noti-deliveries', [1, 2, 3]);
    const prepare = vi.fn();
    const env = await makeEnv({ KEK_V1: KEK_2, DB: { prepare } as unknown as D1Database });
    await worker.queue(b, env);
    expect(messages.map((m) => m.retry.mock.calls[0])).toEqual([
      [{ delaySeconds: 300 }],
      [{ delaySeconds: 600 }],
      [{ delaySeconds: 1200 }],
    ]);
    for (const m of messages) expect(m.ack).not.toHaveBeenCalled();
    expect(retryAll).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('never acks or dead-letters on the boot gate, even past the queue retry budget', async () => {
    const { b, messages } = batch('noti-deliveries', [6, 12, 40]);
    await worker.queue(b, await makeEnv({ KEK_V1: KEK_2 }));
    for (const m of messages) {
      expect(m.ack).not.toHaveBeenCalled();
      expect(m.retry).toHaveBeenCalledTimes(1);
    }
    expect(
      messages.map((m) => (m.retry.mock.calls[0] as [{ delaySeconds: number }])[0].delaySeconds),
    ).toEqual([9600, 43_200, 43_200]);
  });

  it('the delay schedule spans hours inside the five retries of wrangler.jsonc and caps at 12 hours', () => {
    const span = [1, 2, 3, 4, 5].map(configRetryDelaySeconds).reduce((a, b) => a + b, 0);
    expect(span).toBeGreaterThan(2 * 3600);
    expect(configRetryDelaySeconds(100)).toBe(43_200);
    expect(configRetryDelaySeconds(0)).toBe(300);
  });

  it('does not gate the dead-letter consumer: it only needs D1, and it records the dead letter', async () => {
    db.raw.prepare("INSERT INTO \"organization\"(id,name,slug,created_at) VALUES('org-a','a','a',1)").run();
    db.raw
      .prepare(
        "INSERT INTO deliveries(id,integration_id,organization_id,state) VALUES('d1','i1','org-a','retrying')",
      )
      .run();
    const message = {
      body: {
        id: 'd1',
        integrationId: 'i1',
        organizationId: 'org-a',
        title: 't',
        url: 'https://example.test/',
      },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const b = {
      queue: 'noti-dead-letters',
      messages: [message],
      retryAll: vi.fn(),
    } as unknown as MessageBatch<unknown>;
    await worker.queue(b, await makeEnv({ KEK_V1: KEK_2 })); // credential fault
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(db.raw.prepare("SELECT state FROM deliveries WHERE id='d1'").get()).toEqual({
      state: 'dead_lettered',
    });
  });
});

describe('scheduled entrypoint (F04, L1)', () => {
  it('fails visibly naming bindings, but records its heartbeat first so the outage is measurable', async () => {
    const env = await makeEnv({ KEK_V1: KEK_2 });
    await expect(worker.scheduled({} as ScheduledEvent, env)).rejects.toThrow(/config_invalid: KEK_CHECK_V1/);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM ops_state WHERE key='cron_heartbeat'").get()).toEqual({
      n: 1,
    });
  });

  it('still throws when D1 itself is the problem', async () => {
    await expect(
      worker.scheduled({} as ScheduledEvent, await makeEnv({ DB: undefined as never })),
    ).rejects.toThrow(/config_invalid: DB/);
  });

  it('runs the tick when configuration is valid, and skips only the legacy migration for a malformed key', async () => {
    await expect(worker.scheduled({} as ScheduledEvent, await makeEnv())).resolves.toBeUndefined();
    await expect(
      worker.scheduled({} as ScheduledEvent, await makeEnv({ ENCRYPTION_KEY: 'nope' })),
    ).resolves.toBeUndefined();
    expect(
      vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes('legacy_key_malformed')),
    ).toBe(true);
  });
});
