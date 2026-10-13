import { checkDestinationUrl } from '../connectors/destinations/url-policy';

export type DestinationKind = 'lark' | 'slack';

/**
 * Outbound SSRF guard, applied at write time (D9) and again before every send. A thin
 * adapter over the single destination URL policy (`connectors/destinations/url-policy.ts`,
 * ADR 0006) so there is exactly one allowlist: https only, documented hosts and path shapes,
 * no userinfo, port, fragment or IP literal. Sends never follow a redirect.
 */
export function destinationAllowed(url: URL, destination: DestinationKind): boolean {
  return checkDestinationUrl(destination, url.toString()).ok;
}
