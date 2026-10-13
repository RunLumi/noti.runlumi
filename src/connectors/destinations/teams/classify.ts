import { classifyHttpStatus } from '../classify';
import type { ClassifiedResponse, ProviderResponse } from '../types';

/**
 * Teams Workflows trigger responses. The trigger answers HTTP 202 Accepted with no
 * meaningful body, and the flow can still fail after that (e.g. a flow turned off, or an
 * orphaned flow whose owner left). A 2xx is therefore only ever `accepted`, never
 * `delivered` (F99/F100). The body is never inspected.
 *
 * UNVERIFIED: the status codes a Logic Apps trigger returns for a deleted/disabled flow and
 * for an authentication mismatch are not documented in DESTINATION_API_REFERENCE.md; the
 * generic HTTP mapping applies (404 → revoked, 401/403 → unauthorized). Confirm in a tenant.
 */
export function classifyTeamsResponse(res: ProviderResponse, now: number): ClassifiedResponse {
  if (res.status >= 200 && res.status <= 299) return { outcome: 'accepted', reason: 'ok' };
  return classifyHttpStatus(res, now);
}
