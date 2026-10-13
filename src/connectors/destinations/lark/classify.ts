import { classifyHttpStatus, permanent, retryable, unmapped } from '../classify';
import { parseDelaySeconds, parseRetryAfter } from '../retry-after';
import type { ClassifiedResponse, DeliveryReason, ProviderResponse } from '../types';

/**
 * Lark responses carry a JSON `code`; `0` is success. Classification is by `code` first,
 * because legacy OpenAPIs may answer throttling with HTTP 400 instead of 429 (F102).
 *
 * Only individually verified codes are mapped (DESTINATION_API_REFERENCE.md §3.1, §3.2, §3.5).
 * The canonical error-code table 404s, so the mapping is deliberately incomplete and an
 * unknown code is flagged `unmapped` for a metric.
 * UNVERIFIED: the meaning of 19001 (the reference could not confirm it), so it is unmapped.
 */

type LarkRule =
  | { readonly kind: 'rate_limited' }
  | { readonly kind: 'permanent'; readonly reason: Exclude<DeliveryReason, 'ok'> };

const RATE_LIMITED: LarkRule = { kind: 'rate_limited' };
const p = (reason: Exclude<DeliveryReason, 'ok'>): LarkRule => ({ kind: 'permanent', reason });

const KNOWN_CODES: ReadonlyMap<number, LarkRule> = new Map([
  // Custom bot (add-custom-bot guide).
  [9499, p('payload_rejected')],
  [19021, p('signature_rejected')], // sign mismatch or timestamp outside one hour
  [19022, p('destination_policy_blocked')], // IP allowlist
  [19024, p('destination_policy_blocked')], // custom keywords not found
  [11232, RATE_LIMITED], // system pressure, typically on the hour/half-hour
  // im/v1 (app bot); harmless to map for custom bots that never return them.
  [99991400, RATE_LIMITED],
  [230020, RATE_LIMITED],
  [230001, p('payload_rejected')],
  [230099, p('payload_rejected')],
  [230025, p('payload_too_large')],
  [230028, p('content_policy_blocked')], // DLP: plaintext phone numbers / personal emails
  [230006, p('destination_policy_blocked')], // bot capability disabled
  [230027, p('destination_policy_blocked')], // external group not permitted
  [230035, p('destination_policy_blocked')], // send permission denied
  [230038, p('destination_policy_blocked')], // cross-tenant P2P forbidden
  [232009, p('destination_revoked')], // chat dissolved
]);

function readCode(bodyText: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { code, StatusCode } = parsed as { code?: unknown; StatusCode?: unknown };
  // `StatusCode` is a documented-but-discouraged legacy duplicate of `code`.
  if (typeof code === 'number') return code;
  return typeof StatusCode === 'number' ? StatusCode : undefined;
}

function larkRetryAfter(res: ProviderResponse, now: number): number | undefined {
  return (
    parseDelaySeconds(res.headers.get('x-ogw-ratelimit-reset')) ??
    parseRetryAfter(res.headers.get('retry-after'), now)
  );
}

function applyRule(rule: LarkRule, code: number, res: ProviderResponse, now: number): ClassifiedResponse {
  const providerCode = String(code);
  if (rule.kind === 'permanent') return permanent(rule.reason, providerCode);
  return retryable('destination_rate_limited', { retryAfterMs: larkRetryAfter(res, now), providerCode });
}

export function classifyLarkResponse(res: ProviderResponse, now: number): ClassifiedResponse {
  const code = readCode(res.bodyText);
  if (code === 0 && res.status >= 200 && res.status <= 299) return { outcome: 'delivered', reason: 'ok' };
  const rule = code === undefined ? undefined : KNOWN_CODES.get(code);
  if (rule && code !== undefined) return applyRule(rule, code, res, now);
  if (res.status === 429 || res.status >= 500) return classifyHttpStatus(res, now);
  // An unknown Lark code (or a 2xx without `code: 0`) is never guessed at.
  if (code !== undefined || (res.status >= 200 && res.status <= 299)) return unmapped(res.status);
  return classifyHttpStatus(res, now);
}

/** Legacy helper retained for existing callers: true only for a success body. */
export function larkAccepted(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const obj = body as { code?: unknown; StatusCode?: unknown };
  return obj.code === 0 || obj.StatusCode === 0;
}
