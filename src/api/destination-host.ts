import { checkResolvedHost, type DnsFetcher } from '../connectors/destinations/dns-check';
import { checkDestinationUrl, type UrlPolicyOptions } from '../connectors/destinations/url-policy';
import type { DestinationKind } from '../pipeline/allowlist';
import type { FieldError } from './integration-input';

/**
 * Save-time DNS verification for the one destination whose host the customer chooses (spec 09
 * F115). Every other destination is pinned to documented provider hosts by `url-policy.ts`
 * and needs no lookup. A refusal names the rule, never the host or the addresses.
 *
 * This narrows the SSRF surface; it does not close it (a record can change after the check).
 * `docs/adr/0014-extended-destinations.md` states the residual risk.
 */
const MESSAGES = {
  blocked_address:
    'This hostname resolves to a private or reserved address, which Noti never sends to. Use a public endpoint.',
  unresolvable: 'This hostname does not resolve. Check the address and that its DNS record exists.',
  lookup_failed: 'We could not verify this hostname right now. Try again in a minute.',
} as const;

export async function hostVerificationError(
  destination: DestinationKind,
  webhookUrl: string,
  urlPolicy?: UrlPolicyOptions,
  fetcher?: DnsFetcher,
): Promise<FieldError | null> {
  if (destination !== 'generic_webhook') return null;
  // The shape policy again (own hosts may have changed since the row was written).
  if (!checkDestinationUrl('generic_webhook', webhookUrl, urlPolicy).ok)
    return { field: 'webhookUrl', message: MESSAGES.blocked_address };
  const result = await checkResolvedHost(new URL(webhookUrl).hostname, fetcher, urlPolicy);
  return result.ok ? null : { field: 'webhookUrl', message: MESSAGES[result.reason] };
}
