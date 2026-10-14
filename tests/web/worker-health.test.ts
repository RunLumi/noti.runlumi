import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings, DeliveryMessage } from '../../src/env';
import { BOOT_ENV } from '../support/boot-env';
import { createFakeD1, type FakeD1 } from '../support/d1';

/**
 * The probes are reachable in a DEPLOYMENT (H1): `src/worker.ts` is imported for real, with the real
 * Hono app behind it, and `/health/ready` must be answered by the API, never by the SPA shell. Only
 * TanStack Start's renderer is replaced, by a recorder that must stay unused.
 */
const start = vi.hoisted(() => ({ fetched: [] as string[] }));
vi.mock('@tanstack/react-start/server-entry', () => ({
  default: {
    fetch: (request: Request) => {
      start.fetched.push(request.url);
      return new Response('rendered by start');
    },
  },
}));

const { default: worker } = await import('../../src/worker');

const SHELL = '<!doctype html><html><body><script>boot()</script></body></html>';
const assets = {
  fetch: (input: RequestInfo | URL) => {
    const { pathname } = new URL(input instanceof Request ? input.url : String(input));
    return Promise.resolve(
      pathname === '/_shell.html' ? new Response(SHELL) : new Response('missing', { status: 404 }),
    );
  },
} as unknown as Fetcher;

let db: FakeD1;
const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

const envWith = (over: Partial<Bindings> = {}): Bindings =>
  ({
    ...BOOT_ENV,
    DELIVERY_QUEUE: { send: (_m: DeliveryMessage) => Promise.resolve() } as unknown as Queue<DeliveryMessage>,
    DB: db.d1,
    ASSETS: assets,
    APP_ORIGIN: 'https://noti.example',
    ...over,
  }) as unknown as Bindings;

const downDb = {
  prepare: () => {
    throw new Error('D1_ERROR: Network connection lost.');
  },
} as unknown as D1Database;

beforeEach(() => {
  db = createFakeD1();
  start.fetched.length = 0;
  for (const level of ['info', 'warn', 'error'] as const)
    vi.spyOn(console, level).mockImplementation(() => undefined);
});

describe('src/worker.ts serves the probes from the API', () => {
  it('GET /health/ready is 200 JSON when healthy, never the shell', async () => {
    const res = await worker.fetch(new Request('https://noti.example/health/ready'), envWith(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ ok: true, checks: { config: true, d1: true, queue: true } });
  });

  it('GET /health/ready is 503 JSON with D1 down, never the shell', async () => {
    const res = await worker.fetch(
      new Request('https://noti.example/health/ready'),
      envWith({ DB: downDb }),
      ctx,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const text = await res.text();
    expect(text).not.toContain('boot()');
    expect(JSON.parse(text)).toEqual({ ok: false, checks: { config: true, d1: false, queue: true } });
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(start.fetched).toEqual([]);
  });

  it('GET /health stays JSON, and lookalikes still get the dashboard', async () => {
    const health = await worker.fetch(
      new Request('https://noti.example/health'),
      envWith({ DB: downDb }),
      ctx,
    );
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, service: 'lumi-noti' });
    for (const path of ['/healthz', '/health-check', '/healthy']) {
      const res = await worker.fetch(new Request(`https://noti.example${path}`), envWith(), ctx);
      expect(await res.text(), path).toBe(SHELL);
    }
  });
});
