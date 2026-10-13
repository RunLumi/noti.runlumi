/**
 * Closed error taxonomy — docs/specs/01-platform-runtime.md F13.
 *
 * Every failure in the system is classified onto exactly one of these codes. Free-text
 * provider errors are never a primary classification; they may only be stored as a
 * redacted diagnostic (F12) next to the code. Retry decisions are made from the code,
 * never from `status >= 500` alone.
 */

/** Bump when a code is added, removed or reclassified, so stored rows can be migrated. */
export const TAXONOMY_VERSION = 1;

export const ERROR_CODES = [
  'signature_invalid',
  // Amendment to F13 from docs/specs/03-secrets-and-crypto.md: "stale" and "forged" are
  // different facts with different customer fixes, so they are not overloaded.
  'timestamp_out_of_tolerance',
  'replay_detected',
  'unauthorized_tenant',
  'destination_url_rejected',
  'destination_credentials_invalid',
  'destination_revoked',
  'destination_unauthorized',
  'destination_rate_limited',
  'destination_unavailable',
  'destination_timeout',
  'payload_too_large',
  'render_failed',
  'config_invalid',
  'internal_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type ErrorClass = 'retryable' | 'permanent';

export interface ErrorCodeSpec {
  /** F13: whether a delivery that failed with this code may be attempted again. */
  readonly retryable: boolean;
  /** F13: whether the customer can do something about it (reconnect, edit settings…). */
  readonly userActionable: boolean;
  /** Status used when this code is the outcome of one of our own API requests. */
  readonly httpStatus: number;
  /**
   * Message id in the localisable catalogue (F220/F224). `null` means the code never
   * surfaces to a user: verification-boundary codes teach an attacker about the boundary.
   * Copy is looked up by id; provider text is never shown.
   */
  readonly messageKey: string | null;
}

/** The default classification for anything unexpected (F13). */
export const DEFAULT_ERROR_CODE: ErrorCode = 'internal_error';

/**
 * HTTP status rationale for our own API responses:
 * - 401/403 for the verification boundary, with no body detail (no oracle).
 * - 200 for `replay_detected`: a duplicate is suppressed and counted, not an error, and a
 *   2xx stops the provider from retrying (docs/specs/03-secrets-and-crypto.md).
 * - 422 when the request is well-formed but the configuration cannot be used.
 * - 502/503/504 when an upstream provider failed. We never return 429 for a provider's
 *   throttle: that would tell the caller *they* are rate limited by us.
 */
export const ERROR_TAXONOMY = {
  signature_invalid: { retryable: false, userActionable: false, httpStatus: 401, messageKey: null },
  timestamp_out_of_tolerance: { retryable: false, userActionable: false, httpStatus: 401, messageKey: null },
  replay_detected: { retryable: false, userActionable: false, httpStatus: 200, messageKey: null },
  // 403 per docs/specs/05-source-github.md (unknown installation_id).
  unauthorized_tenant: { retryable: false, userActionable: false, httpStatus: 403, messageKey: null },
  destination_url_rejected: {
    retryable: false,
    userActionable: true,
    httpStatus: 422,
    messageKey: 'errors.destination_url_rejected',
  },
  destination_credentials_invalid: {
    retryable: false,
    userActionable: true,
    httpStatus: 502,
    messageKey: 'errors.destination_credentials_invalid',
  },
  // F179: 410 Gone and Discord 404 land here — the provider said it is no longer interested.
  destination_revoked: {
    retryable: false,
    userActionable: true,
    httpStatus: 502,
    messageKey: 'errors.destination_revoked',
  },
  destination_unauthorized: {
    retryable: false,
    userActionable: true,
    httpStatus: 502,
    messageKey: 'errors.destination_unauthorized',
  },
  destination_rate_limited: {
    retryable: true,
    userActionable: false,
    httpStatus: 503,
    messageKey: 'errors.destination_rate_limited',
  },
  destination_unavailable: {
    retryable: true,
    userActionable: false,
    httpStatus: 502,
    messageKey: 'errors.destination_unavailable',
  },
  // F13 lists no copy for a timeout; to the user it is indistinguishable from "didn't
  // respond", so it reuses that message rather than surfacing nothing.
  destination_timeout: {
    retryable: true,
    userActionable: false,
    httpStatus: 504,
    messageKey: 'errors.destination_unavailable',
  },
  payload_too_large: {
    retryable: false,
    userActionable: true,
    httpStatus: 422,
    messageKey: 'errors.payload_too_large',
  },
  render_failed: {
    retryable: false,
    userActionable: true,
    httpStatus: 422,
    messageKey: 'errors.render_failed',
  },
  config_invalid: {
    retryable: false,
    userActionable: true,
    httpStatus: 422,
    messageKey: 'errors.config_invalid',
  },
  internal_error: {
    retryable: true,
    userActionable: false,
    httpStatus: 500,
    messageKey: 'errors.internal_error',
  },
} as const satisfies Record<ErrorCode, ErrorCodeSpec>;

const CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && CODE_SET.has(value);
}

/** Narrow a stored/untrusted value; anything unknown becomes `internal_error` (F13 default). */
export function toErrorCode(value: unknown): ErrorCode {
  return isErrorCode(value) ? value : DEFAULT_ERROR_CODE;
}

export function errorSpec(code: ErrorCode): ErrorCodeSpec {
  return ERROR_TAXONOMY[code];
}

export function errorClass(code: ErrorCode): ErrorClass {
  return ERROR_TAXONOMY[code].retryable ? 'retryable' : 'permanent';
}

export function isRetryable(code: ErrorCode): boolean {
  return ERROR_TAXONOMY[code].retryable;
}

export function httpStatusFor(code: ErrorCode): number {
  return ERROR_TAXONOMY[code].httpStatus;
}

/** Message id for user-facing copy, or `null` when the code must never surface (F220). */
export function userMessageKey(code: ErrorCode): string | null {
  return ERROR_TAXONOMY[code].messageKey;
}

export interface FallbackClassification {
  readonly code: ErrorCode;
  /**
   * Always true: a fallback means the provider mapping is incomplete, and F13/F179 require
   * every unmapped error to raise a metric so the mapping can be completed.
   */
  readonly unmapped: true;
}

/**
 * Generic classification for a provider response that no per-provider mapping recognised.
 * F13: 5xx → `destination_unavailable`, otherwise `internal_error`. Two statuses carry a
 * provider-independent meaning and are honoured here too: 429 (F13 table) and 410 Gone
 * (F179: "the provider has said it is no longer interested").
 */
export function classifyUnmappedHttpStatus(status: number): FallbackClassification {
  if (status === 429) return { code: 'destination_rate_limited', unmapped: true };
  if (status === 410) return { code: 'destination_revoked', unmapped: true };
  if (status >= 500 && status <= 599) return { code: 'destination_unavailable', unmapped: true };
  return { code: DEFAULT_ERROR_CODE, unmapped: true };
}

/** Compile-time exhaustiveness guard for switches over closed unions. */
export function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled ${context}: ${String(value)}`);
}
