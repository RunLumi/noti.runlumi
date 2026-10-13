import { checkResolvedHost, type DnsFetcher } from '../connectors/destinations/dns-check';
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
  fetcher?: DnsFetcher,
): Promise<FieldError | null> {
  if (destination !== 'generic_webhook') return null;
  const result = await checkResolvedHost(new URL(webhookUrl).hostname, fetcher);
  return result.ok ? null : { field: 'webhookUrl', message: MESSAGES[result.reason] };
}
