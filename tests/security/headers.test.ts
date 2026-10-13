import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  API_CSP,
  API_HEADERS,
  SPA_CSP,
  SPA_HEADERS,
  renderHeadersFile,
  securityHeaders,
  withSecurityHeaders,
} from '../../src/security/headers';

function parseCsp(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name, sources);
  }
  return out;
}

describe.each([
  ['SPA', SPA_CSP],
  ['API', API_CSP],
])('%s CSP', (_label, csp) => {
  const directives = parseCsp(csp);
  const sources = [...directives.values()].flat();

  it('has no unsafe-inline or unsafe-eval in script-src or default-src', () => {
    for (const d of ['script-src', 'default-src']) {
      const list = directives.get(d) ?? [];
      expect(list).not.toContain("'unsafe-inline'");
      expect(list).not.toContain("'unsafe-eval'");
    }
  });

  it('has no unsafe-inline anywhere (style-src included)', () => {
    expect(sources).not.toContain("'unsafe-inline'");
  });

  it('has no wildcard, scheme-only or third-party sources', () => {
    for (const s of sources) {
      expect(s).not.toBe('*');
      expect(s).not.toMatch(/\*/);
      expect(s).not.toMatch(/^https?:/);
      expect(s).not.toMatch(/^(https?|ws|wss|blob|filesystem):/);
    }
  });

  it('forbids framing, plugins and base-tag injection', () => {
    expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
    expect(directives.has('base-uri')).toBe(true);
  });
});

describe('SPA CSP specifics', () => {
  const d = parseCsp(SPA_CSP);
  it('restricts script-src to self and connect-src to self', () => {
    expect(d.get('script-src')).toEqual(["'self'"]);
    expect(d.get('connect-src')).toEqual(["'self'"]);
    expect(d.get('object-src')).toEqual(["'none'"]);
  });
  it('permits only data: images beyond self', () => {
    expect(d.get('img-src')).toEqual(["'self'", 'data:']);
  });
});

describe('header set', () => {
  it.each([
    ['API', API_HEADERS],
    ['SPA', SPA_HEADERS],
  ])('%s carries the baseline headers', (_l, h) => {
    expect(h['Strict-Transport-Security']).toMatch(/max-age=\d{8,}/);
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(h['Permissions-Policy']).toContain('camera=()');
    expect(h['X-Frame-Options']).toBe('DENY');
  });
});

describe('securityHeaders middleware', () => {
  const app = new Hono();
  app.use('*', securityHeaders);
  app.get('/json', (c) => c.json({ ok: true }));
  app.get('/redirect', () => Response.redirect('https://example.com/', 302));
  app.get('/custom', (c) => c.text('x', 200, { 'referrer-policy': 'no-referrer' }));
  app.onError((_e, c) => c.text('error', 500));
  app.get('/boom', () => {
    throw new Error('boom');
  });

  it('adds headers to normal, immutable-header and error responses', async () => {
    for (const path of ['/json', '/redirect', '/boom', '/missing']) {
      const res = await app.request(path);
      expect(res.headers.get('content-security-policy'), path).toBe(API_CSP);
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
    }
  });

  it('does not clobber a header a route set deliberately', async () => {
    const res = await app.request('/custom');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('preserves status, body and existing headers', async () => {
    const res = withSecurityHeaders(new Response('hi', { status: 201, headers: { 'x-a': '1' } }));
    expect(res.status).toBe(201);
    expect(res.headers.get('x-a')).toBe('1');
    expect(await res.text()).toBe('hi');
  });
});

describe('web/public/_headers', () => {
  it('matches the rendered source of truth', () => {
    expect(readFileSync('web/public/_headers', 'utf8')).toBe(renderHeadersFile());
  });
});
