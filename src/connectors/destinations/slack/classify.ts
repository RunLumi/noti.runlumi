import { classifyHttpStatus, permanent, shortToken, unmapped } from '../classify';
import type { ClassifiedResponse, DeliveryReason, ProviderResponse } from '../types';

/**
 * Slack incoming-webhook responses. Success is HTTP 200 with the literal text body `ok`
 * (not JSON). Errors are plain-text tokens, documented at
 * https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks and
 * https://docs.slack.dev/changelog/2016-05-17-changes-to-errors-for-incoming-webhooks
 */

type SlackPermanentReason = Extract<
  DeliveryReason,
  'payload_rejected' | 'destination_revoked' | 'destination_policy_blocked'
>;

const KNOWN_ERRORS: ReadonlyMap<string, SlackPermanentReason> = new Map([
  ['invalid_payload', 'payload_rejected'],
  ['no_text', 'payload_rejected'],
  ['too_many_attachments', 'payload_rejected'],
  ['action_prohibited', 'destination_policy_blocked'],
  ['posting_to_general_channel_denied', 'destination_policy_blocked'],
  ['no_service', 'destination_revoked'],
  ['no_service_id', 'destination_revoked'],
  ['no_active_hooks', 'destination_revoked'],
  ['channel_is_archived', 'destination_revoked'],
  ['channel_not_found', 'destination_revoked'],
  ['user_not_found', 'destination_revoked'],
  ['team_disabled', 'destination_revoked'],
]);

export function classifySlackResponse(res: ProviderResponse, now: number): ClassifiedResponse {
  const token = shortToken(res.bodyText);
  if (res.status === 200) {
    return token === 'ok' ? { outcome: 'delivered', reason: 'ok' } : unmapped(res.status);
  }
  // 429 and 5xx carry transient meaning regardless of body; honour `Retry-After`.
  if (res.status === 429 || res.status >= 500) return classifyHttpStatus(res, now);
  const known = token === undefined ? undefined : KNOWN_ERRORS.get(token);
  if (known && token) return permanent(known, token);
  return classifyHttpStatus(res, now);
}
