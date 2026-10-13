/**
 * Contact-detail masking for free-text fields (F102).
 *
 * Lark rejects a message with error 230028 when it contains "明文电话号码、明文个人邮箱"
 * (plaintext phone numbers, plaintext personal email addresses). GitHub payloads routinely
 * carry both (commit author emails, issue bodies), so the renderer masks them up front.
 * The patterns are deliberately broad: masking a non-phone number is cheap, a dead-letter
 * is not.
 */

export const REDACTED_EMAIL = '[email removed]';
export const REDACTED_PHONE = '[phone removed]';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// Optional `+`, then at least 8 digits allowing common separators between them.
const PHONE = /\+?\d(?:[\s().-]?\d){7,}/g;

export interface Redacted {
  readonly text: string;
  readonly redacted: boolean;
}

export function redactContactDetails(text: string): Redacted {
  const masked = text.replace(EMAIL, REDACTED_EMAIL).replace(PHONE, REDACTED_PHONE);
  return { text: masked, redacted: masked !== text };
}
