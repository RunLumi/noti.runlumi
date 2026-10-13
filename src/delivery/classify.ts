/**
 * Adapter classification → delivery taxonomy (docs/specs/12-delivery-reliability.md F179,
 * F178; docs/adr/0006-destination-adapter-contract.md).
 *
 * There is ONE classification layer: the destination adapters (`connectors/destinations`)
 * read provider responses and produce a `ClassifiedResponse` (outcome + reason). This module
 * only translates that into slice 4's vocabulary — an F13 `ErrorCode` for the retry policy
 * and ledger, and a minted diagnostic for `last_error`. It never inspects a provider body
 * for meaning, with one narrow exception (`isUnconfirmedReply`, below).
 *
 * `diagnostic` is a code we mint (`provider_http_503`, `provider_lark_19021`). It is the only
 * provider-derived text that reaches `last_error`; bodies and URLs never do (F12).
 */
import type {
  ClassifiedResponse,
  DeliveryReason,
  DestinationKind,
  ProviderResponse,
} from '../connectors/destinations';
import { isRetryable, type ErrorCode } from '../platform/errors';
import type { AttemptOutcome } from './retry';

/** The result of one attempt: the outcome for the retry policy plus a minted diagnostic. */
export interface AttemptResult {
  readonly outcome: AttemptOutcome;
  readonly diagnostic: string | null;
  /** No mapping matched; the caller raises the F13 metric. */
  readonly unmapped: boolean;
}

export const DELIVERED: AttemptResult = { outcome: { kind: 'delivered' }, diagnostic: null, unmapped: false };

export function failed(
  code: ErrorCode,
  diagnostic: string,
  retryAfterSeconds: number | null = null,
): AttemptResult {
  return { outcome: { kind: 'failed', code, retryAfterSeconds }, diagnostic, unmapped: false };
}

/**
 * Every adapter failure reason onto exactly one F13 code. The retryability the adapter
 * asserted (`outcome`) must agree with the code's own (`isRetryable`); a test enforces it
 * for every reason, so the two layers cannot drift apart.
 */
export const REASON_CODES: Readonly<Record<Exclude<DeliveryReason, 'ok'>, ErrorCode>> = {
  destination_rate_limited: 'destination_rate_limited',
  destination_unavailable: 'destination_unavailable',
  destination_timeout: 'destination_timeout',
  network_error: 'destination_unavailable',
  destination_revoked: 'destination_revoked',
  // A webhook that redirects is misconfigured or moved; following it would bypass the allowlist.
  destination_redirected: 'destination_url_rejected',
  destination_unauthorized: 'destination_unauthorized',
  // Tenant/channel policy (IP allowlist, keyword check, posting restrictions): the customer
  // must change the destination's settings, which is the `destination_unauthorized` fix.
  destination_policy_blocked: 'destination_unauthorized',
  // Lark DLP rejected the content: nothing about a retry changes the text.
  content_policy_blocked: 'render_failed',
  signature_rejected: 'destination_credentials_invalid',
  payload_rejected: 'render_failed',
  payload_too_large: 'payload_too_large',
  destination_url_rejected: 'destination_url_rejected',
  unmapped_response: 'internal_error',
  internal_error: 'internal_error',
};

export interface ResponseContext {
  readonly kind: DestinationKind;
  /** HTTP status of the provider response, or `null` when the request never completed. */
  readonly status: number | null;
}

function diagnosticFor(c: ClassifiedResponse, ctx: ResponseContext): string {
  // `providerCode` comes only from the adapters' own known-code tables, never from free text.
  if (c.providerCode !== undefined) return `provider_${ctx.kind}_${c.providerCode}`;
  if (ctx.status !== null && c.reason === 'destination_redirected') return `provider_redirect_${ctx.status}`;
  if (ctx.status !== null && ctx.status >= 300) return `provider_http_${ctx.status}`;
  if (c.reason === 'destination_timeout') return 'provider_timeout';
  // Our own URL policy refused the request before any network I/O.
  if (c.reason === 'destination_url_rejected') return 'destination_not_allowed';
  // Platform error messages can echo the URL, so none of it is kept.
  return 'transient_error';
}

/**
 * A 2xx the adapter could not interpret (Slack: body is not `ok`; Lark: no numeric `code`).
 * The provider took the request, so retrying risks a duplicate message: it is recorded as
 * `accepted` (delivery unconfirmed, F100) and flagged, never retried. A Lark body that does
 * carry an unknown numeric `code` is a rejection we merely cannot name, and stays retryable.
 */
export function isUnconfirmedReply(
  kind: DestinationKind,
  res: Pick<ProviderResponse, 'status' | 'bodyText'>,
  c: ClassifiedResponse,
): boolean {
  if (res.status < 200 || res.status > 299) return false;
  if (c.outcome !== 'retryable' || c.unmapped !== true) return false;
  if (kind !== 'lark') return true;
  try {
    const body: unknown = JSON.parse(res.bodyText);
    if (typeof body !== 'object' || body === null) return true;
    const { code, StatusCode } = body as { code?: unknown; StatusCode?: unknown };
    return typeof code !== 'number' && typeof StatusCode !== 'number';
  } catch {
    return true;
  }
}

/** Translate an adapter classification. `res` is `null` when the request threw. */
export function attemptFromClassification(
  c: ClassifiedResponse,
  kind: DestinationKind,
  res: Pick<ProviderResponse, 'status' | 'bodyText'> | null,
): AttemptResult {
  const unmapped = c.unmapped === true;
  if (c.outcome === 'delivered') return DELIVERED;
  if (c.outcome === 'accepted') return { outcome: { kind: 'accepted' }, diagnostic: null, unmapped };
  if (res && isUnconfirmedReply(kind, res, c)) {
    return { outcome: { kind: 'accepted' }, diagnostic: 'provider_reply_unreadable', unmapped: true };
  }
  const code = REASON_CODES[c.reason === 'ok' ? 'internal_error' : c.reason];
  // Defence in depth: a permanent verdict never becomes a retry, nor the reverse.
  const safeCode: ErrorCode =
    c.outcome === 'permanent' && isRetryable(code)
      ? 'config_invalid'
      : c.outcome === 'retryable' && !isRetryable(code)
        ? 'internal_error'
        : code;
  const retryAfterSeconds = c.retryAfterMs === undefined ? null : Math.ceil(c.retryAfterMs / 1000);
  return {
    outcome: { kind: 'failed', code: safeCode, retryAfterSeconds },
    diagnostic: diagnosticFor(c, { kind, status: res?.status ?? null }),
    unmapped,
  };
}
