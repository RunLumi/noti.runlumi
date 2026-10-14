import type { DestinationKind } from './types';

/**
 * F229: the one reviewable list of hosts a destination may be sent to. Adding a host is a
 * normal PR with a citation; removing one is a breaking change (existing destinations start
 * failing `destination_url_rejected`); a host is never widened silently when a provider moves.
 *
 * Each entry carries the provider documentation that justifies it and a `verifiedOn` date.
 * Staleness is reported (not enforced in the pull-request check) once `verifiedOn` is older than
 * {@link REGISTRY_MAX_AGE_DAYS}: see `npm run check:stale` and the scheduled workflow
 * `.github/workflows/registry-staleness.yml`. The fix is to re-read the page and correct the
 * entry, then bump the date; never to bump the date alone.
 *
 * ATTESTATION: `verifiedOn` is NOT a record that anyone re-read `docsUrl`. For every entry today
 * it is the research date of `docs/DESTINATION_API_REFERENCE.md` (2026-10-13), which cites those
 * pages; the pages themselves were not re-read when this registry was written. A person who
 * re-reads a page and updates the date is making the attestation, and should say so in the PR.
 * Anything that reference marks UNVERIFIED is repeated in `caveat`.
 *
 * The generic webhook destination has no entry on purpose: the customer chooses the host, so
 * it is governed by a shape policy (`url-policy.ts`) rather than a list.
 */

export interface WildcardSubdomain {
  /** Registrable suffix; every well-formed subdomain of it is accepted. No `*`. */
  readonly suffix: string;
  /** Why an exact host list is not possible. Required: a wildcard without a reason is a bug. */
  readonly reason: string;
}

export interface AllowedDestination {
  readonly kind: Exclude<DestinationKind, 'generic_webhook'>;
  /** Exact, lowercase hostnames. Matching is exact string equality. */
  readonly hosts: readonly string[];
  /** Optional short label per host (Lark: the regional deployment). Keys must be in `hosts`. */
  readonly hostLabels?: Readonly<Record<string, string>>;
  /** Required path prefixes (each starts and ends with `/`); empty only with `opaquePathReason`. */
  readonly pathPrefixes: readonly string[];
  readonly opaquePathReason?: string;
  /** The provider's own documentation for the host and path shape. */
  readonly docsUrl: string;
  /** ISO date (UTC) a human read `docsUrl`. */
  readonly verifiedOn: string;
  readonly wildcardSubdomains?: readonly WildcardSubdomain[];
  /** What the reference could not confirm. Informational; absent when nothing is open. */
  readonly caveat?: string;
}

export const REGISTRY_MAX_AGE_DAYS = 180;

export const ALLOWED_DESTINATIONS: readonly AllowedDestination[] = [
  {
    kind: 'slack',
    hosts: ['hooks.slack.com'],
    pathPrefixes: ['/services/'],
    docsUrl: 'https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks',
    verifiedOn: '2026-10-13',
    caveat:
      'GovSlack hooks use a slack-gov.com host that the reference does not record, so they are rejected until verified. The OAuth incoming_webhook.url example in the reference omits /services/.',
  },
  {
    kind: 'teams',
    hosts: [],
    pathPrefixes: [],
    opaquePathReason:
      'Microsoft documents the Workflows trigger URL as opaque: it is shown to the user when the flow is saved, so only the host pattern can be checked (AR-15).',
    wildcardSubdomains: [
      {
        suffix: 'logic.azure.com',
        reason:
          'Workflows trigger URLs live on regional, tenant-created hosts such as prod-12.westus.logic.azure.com; no fixed host list exists and tenants can create new ones (AR-15, ADR 0006).',
      },
    ],
    docsUrl: 'https://learn.microsoft.com/en-us/connectors/teams/',
    verifiedOn: '2026-10-13',
    caveat:
      'The reference could not confirm that Power Automate never issues trigger URLs on another host; widening needs the documentation first.',
  },
  {
    kind: 'lark',
    hosts: ['open.larksuite.com', 'open.feishu.cn'],
    hostLabels: { 'open.larksuite.com': 'larksuite', 'open.feishu.cn': 'feishu' },
    pathPrefixes: ['/open-apis/bot/v2/hook/'],
    docsUrl: 'https://open.larksuite.com/document/client-docs/bot-v3/add-custom-bot',
    verifiedOn: '2026-10-13',
  },
  {
    kind: 'discord',
    hosts: ['discord.com'],
    pathPrefixes: ['/api/'],
    docsUrl: 'https://discord.com/developers/docs/resources/webhook',
    verifiedOn: '2026-10-13',
    caveat:
      'The legacy discordapp.com host and the canary and ptb hosts are not recorded in the reference, so they are rejected.',
  },
];

const BY_KIND: ReadonlyMap<DestinationKind, AllowedDestination> = new Map(
  ALLOWED_DESTINATIONS.map((e) => [e.kind, e]),
);

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A well-formed subdomain of a declared wildcard suffix: the part before `.suffix` must be one
 * or more valid DNS labels. The suffix is compared with a dot boundary (`'.' + suffix`), so
 * `evillogic.azure.com` and `logic.azure.com` itself do not match; a bare `endsWith(suffix)`
 * would accept the first.
 */
function isSubdomainOf(hostname: string, suffix: string): boolean {
  if (!hostname.endsWith('.' + suffix)) return false;
  const labels = hostname.slice(0, -(suffix.length + 1)).split('.');
  return labels.every((label) => DNS_LABEL.test(label));
}

/** The registry entry for a kind that has one. Throws for `generic_webhook`. */
export function registryEntryFor(kind: Exclude<DestinationKind, 'generic_webhook'>): AllowedDestination {
  const entry = BY_KIND.get(kind);
  if (!entry) throw new Error(`no provider registry entry for ${kind}`);
  return entry;
}

/**
 * Whether `hostname` (already lowercased and punycoded by the WHATWG parser) is registered for
 * `kind`. Exact match, or a well-formed subdomain of a declared wildcard suffix. A trailing dot
 * is NOT tolerated: it is rejected, which is stricter than the spec asks and cannot widen.
 */
export function isAllowedHost(kind: DestinationKind, hostname: string): boolean {
  const entry = BY_KIND.get(kind);
  if (!entry || hostname === '') return false;
  if (entry.hosts.includes(hostname)) return true;
  return (entry.wildcardSubdomains ?? []).some((w) => isSubdomainOf(hostname, w.suffix));
}

/** The label registered for a host (for example the Lark deployment), if any. */
export function hostLabelOf(
  kind: Exclude<DestinationKind, 'generic_webhook'>,
  hostname: string,
): string | undefined {
  const labels = registryEntryFor(kind).hostLabels;
  return labels && Object.prototype.hasOwnProperty.call(labels, hostname) ? labels[hostname] : undefined;
}

/** Whole days from `verifiedOn` (UTC midnight) to `now`. Negative when the date is in the future. */
export function daysSinceVerified(entry: AllowedDestination, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(entry.verifiedOn)) / 86_400_000);
}
