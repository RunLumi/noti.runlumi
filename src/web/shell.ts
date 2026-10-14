/**
 * Serving the dashboard from the same Worker as the API (ADR 0017).
 *
 * TanStack Start runs in SPA mode: the build prerenders one document, `/_shell.html`, and the
 * browser renders every route. This module hands that document out for every navigation and
 * attaches the SPA security headers to it.
 *
 * The shell carries two small inline scripts that Start emits for hydration. The SPA policy
 * deliberately has no `'unsafe-inline'` (src/security/headers.ts), so each inline script is
 * allowed by its SHA-256 hash, computed from the document actually being served. A hash can
 * only match that exact text, so this is as strict as a nonce while keeping the document
 * cacheable and the policy testable.
 */
import { SPA_HEADERS } from '../security/headers';

/** Everything the API Worker owns. Anything else is the dashboard. */
export function isBackendPath(pathname: string): boolean {
  return /^\/(api|webhooks|github|health)(\/|$)/.test(pathname);
}

const SHELL_PATH = '/_shell.html';

/** Bodies of `<script>` elements that have no `src`, in document order. */
export function inlineScripts(html: string): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = match[1] ?? '';
    if (/\ssrc\s*=/i.test(` ${attrs}`)) continue;
    // A CSP hash covers the text the HTML parser produces, not the bytes on the wire. Start
    // writes a raw NUL into its route ids; the parser turns it into U+FFFD, and a line
    // break written as CR LF into LF. Hash what the browser will see.
    const body = (match[2] ?? '').replace(/\r\n?/g, '\n').replaceAll('\u0000', '\uFFFD');
    if (body.length > 0) out.push(body);
  }
  return out;
}

function toBase64(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** CSP source expressions (`'sha256-…'`) for each distinct inline script. */
export async function scriptHashSources(html: string): Promise<string[]> {
  const unique = [...new Set(inlineScripts(html))];
  return Promise.all(
    unique.map(async (body) => {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
      return `'sha256-${toBase64(digest)}'`;
    }),
  );
}

/** Add hash sources to the `script-src` directive of a policy. Other directives are untouched. */
export function allowScriptHashes(csp: string, sources: readonly string[]): string {
  if (sources.length === 0) return csp;
  return csp
    .split(';')
    .map((directive) => {
      const trimmed = directive.trim();
      return /^script-src(\s|$)/.test(trimmed) ? `${trimmed} ${sources.join(' ')}` : trimmed;
    })
    .join('; ');
}

export type ShellEnv = { readonly ASSETS?: Fetcher };

/** What the dashboard may do beyond serving the built shell. Both are build/dev tooling. */
export interface DashboardOptions {
  /** `vite dev`: there is no built shell, Start's dev server renders the document. */
  readonly devServer?: boolean;
  /** Renders the document with Start. Used only by the dev server and by the build's prerender. */
  readonly render?: (request: Request) => Promise<Response> | Response;
}

/** The header Start's build sends when it prerenders the SPA shell. */
export const START_SHELL_HEADER = 'X-TSS_SHELL';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * True only for the build's own prerender request: the exact header value, to a loopback host.
 * A request reaching a deployed Worker carries the custom domain, never a loopback name.
 */
export function isPrerenderRequest(request: Request): boolean {
  return request.headers.get(START_SHELL_HEADER) === 'true' && LOCAL_HOSTS.has(new URL(request.url).hostname);
}

/** Extensions served from the assets layer. Anything else is a client route, even with a dot. */
const STATIC_EXTENSION =
  /\.(?:js|mjs|css|map|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|txt|json|xml|webmanifest)$/i;

function plain(status: number, message: string, extra: Record<string, string> = {}): Response {
  return new Response(message, {
    status,
    headers: { ...SPA_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...extra },
  });
}

/**
 * Answer a non-API request with the built shell. Start's renderer is used in exactly two
 * situations and can never run in production:
 *  - `devServer` (`vite dev`), where no shell has been built; or
 *  - the build's own prerender request (`isPrerenderRequest`) while `/_shell.html` does not
 *    exist yet. Once the shell is built, as it always is in a deployment, the renderer is
 *    unreachable whatever the request says.
 */
export async function serveDashboard(
  request: Request,
  env: ShellEnv,
  options: DashboardOptions = {},
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return plain(405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
  if (options.devServer && options.render) return options.render(request);
  const assets = env.ASSETS;
  if (!assets) return plain(503, 'Dashboard assets are not bound');
  const url = new URL(request.url);
  // A path that names a static file is answered from the assets layer, so a missing script is a
  // 404, never the app.
  if (STATIC_EXTENSION.test(url.pathname)) {
    const res = await assets.fetch(request);
    if (res.ok || res.status === 304) return res;
    // `_headers` marks /assets/* immutable for a year, and a miss must not inherit that. The
    // miss also carries the baseline headers, which `_headers` does not reach on a Worker response.
    const headers = new Headers(res.headers);
    for (const [name, value] of Object.entries(SPA_HEADERS)) headers.set(name, value);
    headers.set('Cache-Control', 'no-store');
    return new Response(res.body, { status: res.status, headers });
  }
  const shell = await assets.fetch(new Request(new URL(SHELL_PATH, url), { method: 'GET' }));
  if (!shell.ok) {
    if (options.render && isPrerenderRequest(request)) return options.render(request);
    return plain(503, 'Dashboard is not available');
  }
  const html = await shell.text();
  const csp = allowScriptHashes(SPA_HEADERS['Content-Security-Policy'] ?? '', await scriptHashSources(html));
  return new Response(request.method === 'HEAD' ? null : html, {
    status: 200,
    headers: {
      ...SPA_HEADERS,
      'Content-Security-Policy': csp,
      'Content-Type': 'text/html; charset=utf-8',
      // The document names fingerprinted assets, so it must always be revalidated.
      'Cache-Control': 'no-cache',
    },
  });
}
