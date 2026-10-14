import { hostLabelOf, isAllowedHost, registryEntryFor } from './provider-registry';
import type { DestinationKind } from './types';

/**
 * Outbound SSRF boundary (F96/F102). Runs at configuration write time and again at send
 * time. A rejection names the rule that failed and never echoes the URL, which is a bearer
 * secret.
 */

export const MAX_DESTINATION_URL_LENGTH = 2048;

export type UrlRejectionRule =
  | 'malformed'
  | 'too_long'
  | 'whitespace_or_control'
  | 'scheme'
  | 'userinfo'
  | 'port'
  | 'fragment'
  | 'ip_literal'
  | 'host'
  /** A customer-chosen host that is internal, reserved, or known to resolve to a private address. */
  | 'internal_host'
  | 'path'
  | 'query';

export type LarkDomain = 'larksuite' | 'feishu';

export type UrlPolicyResult =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly reason: 'destination_url_rejected'; readonly rule: UrlRejectionRule };

interface HostRule {
  matches(hostname: string): boolean;
  /** Required path prefix, or `undefined` when the provider documents the URL as opaque. */
  readonly pathPrefix?: string;
  /** Optional exact shape of the whole path, checked after the prefix. */
  readonly pathPattern?: RegExp;
  /** When set, the query string must satisfy it; when absent any query is allowed. */
  readonly queryAllowed?: (params: URLSearchParams) => boolean;
  /** A host rule that needs a more specific rejection than `host`. */
  readonly hostRejection?: (hostname: string, options: UrlPolicyOptions) => UrlRejectionRule | undefined;
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// --- Customer-chosen hosts (generic webhook destination, F115) --------------------------
// This is the one destination where the customer picks the host, so an allowlist is not
// possible and the policy is shape-based. It cannot see DNS: Workers `fetch` resolves at the
// edge and we cannot pin the address, so a public name whose record points at a private
// address is NOT stopped here (see `dns-check.ts` and docs/adr/0014).

/** Final labels that name internal or reserved space (RFC 6761, RFC 6762, RFC 8375, common LAN usage). */
const INTERNAL_SUFFIXES: readonly string[] = [
  'localhost',
  'local',
  'localdomain',
  'internal',
  'intranet',
  'private',
  'home',
  'lan',
  'corp',
  'test',
  'example',
  'invalid',
  'onion',
  'arpa',
];

/**
 * Public wildcard-DNS services that exist to resolve `anything.<service>` to an IP address
 * embedded in the name, which turns a hostname into a disguised IP literal. A best-effort,
 * incomplete list: the DNS check at save time is what covers the rest.
 * Also our own domain, so a destination cannot loop back into our own ingress.
 */
const BLOCKED_DOMAINS: readonly string[] = [
  'nip.io',
  'sslip.io',
  'xip.io',
  'localtest.me',
  'lvh.me',
  'vcap.me',
  'lacolhost.com',
  'traefik.me',
  // Our own domain (also derived from APP_ORIGIN at runtime, see `ownHostsOf`).
  'runlumi.app',
  // Cloudflare-hosted infrastructure we or a neighbour run on: a Worker, a Pages site or a
  // tunnel is reachable from a Worker by a route that skips public-internet semantics, and a
  // tenant must not be able to aim a destination at our own deployment.
  'workers.dev',
  'pages.dev',
  'cfargotunnel.com',
];

/** Extra, deployment-specific blocked hosts: today, the host of `APP_ORIGIN`. */
export interface UrlPolicyOptions {
  readonly ownHosts?: readonly string[];
}

/**
 * The hosts a customer webhook must never target, derived from `APP_ORIGIN`: that host and its
 * parent domain (`noti.example.com` blocks `noti.example.com` and `example.com`, with every
 * subdomain of each). Empty when the origin is missing or not a URL.
 */
export function ownHostsOf(appOrigin: string | undefined): readonly string[] {
  if (!appOrigin) return [];
  try {
    const host = new URL(appOrigin).hostname.toLowerCase();
    const labels = host.split('.');
    return labels.length >= 3 ? [host, labels.slice(1).join('.')] : [host];
  } catch {
    return [];
  }
}

const MAX_HOSTNAME_LENGTH = 253;
// A public top-level label: letters only (ICANN TLDs), or punycode for an IDN TLD. A numeric
// last label would make the whole name an IPv4 literal in some notations.
const PUBLIC_TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

function isUnder(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith('.' + domain);
}

function customerHostRejection(
  hostname: string,
  options: UrlPolicyOptions = {},
): UrlRejectionRule | undefined {
  // Every IP notation was already normalised to dotted-quad by the WHATWG parser (decimal,
  // octal, hex, short forms, percent-encoded and fullwidth digits) and caught as `ip_literal`.
  if (hostname.length > MAX_HOSTNAME_LENGTH) return 'host';
  // A trailing dot is a legal FQDN but makes `localhost.` and `x.internal.` evade suffix checks.
  if (hostname.endsWith('.')) return 'host';
  const labels = hostname.split('.');
  // A single label is an intranet name (`metadata`, `intranet`, `db`): public hosts have a TLD.
  if (labels.length < 2) return 'internal_host';
  if (!labels.every((label) => DNS_LABEL.test(label) || /^xn--[a-z0-9-]+$/.test(label))) return 'host';
  const last = labels[labels.length - 1] ?? '';
  if (!PUBLIC_TLD.test(last)) return 'host';
  if (INTERNAL_SUFFIXES.includes(last)) return 'internal_host';
  if (BLOCKED_DOMAINS.some((d) => isUnder(hostname, d))) return 'internal_host';
  if ((options.ownHosts ?? []).some((d) => isUnder(hostname, d))) return 'internal_host';
  return undefined;
}

/**
 * Whether a hostname (for example a CNAME target found while resolving a customer's host)
 * fails the same shape policy as the host itself. A trailing root dot is tolerated here.
 */
export function isBlockedCustomerHostname(hostname: string, options: UrlPolicyOptions = {}): boolean {
  const bare = hostname.toLowerCase().replace(/\.$/, '');
  return IPV4_LITERAL.test(bare) || bare.includes(':') || customerHostRejection(bare, options) !== undefined;
}

/** Discord accepts `thread_id` on Execute Webhook; `wait=true` is ours and added at send time. */
function discordQueryAllowed(params: URLSearchParams): boolean {
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) return false;
  return keys.every(
    (k) =>
      (k === 'thread_id' && /^\d{1,25}$/.test(params.get(k) ?? '')) ||
      (k === 'wait' && params.get(k) === 'true'),
  );
}

