/**
 * Security response headers (docs/specs/15-security-and-compliance.md; docs/THREAT_MODEL.md).
 *
 * Two surfaces, two policies:
 *  - The API normally serves JSON, redirects and webhook acks. Its default CSP is `default-src 'none'`.
 *  - The React SPA is a TanStack Start build in SPA mode, served by the same Worker (ADR 0017).
 *    Two paths carry its headers: the Worker, which serves the HTML shell for every
 *    navigation (src/web/shell.ts, with script hashes added to the CSP), and the static assets
 *    layer, which serves fingerprinted files under /assets/* directly using
 *    `web/public/_headers`, which Vite copies into `web/dist/client`. The file is rendered
 *    from the constants below by `renderHeadersFile()`, and a test fails if it drifts, so
 *    there is one source of truth.
 */
import type { MiddlewareHandler } from 'hono';

/** One year. No `preload`: eligibility is judged on the apex domain, which is a separate decision. */
const HSTS = 'max-age=31536000; includeSubDomains';

/** Features this product never uses. Passkeys (`publickey-credentials-*`) stay allowed. */
const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()';

const COMMON_HEADERS: Readonly<Record<string, string>> = {
  'Strict-Transport-Security': HSTS,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': PERMISSIONS_POLICY,
  'Cross-Origin-Opener-Policy': 'same-origin',
  // Legacy equivalent of frame-ancestors for browsers that ignore CSP.
  'X-Frame-Options': 'DENY',
};

/** Default API policy; the script-free GitHub choice page explicitly adds self-hosted styles. */
export const API_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * SPA policy. Nonce-free and `'unsafe-inline'`-free on purpose: the build emits external module
 * scripts and stylesheets, with self-hosted fonts and bundled SVGs. TanStack Start adds two
 * small inline bootstrap scripts to the shell document; the Worker allows exactly those by
 * SHA-256 hash when it serves the document (src/web/shell.ts), so this base policy stays
 * strict for every other response. React sets `style` through the CSSOM, which CSP does not
 * restrict. `connect-src 'self'` is correct because the API is same-origin.
 */
export const SPA_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

export const API_HEADERS: Readonly<Record<string, string>> = {
  ...COMMON_HEADERS,
  'Content-Security-Policy': API_CSP,
};

export const SPA_HEADERS: Readonly<Record<string, string>> = {
  ...COMMON_HEADERS,
  'Content-Security-Policy': SPA_CSP,
};

/** Apply headers without clobbering one a route set deliberately. Returns a new Response. */
export function withSecurityHeaders(
  res: Response,
  headers: Readonly<Record<string, string>> = API_HEADERS,
): Response {
  // Responses from fetch() and Response.redirect() have immutable headers; always rebuild.
  const out = new Response(res.body, res);
  for (const [name, value] of Object.entries(headers))
    if (!out.headers.has(name)) out.headers.set(name, value);
  return out;
}

/** Hono middleware: mount first so every response, including errors, is covered. */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.res = withSecurityHeaders(c.res);
};

/** Cloudflare `_headers` file content for the SPA (Pages / Workers static assets format). */
export function renderHeadersFile(): string {
  const block = (path: string, headers: Readonly<Record<string, string>>): string =>
    `${path}\n${Object.entries(headers)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join('\n')}\n`;
  return [
    '# Rendered from src/security/headers.ts. Do not edit by hand:',
    '# tests/security/headers.test.ts fails when this file drifts from the source.',
    '',
    block('/*', SPA_HEADERS),
    block('/assets/*', { 'Cache-Control': 'public, max-age=31536000, immutable' }),
    block('/_shell.html', { 'Cache-Control': 'no-cache' }),
  ].join('\n');
}
