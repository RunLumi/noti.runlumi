import { classifyHttpStatus, retryable } from '../classify';
import { MAX_RETRY_AFTER_MS, parseRetryAfter } from '../retry-after';
import type { ClassifiedResponse, ProviderResponse } from '../types';

/**
 * Discord Execute Webhook responses (docs/DESTINATION_API_REFERENCE.md section 4, spec 09
 * F107/F108). Every request is sent with `wait=true`, so success is `200` with the created
 * message; `204` is what `wait=false` returns and proves nothing, so it is `accepted`.
 *
 * Failure rules that differ from the generic mapping, all from Discord's own words:
 *  - `404`: "you should not attempt to use it again - repeated attempts to do so will result
 *    in a temporary restriction". Permanent with zero retries (the generic mapping already
 *    does this; it is asserted by a test because it is the most consequential row here).
 *  - `401`/`403`/`429` count toward a shared invalid-request budget, so `401`/`403` are
 *    permanent on the first occurrence and `429` is never retried before `retry_after`.
 *  - Rate limits are read from the response, never hard-coded: the `429` body's
 *    `retry_after` (seconds, a float) first, then `Retry-After`.
 *
 * A malformed body on a `200` is still `delivered`: Discord has already posted the message,
 * so retrying would duplicate it. (Spec 09 F107 says `destination_unavailable` here; that
 * would retry a message that exists. The message id is not persisted yet, so the body is not
 * needed for anything.)
 *
 * UNVERIFIED: the numeric per-route limit of Execute Webhook (reference section 8, item 9).
 * UNVERIFIED: the exact body of a 400 for an over-limit embed; every 400 is `payload_rejected`.
 */

function retryAfterFromBody(bodyText: string): { ms?: number; global: boolean } {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed !== 'object' || parsed === null) return { global: false };
    const { retry_after: seconds, global } = parsed as { retry_after?: unknown; global?: unknown };
    const ms =
      typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
        ? Math.min(Math.ceil(seconds * 1000), MAX_RETRY_AFTER_MS)
        : undefined;
    return { ...(ms === undefined ? {} : { ms }), global: global === true };
  } catch {
    return { global: false };
  }
}

export function classifyDiscordResponse(res: ProviderResponse, now: number): ClassifiedResponse {
  if (res.status === 200) return { outcome: 'delivered', reason: 'ok' };
  // 204 is `wait=false` behaviour; any other 2xx is unexpected. Neither is a confirmation,
  // and the message may exist, so neither is retried.
  if (res.status >= 200 && res.status <= 299) return { outcome: 'accepted', reason: 'ok' };
  if (res.status === 429) {
    const body = retryAfterFromBody(res.bodyText);
    const retryAfterMs = body.ms ?? parseRetryAfter(res.headers.get('retry-after'), now);
    return retryable('destination_rate_limited', {
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(body.global ? { providerCode: 'global' } : {}),
    });
  }
  return classifyHttpStatus(res, now);
}
