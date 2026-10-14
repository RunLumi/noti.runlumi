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

/** Percent-decode up to twice (a double-encoded `%252e` must not slip through); undecodable input is refused. */
function decodedTwice(path: string): string | null {
  try {
    return decodeURIComponent(decodeURIComponent(path));
  } catch {
    return null;
  }
}

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
  const rebuilt = `${url.pathname}${url.search}${url.hash}`;
  // The checks above ran on the raw text, but the parser collapses dot-segments: `/.//evil.com`
  // and `/a/..//evil.com` rebuild to `//evil.com`, which a browser reads as another host. So the
  // REBUILT value is what is validated, including what its path says once percent-decoded.
  const decoded = decodedTwice(url.pathname);
  if (
    decoded === null ||
    !rebuilt.startsWith('/') ||
    rebuilt.startsWith('//') ||
    decoded.startsWith('//') ||
    // Doubly-encoded dot-segments or empty segments are never a page of ours; refuse rather than guess.
    decoded
      .split('/')
      .slice(1)
      .some(
        (segment, i, all) => segment === '.' || segment === '..' || (segment === '' && i < all.length - 1),
      ) ||
    decoded.includes('\\') ||
    CONTROL.test(decoded)
  )
    return null;
  return rebuilt;
}

/** Where to go after signing in: the validated `returnTo` of the current address, else the Overview. */
export function destinationAfterSignIn(search: string, origin: string): string {
  return safeReturnTo(new URLSearchParams(search).get('returnTo'), origin) ?? '/';
}

/** The `returnTo` value for the page the visitor was on, or `null` for the Overview (no point carrying it). */
export function returnToFor(location: { pathname: string; search: string; hash?: string }): string | null {
  const here = `${location.pathname}${location.search}${location.hash ?? ''}`;
  return here === '/' ? null : here;
}
