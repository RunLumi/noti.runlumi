/**
 * `returnTo`: where to send someone after they sign in (spec 14 F205).
 *
 * An open redirect on a sign-in handoff is the cheapest account-takeover path in a product with
 * emailed invitations, so only a same-origin, path-relative value is ever followed. Everything
 * else is dropped and the person lands on the Overview. The value is re-parsed against the
 * page's own origin and rebuilt from its parts, so what is returned is never the raw input.
 */
const MAX_LENGTH = 2048;
/** Pages a person should not be sent "back" to: they would bounce straight back or loop. */
const AUTH_PAGES = new Set(['/signin', '/signup', '/forgot-password', '/verify', '/reset']);
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const CONTROL = /[\u0000-\u001f\u007f]/;

export function safeReturnTo(raw: unknown, origin: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LENGTH) return null;
  // Absolute and protocol-relative URLs, and the backslash spellings browsers treat as `/`.
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || CONTROL.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return null;
  }
  if (url.origin !== new URL(origin).origin) return null;
  if (AUTH_PAGES.has(url.pathname.replace(/\/+$/, ''))) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The `returnTo` value for the page the visitor was on, or `null` for the Overview (no point carrying it). */
export function returnToFor(location: { pathname: string; search: string; hash?: string }): string | null {
  const here = `${location.pathname}${location.search}${location.hash ?? ''}`;
  return here === '/' ? null : here;
}
