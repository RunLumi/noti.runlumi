/**
 * Which IP addresses a customer-chosen webhook may never resolve to (spec 09 F115). Pure and
 * exhaustively table-tested; used on the addresses a hostname resolves to at save time
 * (`dns-check.ts`). It is deny-by-default for IPv6: only global unicast `2000::/3` can pass,
 * minus its documented special-purpose blocks.
 *
 * This does NOT make the destination SSRF-proof. A name that resolves to a public address
 * today can resolve to a private one at send time (DNS rebinding), and Workers `fetch`
 * resolves at the edge, where we cannot pin the address. See docs/adr/0014.
 */

/** [network, prefix length], IPv4. Sources: IANA IPv4 Special-Purpose Address Registry (RFC 6890). */
const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including the cloud metadata address 169.254.169.254
  ['172.16.0.0', 12], // RFC 1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including broadcast
];

/** Dotted-quad to a 32-bit number, or `null` when it is not a strict dotted quad. */
export function parseIpv4(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

function inCidr4(address: number, network: string, prefix: number): boolean {
  const base = parseIpv4(network) ?? 0;
  const size = 2 ** (32 - prefix);
  return Math.floor(address / size) === Math.floor(base / size);
}

export function isBlockedIpv4(address: number): boolean {
  return BLOCKED_V4.some(([network, prefix]) => inCidr4(address, network, prefix));
}

/** Eight 16-bit groups, or `null` when the text is not a valid IPv6 address. */
export function parseIpv6(text: string): readonly number[] | null {
  let rest = text.toLowerCase();
  const zone = rest.indexOf('%');
  if (zone >= 0) return null; // a zone id has no place in a resolved public address
  let tail: number[] = [];
  const lastColon = rest.lastIndexOf(':');
  if (rest.includes('.')) {
    const v4 = parseIpv4(rest.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = [Math.floor(v4 / 65536), v4 % 65536];
    rest = rest.slice(0, lastColon + 1) + '0:0';
  }
  const halves = rest.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const groups: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };
  const head = toGroups(halves[0] ?? '');
  const back = halves.length === 2 ? toGroups(halves[1] ?? '') : [];
  if (!head || !back) return null;
  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - back.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...back];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  if (tail.length === 2) groups = [...groups.slice(0, 6), ...tail];
  return groups;
}

function embeddedV4(groups: readonly number[]): number {
  return (groups[6] ?? 0) * 65536 + (groups[7] ?? 0);
}

function isBlockedIpv6(g: readonly number[]): boolean {
  const [g0 = 0, g1 = 0] = g;
  const firstSixZero = g.slice(0, 6).every((x) => x === 0);
  // ::/96 covers `::` (unspecified), `::1` (loopback) and the deprecated IPv4-compatible form.
  if (firstSixZero) return true;
  // IPv4-mapped (::ffff:a.b.c.d): judged by the embedded IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isBlockedIpv4(embeddedV4(g));
  // NAT64 well-known prefix 64:ff9b::/96: judged by the embedded IPv4; the local-use
  // 64:ff9b:1::/48 block is refused outright.
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (g.slice(2, 6).every((x) => x === 0)) return isBlockedIpv4(embeddedV4(g));
    return true;
  }
  // Everything outside global unicast 2000::/3 (unique local fc00::/7, link-local fe80::/10,
  // site-local, multicast ff00::/8, discard 100::/64, ...) is refused.
  if (g0 < 0x2000 || g0 > 0x3fff) return true;
  // Special-purpose blocks inside 2000::/3.
  // 2001::/23 IETF protocol assignments: Teredo, ORCHID, benchmarking and friends.
  if (g0 === 0x2001 && g1 <= 0x01ff) return true;
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation 2001:db8::/32
  if (g0 === 0x2002) return true; // 6to4 2002::/16 embeds an IPv4 address we cannot vouch for
  return false;
}

/**
 * True when `address` (as text, from a DNS answer) must not be reachable. Text that is not an
 * IP address at all is also "blocked": a resolver answer we cannot parse is not trusted.
 */
export function isBlockedAddress(address: string): boolean {
  const v4 = parseIpv4(address);
  if (v4 !== null) return isBlockedIpv4(v4);
  const v6 = parseIpv6(address);
  return v6 === null ? true : isBlockedIpv6(v6);
}
