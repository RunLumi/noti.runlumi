import { CANONICAL_LIMITS } from './canonical';
import { hasUnsafeText } from './text';

/**
 * The canonical `id` for a provider id. The provider's own id is kept verbatim when it is a bounded,
 * printable string (it is what a person sees in the provider's delivery log). Anything else (longer
 * than the bound, or holding unsafe text) is replaced by `sha256:<hex>` of the original, which is
 * still deterministic and still one id per provider id. The event is never refused for its id: a
 * refusal would be a 4xx the provider counts as a failure, for something that is our bound.
 */
export async function boundedEventId(providerId: string): Promise<string> {
  if (providerId.length > 0 && providerId.length <= CANONICAL_LIMITS.id && !hasUnsafeText(providerId))
    return providerId;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(providerId)));
  return `sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
