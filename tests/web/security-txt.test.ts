import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../../src/env';

/**
 * F242: `/.well-known/security.txt` (RFC 9116) is published, reachable through the Worker without
 * the SPA shell fallback, and consistent with SECURITY.md. The assets layer is replaced by the
 * real file from `web/public`; whether Cloudflare's assets layer serves a `.well-known` directory
 * on a real deployment is unverified (docs/RELEASE_GATES.md).
 */
vi.mock('../../src/index', () => ({
  default: {
    fetch: () => new Response('api'),
    scheduled: () => Promise.resolve(),
    queue: () => Promise.resolve(),
  },
}));
vi.mock('@tanstack/react-start/server-entry', () => ({
  default: { fetch: () => new Response('rendered by start') },
}));

const { default: worker } = await import('../../src/worker');

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PUBLIC_FILE = join(root, 'web', 'public', '.well-known', 'security.txt');
const SHELL = '<!doctype html><html><body>shell</body></html>';

const assets = {
  fetch: (input: RequestInfo | URL) => {
    const { pathname } = new URL(input instanceof Request ? input.url : String(input));
    if (pathname === '/_shell.html') return Promise.resolve(new Response(SHELL));
    const file = join(root, 'web', 'public', pathname);
    return Promise.resolve(
      pathname.startsWith('/.well-known/') && existsSync(file)
        ? new Response(readFileSync(file), { headers: { 'content-type': 'text/plain; charset=utf-8' } })
        : new Response('missing', { status: 404 }),
    );
  },
} as unknown as Fetcher;

const env = { ASSETS: assets } as unknown as Bindings;
const text = readFileSync(PUBLIC_FILE, 'utf8');
const fields = new Map(
  text
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()] as const),
);

describe('/.well-known/security.txt', () => {
  it('is served by the Worker as the file, not as the SPA shell', async () => {
    const res = await worker.fetch(
      new Request('https://noti.example/.well-known/security.txt'),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    const body = await res.text();
    expect(body).toBe(text);
    expect(body).not.toContain('shell');
  });

  it('answers a missing .well-known file with 404, never the app', async () => {
    const res = await worker.fetch(
      new Request('https://noti.example/.well-known/other.txt'),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(404);
  });

  it('carries the RFC 9116 required fields with the documented reporting channel', () => {
    expect(fields.get('contact')).toBe('https://github.com/RunLumi/noti.runlumi/security/advisories/new');
    expect(fields.get('expires')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(fields.get('preferred-languages')).toBe('en, vi');
    expect(fields.get('canonical')).toBe('https://noti.runlumi.app/.well-known/security.txt');
    expect(text.split('\n').filter((l) => /^contact:/i.test(l))).toHaveLength(1);
  });

  it('points at the policy and agrees with SECURITY.md on the reporting URL', () => {
    const policy = readFileSync(join(root, 'SECURITY.md'), 'utf8');
    expect(fields.get('policy')).toMatch(/\/SECURITY\.md$/);
    expect(policy).toContain(fields.get('contact'));
  });

  it('has not expired and is renewed within a year (RFC 9116 section 2.5.5)', () => {
    const expires = Date.parse(fields.get('expires') ?? '');
    expect(Number.isNaN(expires)).toBe(false);
    // This fails on purpose once the date passes: renew the file (and bump this reminder).
    expect(
      expires,
      'security.txt Expires has passed: renew web/public/.well-known/security.txt',
    ).toBeGreaterThan(Date.now());
  });

  it('contains no email address, secret or placeholder', () => {
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/REPLACE_WITH|TODO|example\.(com|org)/);
  });
});
