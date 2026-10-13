import { classifyHttpStatus, permanent, retryable } from '../classify';
import type { ClassifiedResponse, ProviderResponse } from '../types';

/**
 * Responses from a customer's own endpoint (spec 09 F117). The endpoint is the surface we
 * know least about, so the mapping is explicit and total:
 *
 * | response            | outcome                                             |
 * | 200-299             | delivered (202 is `accepted`: the endpoint queued it) |
 * | 3xx                 | permanent: redirects are never followed             |
 * | 400, 422            | permanent `payload_rejected`                        |
 * | 401, 403            | permanent `destination_unauthorized`                |
 * | 404, 410            | permanent `destination_revoked`                     |
 * | 405, 501            | permanent `destination_revoked` (wrong method)      |
 * | 413                 | permanent `payload_too_large`                       |
 * | other 4xx           | permanent `payload_rejected`, flagged `unmapped`    |
 * | 408, 425            | retryable                                           |
 * | 429                 | retryable, `Retry-After` honoured                   |
 * | 5xx                 | retryable, `Retry-After` honoured                   |
 * | anything else       | retryable and flagged `unmapped` (bounded retries)  |
 *
 * The retry class comes from the STATUS CODE alone. Nothing the customer can configure
 * turns a failure status into success, so a misconfigured endpoint cannot become a silent
 * black hole (there is deliberately no "expected status" setting yet). The response body is
 * attacker-controlled and is never read: not for meaning, not for a message shown to the user.
 *
 * Because we cannot see past the endpoint, a 2xx is only evidence that it answered.
 */
export function classifyGenericWebhookResponse(res: ProviderResponse, now: number): ClassifiedResponse {
  const { status } = res;
  if (status === 202) return { outcome: 'accepted', reason: 'ok' };
  if (status >= 200 && status <= 299) return { outcome: 'delivered', reason: 'ok' };
  if (status === 405 || status === 501) return permanent('destination_revoked', 'method_not_allowed');
  if (status === 425) return retryable('destination_unavailable');
  if (status >= 400 && status <= 499) {
    const known = classifyHttpStatus(res, now);
    // A 4xx the generic mapping does not know (409, 415, 418, ...): retrying cannot fix it.
    return known.unmapped ? { outcome: 'permanent', reason: 'payload_rejected', unmapped: true } : known;
  }
  return classifyHttpStatus(res, now);
}
