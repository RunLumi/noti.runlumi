import { isBlockedAddress } from './address-policy';

/**
 * Save-time resolution of a customer-chosen webhook host (spec 09 F115). Workers `fetch`
 * cannot be asked what a name resolves to, so the check uses Cloudflare's DNS-over-HTTPS JSON
 * endpoint (`https://cloudflare-dns.com/dns-query`, `accept: application/dns-json`; shape
 * confirmed with a live query on 2026-10-13 from a developer machine, NOT from a Worker).
 *
 * What it does and does not prove, honestly:
 *  - It stops the obvious hostile record: `evil.example` -> `169.254.169.254`, `10.x`, `::1`.
 *  - It does NOT stop DNS rebinding. The answer here is a point-in-time answer from a
 *    different resolver path than the one `fetch` will use at send time. A customer who
 *    controls the zone can return a public address now and a private one later. The send-time
 *    controls are the shape policy (`url-policy.ts`), no redirects, port 443 only, a fixed
 *    signature and timeouts; none of them inspects the connected address.
 *  - It fails CLOSED: if the lookup itself fails the host is refused with a retryable message.
 *
 * Periodic re-resolution of stored hosts, recording the resolved addresses, and a per-workspace
 * host allowlist (the strongest control: it removes the attacker's choice of host) are NOT built.
 */

export type HostCheck =
  | { readonly ok: true; readonly addresses: readonly string[] }
  | { readonly ok: false; readonly reason: 'blocked_address' | 'unresolvable' | 'lookup_failed' };

export type DnsFetcher = (input: string, init: RequestInit) => Promise<Response>;

export const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
export const DNS_TIMEOUT_MS = 3000;
const MAX_ANSWER_BYTES = 16 * 1024;
const TYPE_A = 1;
const TYPE_AAAA = 28;
const RCODE_NOERROR = 0;
const RCODE_NXDOMAIN = 3;

interface Lookup {
  readonly addresses: readonly string[];
  readonly failed: boolean;
}

async function lookup(hostname: string, type: 'A' | 'AAAA', fetcher: DnsFetcher): Promise<Lookup> {
  try {
    const res = await fetcher(`${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`, {
      method: 'GET',
      headers: { accept: 'application/dns-json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
    });
    if (res.status !== 200) return { addresses: [], failed: true };
    const text = await res.text();
    if (text.length > MAX_ANSWER_BYTES) return { addresses: [], failed: true };
    const body: unknown = JSON.parse(text);
    if (typeof body !== 'object' || body === null) return { addresses: [], failed: true };
    const { Status: status, Answer: answer } = body as { Status?: unknown; Answer?: unknown };
    if (status === RCODE_NXDOMAIN) return { addresses: [], failed: false };
    if (status !== RCODE_NOERROR) return { addresses: [], failed: true };
    if (answer === undefined) return { addresses: [], failed: false };
    if (!Array.isArray(answer)) return { addresses: [], failed: true };
    const wanted = type === 'A' ? TYPE_A : TYPE_AAAA;
    const addresses = answer.flatMap((a: unknown) => {
      if (typeof a !== 'object' || a === null) return [];
      const { type: t, data } = a as { type?: unknown; data?: unknown };
      return t === wanted && typeof data === 'string' ? [data] : [];
    });
    return { addresses, failed: false };
  } catch {
    return { addresses: [], failed: true };
  }
}

/** Resolve `hostname` (A and AAAA) and refuse it if any address is private or reserved. */
export async function checkResolvedHost(
  hostname: string,
  fetcher: DnsFetcher = (input, init) => fetch(input, init),
): Promise<HostCheck> {
  const [a, aaaa] = await Promise.all([lookup(hostname, 'A', fetcher), lookup(hostname, 'AAAA', fetcher)]);
  const addresses = [...a.addresses, ...aaaa.addresses];
  // Any blocked address is decisive, even when the other family failed to resolve.
  if (addresses.some(isBlockedAddress)) return { ok: false, reason: 'blocked_address' };
  if (a.failed || aaaa.failed) return { ok: false, reason: 'lookup_failed' };
  if (addresses.length === 0) return { ok: false, reason: 'unresolvable' };
  return { ok: true, addresses };
}
