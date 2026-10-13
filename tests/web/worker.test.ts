import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../../src/env';

/**
 * Behavioural guard for ADR 0017: in a deployment (a built shell exists, a real hostname) no
 * request, whatever its path or headers, reaches TanStack Start. `src/worker.ts` is imported for
 * real; the Hono app and Start's server entry are replaced by recorders.
 */
const start = vi.hoisted(() => ({ imported: 0, fetched: [] as string[] }));
const api = vi.hoisted(() => ({ fetched: [] as string[] }));

vi.mock('@tanstack/react-start/server-entry', () => {
  start.imported += 1;
  return {
    default: {
      fetch: (request: Request) => {
        start.fetched.push(request.url);
        return new Response('rendered by start');
      },
    },
  };
});

vi.mock('../../src/index', () => ({
  default: {
    fetch: (request: Request) => {
      api.fetched.push(request.url);
      return new Response('api');
    },
    scheduled: () => Promise.resolve(),
    queue: () => Promise.resolve(),
  },
}));

const { default: worker } = await import('../../src/worker');

const SHELL = '<!doctype html><html><body><script>boot()</script></body></html>';

function assets(withShell: boolean): Fetcher {
  return {
    fetch: (input: RequestInfo | URL) => {
      const { pathname } = new URL(input instanceof Request ? input.url : String(input));
      return Promise.resolve(
        withShell && pathname === '/_shell.html'
          ? new Response(SHELL)
          : new Response('missing', { status: 404 }),
      );
    },
  } as unknown as Fetcher;
}

const envWith = (withShell: boolean) => ({ ASSETS: assets(withShell) }) as unknown as Bindings;
const ctx = {} as ExecutionContext;

async function call(url: string, headers: Record<string, string> = {}, withShell = true) {
  const res = await worker.fetch(new Request(url, { headers }), envWith(withShell), ctx);
  return { res, body: await res.text() };
}

beforeEach(() => {
  start.fetched.length = 0;
  api.fetched.length = 0;
});

describe('src/worker.ts in a deployment', () => {
  const HEADER_SETS: ReadonlyArray<Record<string, string>> = [
    {},
    { 'X-TSS_SHELL': 'true' },
    { 'X-TSS_SHELL': 'false' },
    { 'x-tss_shell': 'true', 'x-tsr-serverFn': 'true', Accept: 'text/html' },
  ];

  it.each(['/_serverFn/abc', '/_serverFn/', '/anything', '//x', '/%5FserverFn/x', '/a/../_serverFn/x'])(
    '%s gets the shell and never reaches Start, with or without the prerender header',
    async (path) => {
      for (const headers of HEADER_SETS) {
        const { res, body } = await call(`https://noti.example${path}`, headers);
        expect(res.status, JSON.stringify(headers)).toBe(200);
        expect(body).toBe(SHELL);
        expect(res.headers.get('content-security-policy')).toMatch(/script-src 'self' 'sha256-/);
      }
      expect(start.fetched).toEqual([]);
      expect(start.imported).toBe(0);
    },
  );

  it('does not even render for the loopback host once the shell exists', async () => {
    for (const path of ['/_serverFn/x', '/signin', '//x']) {
      const { body } = await call(`http://localhost:5173${path}`, { 'X-TSS_SHELL': 'true' });
      expect(body).toBe(SHELL);
    }
    expect(start.fetched).toEqual([]);
  });

  it('refuses non-GET requests to Start paths with a 405, not an app page', async () => {
    const res = await worker.fetch(
      new Request('https://noti.example/_serverFn/x', { method: 'POST', body: '{}' }),
      envWith(true),
      ctx,
    );
    expect(res.status).toBe(405);
    expect(start.fetched).toEqual([]);
  });

  it('answers 503 when the shell is missing, still without Start', async () => {
    const { res } = await call('https://noti.example/_serverFn/x', { 'X-TSS_SHELL': 'true' }, false);
    expect(res.status).toBe(503);
    expect(start.fetched).toEqual([]);
    expect(start.imported).toBe(0);
  });

  it('keeps the API surface on the Hono app', async () => {
    for (const path of ['/api/auth/x', '/webhooks/github', '/github/callback', '/health']) {
      const { body } = await call(`https://noti.example${path}`);
      expect(body, path).toBe('api');
    }
    expect(start.fetched).toEqual([]);
  });

  it('exports the cron and queue handlers', () => {
    expect(typeof worker.scheduled).toBe('function');
    expect(typeof worker.queue).toBe('function');
  });
});

describe('src/worker.ts while building', () => {
  it('renders through Start only for the prerender request, before the shell exists', async () => {
    const { body } = await call('http://localhost:4173/', { 'X-TSS_SHELL': 'true' }, false);
    expect(body).toBe('rendered by start');
    expect(start.fetched).toEqual(['http://localhost:4173/']);
  });
});