const HOST_RULES: { readonly [K in DestinationKind]: HostRule } = {
  // https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks
  // UNVERIFIED: GovSlack hooks live on a `slack-gov.com` host, but the exact hook hostname is
  // not recorded in DESTINATION_API_REFERENCE.md, so GovSlack is rejected until verified.
  // UNVERIFIED: the reference's OAuth `incoming_webhook.url` example omits `/services/`;
  // confirm against a real OAuth install before relying on this prefix for OAuth URLs.
  // `/services/T…/B…/<token>`: workspace id, webhook id, secret — three non-empty segments.
  slack: {
    matches: (h) => isAllowedHost('slack', h),
    pathPrefix: registryEntryFor('slack').pathPrefixes[0],
    pathPattern: /^\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+$/,
  },
  // The Workflows trigger URL is opaque ("The callback URL of the trigger will be displayed
  // to you when you save the flow"), so the rule is host-pattern only (F104). Hosts, prefixes
  // and their citations live in `provider-registry.ts` (F229); this table adds the shape rules.
  // UNVERIFIED: Power Automate may issue trigger URLs on hosts other than
  // `*.logic.azure.com`; the reference records only that pattern. Re-check
  // learn.microsoft.com/connectors/teams before widening it.
  teams: { matches: (h) => isAllowedHost('teams', h) },
  // https://open.larksuite.com/document/client-docs/bot-v3/add-custom-bot
  lark: {
    matches: (h) => isAllowedHost('lark', h),
    pathPrefix: registryEntryFor('lark').pathPrefixes[0],
  },
  // https://discord.com/developers/docs/resources/webhook (DESTINATION_API_REFERENCE.md section 4):
  // `https://discord.com/api/webhooks/{id}/{token}`; the versioned form `/api/v10/webhooks/…` is
  // what the docs show for Execute Webhook, so both are accepted.
  // UNVERIFIED: the legacy `discordapp.com` and the `canary.`/`ptb.` hosts are not recorded in
  // the reference, so they are rejected rather than guessed. The id/token character classes
  // and lengths are not documented either, so they are deliberately loose.
  discord: {
    matches: (h) => isAllowedHost('discord', h),
    pathPrefix: registryEntryFor('discord').pathPrefixes[0],
    pathPattern: /^\/api\/(?:v\d{1,2}\/)?webhooks\/\d{15,25}\/[A-Za-z0-9._-]{1,256}$/,
    queryAllowed: discordQueryAllowed,
  },
  // Any public hostname, at the host-shape level (`customerHostRejection`). The URL is a
  // credential: customers embed secrets in the path or query, so both are free-form.
  generic_webhook: { matches: () => true, hostRejection: customerHostRejection },
};

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;
// `URL` strips leading/trailing C0 controls and spaces and removes tabs/newlines silently;
// rejecting them up front means what we validate is exactly what the customer pasted.
// eslint-disable-next-line no-control-regex
const WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f]/;

