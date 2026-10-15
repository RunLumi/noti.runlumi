import { asRecord } from '../../../lib/json';
import { classifyHttpStatus, permanent, retryable, unmapped } from '../classify';
import { parseRetryAfter } from '../retry-after';
import type { ClassifiedResponse, DeliveryReason, ProviderResponse } from '../types';

/**
 * Slack Web API (`chat.postMessage` and friends) error mapping (ADR 0041, F179).
 *
 * The Web API signals most failures as HTTP 200 with `{"ok": false, "error": "<token>"}`, so the
 * token, not the status, carries the meaning. HTTP 429 and 5xx keep their generic handling and
 * `Retry-After`. Only the tokens below are mapped. They are the ones recorded in
 * `docs/DESTINATION_API_REFERENCE.md` section 1.3 (taken from the Slack reference on 2026-10-13;
 * that session could not be re-checked on 2026-10-15, see ADR 0041). Any other token is
 * retryable and flagged `unmapped`, never guessed as permanent.
 *
 * Not mapped, on purpose: `msg_too_long` (not in that reference; its length error is
 * `msg_blocks_too_long`), and `message_limit_exceeded` (a workspace plan limit the reference does
 * not classify). Both fall through to the unmapped path.
 *
 * Not wired yet: the adapter sends incoming-webhook requests only. This classifier has no caller
 * in the delivery path until a Web API send mode exists (ADR 0041, "Not done").
 */

type SlackRetryable = Extract<
  DeliveryReason,
  'destination_rate_limited' | 'destination_unavailable' | 'destination_timeout'
>;
type SlackPermanent = Extract<
  DeliveryReason,
  | 'destination_revoked'
  | 'destination_unauthorized'
  | 'destination_policy_blocked'
  | 'payload_rejected'
  | 'payload_too_large'
>;

/** Transient tokens: the same request may succeed later. */
const RETRYABLE_TOKENS: ReadonlyMap<string, SlackRetryable> = new Map([
  ['ratelimited', 'destination_rate_limited'],
  ['rate_limited', 'destination_rate_limited'],
  ['internal_error', 'destination_unavailable'],
  ['fatal_error', 'destination_unavailable'],
  ['service_unavailable', 'destination_unavailable'],
  ['request_timeout', 'destination_timeout'],
]);

/** Permanent tokens: repeating the request cannot succeed until a person changes something. */
const PERMANENT_TOKENS: ReadonlyMap<string, SlackPermanent> = new Map([
  // The credential, or the bot's access to the workspace or channel, is wrong or gone.
  ['invalid_auth', 'destination_unauthorized'],
  ['token_revoked', 'destination_unauthorized'],
  ['token_expired', 'destination_unauthorized'],
  ['account_inactive', 'destination_unauthorized'],
  ['team_not_found', 'destination_unauthorized'],
  ['ekm_access_denied', 'destination_unauthorized'],
  ['missing_scope', 'destination_unauthorized'],
  ['no_permission', 'destination_unauthorized'],
  ['not_in_channel', 'destination_unauthorized'],
  // The target itself is gone or disabled.
  ['channel_not_found', 'destination_revoked'],
  ['is_archived', 'destination_revoked'],
  ['team_disabled', 'destination_revoked'],
  // Workspace policy forbids the post.
  ['posting_to_general_channel_denied', 'destination_policy_blocked'],
  // Our payload is wrong or too large. Retrying the same bytes is pointless.
  ['invalid_blocks', 'payload_rejected'],
  ['invalid_blocks_format', 'payload_rejected'],
  ['no_text', 'payload_rejected'],
  ['msg_blocks_too_long', 'payload_too_large'],
]);

/** The reference lists `restricted_action*` as one family; a prefix match is the honest form. */
const RESTRICTED_PREFIX = 'restricted_action';

function permanentFor(token: string): SlackPermanent | undefined {
  if (token.startsWith(RESTRICTED_PREFIX)) return 'destination_policy_blocked';
  return PERMANENT_TOKENS.get(token);
}

export function classifySlackWebApiResponse(res: ProviderResponse, now: number): ClassifiedResponse {
  // Transport-level throttling and outages carry their own meaning regardless of body.
  if (res.status !== 200) return classifyHttpStatus(res, now);

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.bodyText);
  } catch {
    return unmapped(res.status);
  }
  const body = asRecord(parsed);
  if (!body) return unmapped(res.status);
  if (body.ok === true) return { outcome: 'delivered', reason: 'ok' };
  if (body.ok !== false || typeof body.error !== 'string') return unmapped(res.status);

  // `providerCode` is only ever a token from the tables above, never the raw body (ADR 0006).
  const token = body.error;
  const transient = RETRYABLE_TOKENS.get(token);
  if (transient) {
    const retryAfterMs =
      transient === 'destination_rate_limited'
        ? parseRetryAfter(res.headers.get('retry-after'), now)
        : undefined;
    return retryable(transient, { providerCode: knownToken(token), retryAfterMs });
  }
  const fixed = permanentFor(token);
  if (fixed) return permanent(fixed, knownToken(token));
  return unmapped(res.status);
}

/** Echo a token only when it is one we map; an unknown token is never stored or logged. */
function knownToken(token: string): string | undefined {
  return RETRYABLE_TOKENS.has(token) || PERMANENT_TOKENS.has(token) || token.startsWith(RESTRICTED_PREFIX)
    ? token
    : undefined;
}
