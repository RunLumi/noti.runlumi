/**
 * Contact-detail masking for free-text fields (F102).
 *
 * Lark rejects a message with error 230028 when it contains "明文电话号码、明文个人邮箱"
 * (plaintext phone numbers, plaintext personal email addresses). GitHub payloads routinely
 * carry both (commit author emails, issue bodies), so the renderer masks them up front.
 *
 * Both scanners are linear in the input length: input is untrusted and may be large, so no
 * pattern here may backtrack over an unbounded span. Callers should still bound the input
 * (see `MAX_FIELD_INPUT_CHARS` in render.ts) before calling.
 */

export const REDACTED_EMAIL = '[email removed]';
export const REDACTED_PHONE = '[phone removed]';

const MAX_LOCAL_PART = 64;
const MAX_DOMAIN = 255;
const LOCAL_CHAR = /[A-Za-z0-9._%+-]/;
const DOMAIN_CHAR = /[A-Za-z0-9.-]/;
const DOMAIN_SHAPE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;

export interface Redacted {
  readonly text: string;
  readonly redacted: boolean;
}

function localStart(text: string, at: number, floor: number): number {
  let start = at;
  while (start > floor && at - start < MAX_LOCAL_PART && LOCAL_CHAR.test(text.charAt(start - 1))) start--;
  return start;
}

function domainEnd(text: string, at: number): number {
  let end = at + 1;
  while (end < text.length && end - at - 1 < MAX_DOMAIN && DOMAIN_CHAR.test(text.charAt(end))) end++;
  // A sentence-ending dot or dash is punctuation, not part of the domain.
  while (end > at + 1 && /[.-]/.test(text.charAt(end - 1))) end--;
  return end;
}

/** Linear scan: each `@` inspects at most 64 characters left and 255 right. */
function maskEmails(text: string): string {
  let at = text.indexOf('@');
  if (at < 0) return text;
  let out = '';
  let cursor = 0;
  while (at >= 0) {
    const start = localStart(text, at, cursor);
    const end = domainEnd(text, at);
    const isEmail = start < at && DOMAIN_SHAPE.test(text.slice(at + 1, end));
    if (isEmail) {
      out += text.slice(cursor, start) + REDACTED_EMAIL;
      cursor = end;
    }
    at = text.indexOf('@', isEmail ? end : at + 1);
  }
  return out + text.slice(cursor);
}

/**
 * Phone candidates: an optional `+`, then 8–15 digits separated by at most one space, dash
 * or parenthesis. Dots are not separators, so dotted versions never match. Each repetition
 * consumes exactly one digit, so matching is linear.
 */
const PHONE_CANDIDATE = /(?<![\w+])\+?\d(?:[ ()-]?\d){7,14}(?!\w)/g;
const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}(?!\d)/;
const CN_MOBILE = /^1[3-9]\d{9}$/;

function looksLikePhone(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '');
  if (candidate.startsWith('+')) return digits.length >= 8;
  if (ISO_DATE_PREFIX.test(candidate)) return false;
  // Unseparated runs are usually IDs (build numbers, timestamps); the one exception masked
  // is the 11-digit mainland-China mobile shape, which Lark's DLP is most likely to target.
  if (/^\d+$/.test(candidate)) return CN_MOBILE.test(candidate);
  return digits.length >= 9;
}

function maskPhones(text: string): string {
  return text.replace(PHONE_CANDIDATE, (m) => (looksLikePhone(m) ? REDACTED_PHONE : m));
}

export function redactContactDetails(text: string): Redacted {
  const masked = maskPhones(maskEmails(text));
  return { text: masked, redacted: masked !== text };
}