function reject(rule: UrlRejectionRule): UrlPolicyResult {
  return { ok: false, reason: 'destination_url_rejected', rule };
}

function parse(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function genericRule(raw: string, url: URL): UrlRejectionRule | undefined {
  if (url.protocol !== 'https:') return 'scheme';
  if (url.username !== '' || url.password !== '') return 'userinfo';
  // The WHATWG parser normalises an explicit `:443` to '' for https.
  if (url.port !== '') return 'port';
  if (url.hash !== '' || raw.includes('#')) return 'fragment';
  if (url.hostname.startsWith('[') || IPV4_LITERAL.test(url.hostname)) return 'ip_literal';
  return undefined;
}

function hostRule(kind: DestinationKind, url: URL, options: UrlPolicyOptions): UrlRejectionRule | undefined {
  const rule = HOST_RULES[kind];
  if (!rule.matches(url.hostname)) return 'host';
  const rejected = rule.hostRejection?.(url.hostname, options);
  if (rejected) return rejected;
  if (rule.queryAllowed && !rule.queryAllowed(url.searchParams)) return 'query';
  if (rule.pathPrefix === undefined) return undefined;
  const path = url.pathname;
  if (!path.startsWith(rule.pathPrefix) || path.length === rule.pathPrefix.length) return 'path';
  return rule.pathPattern && !rule.pathPattern.test(path) ? 'path' : undefined;
}

/** Validate a customer-supplied destination URL against the per-destination allowlist. */
export function checkDestinationUrl(
  kind: DestinationKind,
  raw: string,
  options: UrlPolicyOptions = {},
): UrlPolicyResult {
  if (raw.length > MAX_DESTINATION_URL_LENGTH) return reject('too_long');
  if (WHITESPACE_OR_CONTROL.test(raw)) return reject('whitespace_or_control');
  const url = parse(raw);
  if (!url) return reject('malformed');
  const failed = genericRule(raw, url) ?? hostRule(kind, url, options);
  return failed ? reject(failed) : { ok: true, url };
}

/** Which Lark deployment a validated Lark URL belongs to. The two are not interchangeable. */
export function larkDomainOf(url: URL): LarkDomain | undefined {
  const label = hostLabelOf('lark', url.hostname);
  return label === 'larksuite' || label === 'feishu' ? label : undefined;
}
