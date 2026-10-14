import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SPA_CSP, SPA_HEADERS } from '../../src/security/headers';
import {
  allowScriptHashes,
  inlineScripts,
  isBackendPath,
  scriptHashSources,
  serveDashboard,
} from '../../src/web/shell';

const sha256 = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

const SHELL = [
  '<!DOCTYPE html><html><head><link rel="stylesheet" href="/assets/a.css"/></head><body>',
  '<script data-tsr-stream-part="">var a = 1;</script>',
  '<script type="module" async="" src="/assets/index.js"></script>',
  '<script>document.currentScript.remove();</script>',
  '</body></html>',
].join('');

function assetsFor(files: Record<string, { body: string; status?: number }>): Fetcher {
  return {
    fetch: (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      const file = files[path];
      return Promise.resolve(
        file
          ? new Response(file.body, { status: file.status ?? 200 })
          : new Response('nope', { status: 404 }),
      );
    },
  } as unknown as Fetcher;
}

describe('isBackendPath', () => {
  it.each([
    '/api/auth/sign-in/email',
    '/api',
    '/webhooks/github',
    '/webhooks/generic/abc',
    '/github/callback',
    '/health',
    '/health/ready',
    '/health/',
  ])('%s belongs to the API Worker', (path) => expect(isBackendPath(path)).toBe(true));
  it.each([
    '/',
    '/signin',
    '/integrations/abc',
    '/apiary',
    '/healthz',
    '/healthy',
    '/health-check',
    '/healthready',
    '/github-app',
    '/_serverFn/x',
    '/webhooksx',
  ])('%s belongs to the dashboard', (path) => expect(isBackendPath(path)).toBe(false));
});

describe('inlineScripts', () => {
  it('returns only scripts without src, in order', () => {
    expect(inlineScripts(SHELL)).toEqual(['var a = 1;', 'document.currentScript.remove();']);
  });

  it('hashes what the HTML parser produces: NUL becomes U+FFFD and CRLF becomes LF', () => {
    const html = '<script>a\u0000b\r\nc\rd</script>';
    expect(inlineScripts(html)).toEqual(['a�b\nc\nd']);
  });

  it('ignores empty scripts', () => {
    expect(inlineScripts('<script></script><script src="/x.js"></script>')).toEqual([]);
  });
});

describe('scriptHashSources', () => {
  it('produces CSP sha256 sources that equal an independent hash, once per distinct body', async () => {
    const html = '<script>x()</script><script>x()</script><script>y()</script>';
    expect(await scriptHashSources(html)).toEqual([sha256('x()'), sha256('y()')]);
  });
});

describe('allowScriptHashes', () => {
  it('adds hashes to script-src only and keeps every other directive', () => {
    const csp = allowScriptHashes(SPA_CSP, ["'sha256-abc='"]);
    expect(csp).toContain("script-src 'self' 'sha256-abc='");
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp.match(/sha256/g)).toHaveLength(1);
  });

  it('returns the policy unchanged when there is nothing to allow', () => {
    expect(allowScriptHashes(SPA_CSP, [])).toBe(SPA_CSP);
  });
});

