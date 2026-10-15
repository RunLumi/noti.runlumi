import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../../src/env';
import { BOOT_ENV } from '../support/boot-env';
import { createFakeD1 } from '../support/d1';

/**
 * `GET /api/public/signup-mode` (ADR 0048): the sign-up page's notice. Public, cacheable, the same answer for
 * everyone, and it reveals only the deployment-wide mode: no input is read and no database row is touched, so
 * it cannot say anything about an address. Better Auth is replaced so a call into it would be visible.
 */
const auth = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../src/auth/better-auth', () => ({
  createAuth: () => {
    auth.calls++;
    return { api: { getSession: () => Promise.resolve(null) }, handler: () => new Response('auth') };
  },
}));
const { app } = await import('../../src/index');

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

function envWith(mode: string | undefined): { env: Bindings; touched: () => number } {
  const { d1 } = createFakeD1();
  let touched = 0;
  // Counts CALLS, not property reads: the boot check only looks for `prepare` to exist.
  const DB = new Proxy(d1, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function' || !['prepare', 'batch', 'exec'].includes(String(prop))) return value;
      return (...args: unknown[]) => {
        touched++;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const { SIGNUP_MODE: _unused, ...base } = BOOT_ENV;
  const env = {
    ...base,
    DB,
    APP_ORIGIN: 'https://noti.test',
    SIGNUP_ALLOWLIST: 'ops@example.test',
    ...(mode === undefined ? {} : { SIGNUP_MODE: mode }),
  } as unknown as Bindings;
  return { env, touched: () => touched };
}

const get = (env: Bindings, path = '/api/public/signup-mode', init?: RequestInit) =>
  app.fetch(new Request(`https://noti.test${path}`, init), env, ctx);

beforeEach(() => {
  auth.calls = 0;
  for (const level of ['info', 'warn', 'error'] as const)
    vi.spyOn(console, level).mockImplementation(() => undefined);
});

describe('GET /api/public/signup-mode', () => {
  it.each([
    ['open', 'open'],
    ['invite_only', 'invite_only'],
    [' closed ', 'closed'],
  ] as const)('answers SIGNUP_MODE=%j as %s', async (raw, mode) => {
    const res = await get(envWith(raw).env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode });
  });

  it('reads unset as open and an unknown value as closed, exactly as the sign-up hook does', async () => {
    expect(await (await get(envWith(undefined).env)).json()).toEqual({ mode: 'open' });
    expect(await (await get(envWith('OPEN').env)).json()).toEqual({ mode: 'closed' });
    expect(await (await get(envWith('true').env)).json()).toEqual({ mode: 'closed' });
  });

  it('needs no session, touches no database row and never calls Better Auth', async () => {
    const { env, touched } = envWith('invite_only');
    const res = await get(env);
    expect(res.status).toBe(200);
    expect(touched()).toBe(0);
    expect(auth.calls).toBe(0);
  });

  it('is cacheable for a minute and is JSON with the API security headers', async () => {
    const res = await get(envWith('invite_only').env);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('reveals only the mode: an address in the query, a header or a cookie changes nothing', async () => {
    const { env } = envWith('invite_only');
    const plain = await (await get(env)).text();
    const probes = [
      await get(env, '/api/public/signup-mode?email=ops@example.test'),
      await get(env, '/api/public/signup-mode?email=stranger@example.test'),
      await get(env, '/api/public/signup-mode', { headers: { cookie: 'better-auth.session_token=x' } }),
    ];
    for (const res of probes) {
      const body = await res.text();
      expect(body).toBe(plain);
      expect(Object.keys(JSON.parse(body) as object)).toEqual(['mode']);
    }
  });

  it('is GET only: a write to it is refused like any unmapped /api route', async () => {
    const res = await get(envWith('open').env, '/api/public/signup-mode', {
      method: 'POST',
      headers: { origin: 'https://noti.test', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});
