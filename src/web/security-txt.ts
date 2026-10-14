/**
 * `/.well-known/security.txt` (RFC 9116), generated per request so `Expires` can never go stale: a
 * static file would carry a fixed date that eventually passes and silently makes the file invalid.
 * `Expires` is always `EXPIRES_IN_DAYS` ahead (RFC 9116 asks for under a year).
 *
 * The Worker answers this path itself, before the dashboard: it is not a static asset (there is no
 * file under `web/public/.well-known`, so the assets layer cannot shadow it) and it must never fall
 * through to the SPA shell. `Contact` is the repository's private vulnerability reporting form:
 * no email address is documented, so none is invented (SECURITY.md).
 */
import { SPA_HEADERS } from '../security/headers';

export const SECURITY_TXT_PATH = '/.well-known/security.txt';
export const EXPIRES_IN_DAYS = 90;
export const SECURITY_CONTACT = 'https://github.com/RunLumi/noti.runlumi/security/advisories/new';
export const SECURITY_POLICY = 'https://github.com/RunLumi/noti.runlumi/blob/main/SECURITY.md';

export function securityTxt(origin: string, now: Date): string {
  const expires = new Date(now.getTime() + EXPIRES_IN_DAYS * 86_400_000);
  return [
    '# Lumi Noti vulnerability disclosure (RFC 9116). The policy is SECURITY.md in the repository.',
    '# This is a best-effort channel for an engineering-alpha product; it is not a bug bounty.',
    `Contact: ${SECURITY_CONTACT}`,
    `Expires: ${expires.toISOString()}`,
    'Preferred-Languages: en, vi',
    `Policy: ${SECURITY_POLICY}`,
    `Canonical: ${new URL(SECURITY_TXT_PATH, origin).toString()}`,
    '',
  ].join('\n');
}

export function serveSecurityTxt(request: Request, appOrigin: string, now: Date = new Date()): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { ...SPA_HEADERS, Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' },
    });
  return new Response(request.method === 'HEAD' ? null : securityTxt(appOrigin, now), {
    status: 200,
    headers: {
      ...SPA_HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
      // Short, so a changed Contact reaches researchers soon; `Expires` moves with every response.
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
