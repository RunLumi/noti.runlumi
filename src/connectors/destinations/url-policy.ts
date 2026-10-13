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
  | 'path';

export type LarkDomain = 'larksuite' | 'feishu';

export type UrlPolicyResult =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly reason: 'destination_url_rejected'; readonly rule: UrlRejectionRule };

interface HostRule {
  matches(hostname: string): boolean;
  /** Required path prefix, or `undefined` when the provider documents the URL as opaque. */
  readonly pathPrefix?: string;
}

// A Map, not an object literal: `'constructor' in {}` is true, and `constructor` is a valid
// single-label hostname.
const LARK_HOSTS: ReadonlyMap<string, LarkDomain> = new Map([
  ['open.larksuite.com', 'larksuite'],
  ['open.feishu.cn', 'feishu'],
]);

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isSubdomainOf(hostname: string, suffix: string): boolean {
  if (!hostname.endsWith('.' + suffix)) return false;
  const labels = hostname.slice(0, -(suffix.length + 1)).split('.');
  return labels.every((label) => DNS_LABEL.test(label));
}

const HOST_RULES: { readonly [K in DestinationKind]: HostRule } = {
  // https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks
  // UNVERIFIED: GovSlack hooks live on a `slack-gov.com` host, but the exact hook hostname is
  // not recorded in DESTINATION_API_REFERENCE.md, so GovSlack is rejected until verified.
  // UNVERIFIED: the reference's OAuth `incoming_webhook.url` example omits `/services/`;
  // confirm against a real OAuth install before relying on this prefix for OAuth URLs.
  slack: { matches: (h) => h === 'hooks.slack.com', pathPrefix: '/services/' },
  // The Workflows trigger URL is opaque ("The callback URL of the trigger will be displayed
  // to you when you save the flow"), so the rule is host-pattern only (F104).
  // UNVERIFIED: Power Automate may issue trigger URLs on hosts other than
  // `*.logic.azure.com`; the reference records only that pattern. Re-check
  // learn.microsoft.com/connectors/teams before widening it.
  teams: { matches: (h) => isSubdomainOf(h, 'logic.azure.com') },
  // https://open.larksuite.com/document/client-docs/bot-v3/add-custom-bot
  lark: { matches: (h) => LARK_HOSTS.has(h), pathPrefix: '/open-apis/bot/v2/hook/' },
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

function hostRule(kind: DestinationKind, url: URL): UrlRejectionRule | undefined {
  const rule = HOST_RULES[kind];
  if (!rule.matches(url.hostname)) return 'host';
  if (rule.pathPrefix === undefined) return undefined;
  const path = url.pathname;
  return path.startsWith(rule.pathPrefix) && path.length > rule.pathPrefix.length ? undefined : 'path';
}

/** Validate a customer-supplied destination URL against the per-destination allowlist. */
export function checkDestinationUrl(kind: DestinationKind, raw: string): UrlPolicyResult {
  if (raw.length > MAX_DESTINATION_URL_LENGTH) return reject('too_long');
  if (WHITESPACE_OR_CONTROL.test(raw)) return reject('whitespace_or_control');
  const url = parse(raw);
  if (!url) return reject('malformed');
  const failed = genericRule(raw, url) ?? hostRule(kind, url);
  return failed ? reject(failed) : { ok: true, url };
}

/** Which Lark deployment a validated Lark URL belongs to. The two are not interchangeable. */
export function larkDomainOf(url: URL): LarkDomain | undefined {
  return LARK_HOSTS.get(url.hostname);
}