describe('serveDashboard', () => {
  const assets = assetsFor({
    '/_shell.html': { body: SHELL },
    '/assets/app.js': { body: 'console.error' },
  });

  it('serves the shell for any navigation, with the SPA headers and a hash-extended CSP', async () => {
    for (const path of ['/', '/signin', '/integrations/int_1?created=true']) {
      const res = await serveDashboard(new Request(`https://noti.example${path}`), { ASSETS: assets });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('strict-transport-security')).toBe(SPA_HEADERS['Strict-Transport-Security']);
      expect(res.headers.get('content-security-policy')).toBe(
        allowScriptHashes(SPA_CSP, [sha256('var a = 1;'), sha256('document.currentScript.remove();')]),
      );
      expect(await res.text()).toBe(SHELL);
    }
  });

  it('never allows unsafe-inline, eval or a foreign origin in the served policy', async () => {
    const res = await serveDashboard(new Request('https://noti.example/team'), { ASSETS: assets });
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).not.toMatch(/unsafe-/);
    expect(csp).not.toMatch(/https?:/);
  });

  it('answers HEAD without a body', async () => {
    const res = await serveDashboard(new Request('https://noti.example/', { method: 'HEAD' }), {
      ASSETS: assets,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('refuses other methods rather than serving the app for a POST', async () => {
    const res = await serveDashboard(new Request('https://noti.example/signin', { method: 'POST' }), {
      ASSETS: assets,
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });

  it('passes static files through and never answers a missing file with the app', async () => {
    const hit = await serveDashboard(new Request('https://noti.example/assets/app.js'), { ASSETS: assets });
    expect(hit.status).toBe(200);
    expect(await hit.text()).toBe('console.error');
    const miss = await serveDashboard(new Request('https://noti.example/assets/missing.js'), {
      ASSETS: assets,
    });
    expect(miss.status).toBe(404);
    expect(miss.headers.get('cache-control')).toBe('no-store');
    // The miss carries the same baseline headers as every other response.
    expect(miss.headers.get('content-security-policy')).toBe(SPA_CSP);
    expect(miss.headers.get('x-content-type-options')).toBe('nosniff');
    expect(miss.headers.get('x-frame-options')).toBe('DENY');
  });

  it('treats a dotted last segment as a client route unless it is a known static extension', async () => {
    for (const path of ['/integrations/v1.2', '/invite/jo.smith', '/team/a.b.c', '/x.php', '/index.html']) {
      const res = await serveDashboard(new Request(`https://noti.example${path}`), { ASSETS: assets });
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toBe(SHELL);
    }
    for (const path of ['/favicon.ico', '/assets/x.woff2', '/assets/x.css', '/assets/x.JS']) {
      const res = await serveDashboard(new Request(`https://noti.example${path}`), { ASSETS: assets });
      expect(res.status, path).toBe(404);
    }
  });

  it('fails closed when the shell or the assets binding is missing', async () => {
    const noShell = await serveDashboard(new Request('https://noti.example/'), { ASSETS: assetsFor({}) });
    expect(noShell.status).toBe(503);
    const noBinding = await serveDashboard(new Request('https://noti.example/'), {});
    expect(noBinding.status).toBe(503);
  });
});

describe('serveDashboard and the renderer', () => {
  const shell = assetsFor({ '/_shell.html': { body: SHELL } });
  const noShell = assetsFor({});
  const PRERENDER = { 'X-TSS_SHELL': 'true' };
  const request = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });
  const rendered = () => {
    const calls: string[] = [];
    return { calls, render: (req: Request) => (calls.push(req.url), new Response('rendered')) };
  };

  it('renders in the dev server without a built shell', async () => {
    const { calls, render } = rendered();
    const res = await serveDashboard(
      request('http://localhost:5173/signin'),
      {},
      { devServer: true, render },
    );
    expect(await res.text()).toBe('rendered');
    expect(calls).toHaveLength(1);
  });

  it('renders the build prerender request only: exact header, loopback host, no shell yet', async () => {
    const { calls, render } = rendered();
    const res = await serveDashboard(
      request('http://localhost:4173/', PRERENDER),
      { ASSETS: noShell },
      { render },
    );
    expect(await res.text()).toBe('rendered');
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['a built shell exists (every deployment)', 'http://localhost:4173/', PRERENDER, shell],
    ['a deployed hostname', 'https://noti.example/', PRERENDER, noShell],
    ['the header value is not exactly true', 'http://localhost:4173/', { 'X-TSS_SHELL': 'TRUE' }, noShell],
    ['the header value is empty', 'http://localhost:4173/', { 'X-TSS_SHELL': '' }, noShell],
    ['there is no header', 'http://localhost:4173/', {}, noShell],
    ['a lookalike host', 'http://localhost.evil.example/', PRERENDER, noShell],
  ])('never renders when %s', async (_why, url, headers, assets) => {
    const { calls, render } = rendered();
    const res = await serveDashboard(request(url, headers), { ASSETS: assets }, { render });
    expect(calls).toEqual([]);
    expect(await res.text()).not.toBe('rendered');
  });

  it('ignores devServer when no renderer is supplied', async () => {
    const res = await serveDashboard(
      request('https://noti.example/'),
      { ASSETS: shell },
      { devServer: true },
    );
    expect(await res.text()).toBe(SHELL);
  });
});
