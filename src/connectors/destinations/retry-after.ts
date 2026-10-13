/**
 * `Retry-After` per RFC 9110 §10.2.3: either `delay-seconds` or an `HTTP-date`.
 * https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3
 */

/** A hostile or broken header must not park a delivery for days. */
export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

const DELAY_SECONDS = /^\d{1,10}$/;

const HTTP_DATE: readonly RegExp[] = [
  /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/,
  /^[A-Z][a-z]{5,8}, \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT$/,
  /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/,
];

function clamp(ms: number): number {
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

/** Milliseconds to wait, or `undefined` when the header is absent or unparseable. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (DELAY_SECONDS.test(trimmed)) return clamp(Number(trimmed) * 1000);
  // RFC 9110 §5.6.7: recipients must accept IMF-fixdate, RFC 850 and asctime forms. Anything
  // else is refused so `Date.parse` is never handed an arbitrary, engine-dependent string.
  if (!HTTP_DATE.some((re) => re.test(trimmed))) return undefined;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : clamp(at - now);
}

/** Seconds-valued provider headers such as Lark's `x-ogw-ratelimit-reset`. */
export function parseDelaySeconds(value: string | null): number | undefined {
  if (value === null || !DELAY_SECONDS.test(value.trim())) return undefined;
  return clamp(Number(value.trim()) * 1000);
}
