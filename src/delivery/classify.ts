/**
 * Provider response → F13 taxonomy (docs/specs/12-delivery-reliability.md F179, F178).
 *
 * This is the generic webhook mapping plus the Lark codes listed in F179. Per-destination
 * adapters with their own documented error surfaces arrive with slice 5 (F91–F104); until
 * then anything we do not recognise is flagged `unmapped` so a metric can name it.
 *
 * `diagnostic` is a code we mint (`provider_http_503`, `provider_lark_19021`). It is the
 * only provider-derived text that reaches `last_error`; bodies and URLs never do.
 */
import { classifyUnmappedHttpStatus, type ErrorCode } from '../platform/errors';
import { parseRetryAfter } from './retry';

export interface Classified {
  readonly code: ErrorCode;
  readonly retryAfterSeconds: number | null;
  readonly diagnostic: string;
  readonly unmapped: boolean;
}

/** Statuses whose meaning does not depend on the provider. */
const HTTP_STATUS_CODES: ReadonlyMap<number, ErrorCode> = new Map<number, ErrorCode>([
  [401, 'destination_unauthorized'],
  [403, 'destination_unauthorized'],
  // Slack `no_service`, Discord deleted webhook: retrying a 404 is never useful and, for
  // Discord, is punished with an IP-wide restriction (F179).
  [404, 'destination_revoked'],
  [408, 'destination_timeout'],
  [410, 'destination_revoked'],
  [413, 'payload_too_large'],
  [429, 'destination_rate_limited'],
]);

/** Classify a non-2xx response. The body is never read here. */
export function classifyHttpFailure(status: number, headers: Headers, nowMs: number): Classified {
  const known = HTTP_STATUS_CODES.get(status);
  const fallback = known ? null : classifyUnmappedHttpStatus(status);
  const code = known ?? fallback?.code ?? 'internal_error';
  return {
    code,
    retryAfterSeconds: parseRetryAfter(headers.get('retry-after'), nowMs),
    diagnostic: `provider_http_${status}`,
    // 5xx is the documented F13 fallback, not a gap in the mapping.
    unmapped: fallback !== null && code !== 'destination_unavailable',
  };
}

/** F179 Lark codes. Assignment of each code to a taxonomy entry is ours (ADR 0005). */
const LARK_CODES: ReadonlyMap<number, ErrorCode> = new Map<number, ErrorCode>([
  [19021, 'destination_credentials_invalid'], // sign / timestamp check failed
  [19022, 'destination_unauthorized'], // IP not allowed
  [19024, 'config_invalid'], // keyword check failed
  [230028, 'render_failed'], // DLP policy rejected the content
  [230025, 'payload_too_large'],
  [230011, 'destination_revoked'],
  [230110, 'destination_revoked'],
  [11232, 'destination_rate_limited'],
  [230020, 'destination_rate_limited'],
  [99991400, 'destination_rate_limited'],
  [9499, 'destination_unavailable'],
]);

function larkCode(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const r = body as Record<string, unknown>;
  const code = typeof r.code === 'number' ? r.code : r.StatusCode;
  return typeof code === 'number' && Number.isInteger(code) ? code : null;
}

/** `null` when Lark accepted the message (`code: 0`); otherwise the classification. */
export function classifyLarkReply(body: unknown): Classified | null {
  const code = larkCode(body);
  if (code === 0) return null;
  if (code === null) {
    return {
      code: 'internal_error',
      retryAfterSeconds: null,
      diagnostic: 'provider_rejected',
      unmapped: true,
    };
  }
  const mapped = LARK_CODES.get(code);
  return {
    code: mapped ?? 'internal_error',
    retryAfterSeconds: null,
    diagnostic: `provider_lark_${code}`,
    unmapped: mapped === undefined,
  };
}

/**
 * A thrown fetch: our deadline (`AbortSignal.timeout`) or a network/redirect failure.
 * Platform error messages can echo the URL, so none of it is kept (F12).
 */
export function classifyThrown(error: unknown): Classified {
  const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
  return timedOut
    ? {
        code: 'destination_timeout',
        retryAfterSeconds: null,
        diagnostic: 'provider_timeout',
        unmapped: false,
      }
    : {
        code: 'destination_unavailable',
        retryAfterSeconds: null,
        diagnostic: 'transient_error',
        unmapped: false,
      };
}
