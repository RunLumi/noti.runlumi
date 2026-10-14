import { parseRetryAfter } from './retry-after';
import type { ClassifiedResponse, DeliveryReason, ProviderResponse } from './types';

/**
 * Shared pieces of response classification. Each adapter maps its documented provider codes
 * first and falls back to `classifyHttpStatus` for everything else.
 */

type FailureReason = Exclude<DeliveryReason, 'ok'>;

export function permanent(reason: FailureReason, providerCode?: string): ClassifiedResponse {
  return providerCode === undefined
    ? { outcome: 'permanent', reason }
    : { outcome: 'permanent', reason, providerCode };
}

export function retryable(
  reason: FailureReason,
  extra: { readonly retryAfterMs?: number | undefined; readonly providerCode?: string | undefined } = {},
): ClassifiedResponse {
  return {
    outcome: 'retryable',
    reason,
    ...(extra.retryAfterMs === undefined ? {} : { retryAfterMs: extra.retryAfterMs }),
    ...(extra.providerCode === undefined ? {} : { providerCode: extra.providerCode }),
  };
}

/**
 * F13: an unmapped response is `destination_unavailable` when 5xx and a retryable
 * `unmapped_response` otherwise, and is flagged so the caller raises a metric. Bounded
 * retries cap the cost of guessing wrong.
 */
export function unmapped(status: number): ClassifiedResponse {
  const reason: FailureReason = status >= 500 ? 'destination_unavailable' : 'unmapped_response';
  return { outcome: 'retryable', reason, unmapped: true };
}

function retryAfter(res: ProviderResponse, now: number): number | undefined {
  return parseRetryAfter(res.headers.get('retry-after'), now);
}

/** Generic HTTP-status mapping for responses no provider-specific rule matched. */
export function classifyHttpStatus(res: ProviderResponse, now: number): ClassifiedResponse {
  const { status } = res;
  // `send.ts` uses `redirect: 'manual'`, so a redirect arrives here as 3xx (or as 0, the
  // opaque-redirect status). A webhook endpoint that redirects is misconfigured or moved;
  // following it would bypass the allowlist and retrying will not fix it.
  if (status === 0 || (status >= 300 && status <= 399)) return permanent('destination_redirected');
  if (status === 429) return retryable('destination_rate_limited', { retryAfterMs: retryAfter(res, now) });
  if (status === 413) return permanent('payload_too_large');
  if (status === 401 || status === 403) return permanent('destination_unauthorized');
  if (status === 404 || status === 410) return permanent('destination_revoked');
  if (status === 400 || status === 422) return permanent('payload_rejected');
  if (status === 408) return retryable('destination_timeout');
  if (status >= 500 && status <= 599) {
    return retryable('destination_unavailable', { retryAfterMs: retryAfter(res, now) });
  }
  return unmapped(status);
}

/**
 * Classify an exception thrown by `fetch` (or by our own timeout). Redirects never reach this
 * path because `send.ts` uses `redirect: 'manual'` and classifies the 3xx response itself.
 */
export function classifyTransportError(e: unknown): ClassifiedResponse {
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    return retryable('destination_timeout');
  }
  if (e instanceof TypeError) return retryable('network_error');
  return retryable('internal_error');
}

/** A short lowercase token such as Slack's `invalid_payload`, or `undefined`. */
export function shortToken(bodyText: string): string | undefined {
  const token = bodyText.trim();
  return /^[a-z][a-z0-9_]{0,63}$/.test(token) ? token : undefined;
}
