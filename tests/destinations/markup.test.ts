import { describe, expect, it } from 'vitest';
import {
  ELLIPSIS,
  escapeText,
  fitAtoms,
  fitText,
  linkAtom,
  safeLinkUrl,
  sanitizeText,
  textAtoms,
} from '../../src/connectors/destinations/markup';
import {
  MAX_RETRY_AFTER_MS,
  parseDelaySeconds,
  parseRetryAfter,
} from '../../src/connectors/destinations/retry-after';
import {
  REDACTED_EMAIL,
  REDACTED_PHONE,
  redactContactDetails,
} from '../../src/connectors/destinations/redact';

function hasLoneSurrogate(s: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

describe('escaping per dialect', () => {
  it('escapes exactly & < > for Slack mrkdwn', () => {
    expect(escapeText('a & <b> *c*', 'slack_mrkdwn')).toBe('a &amp; &lt;b&gt; *c*');
  });

  it('cannot produce a Slack broadcast mention from untrusted text', () => {
    const out = escapeText('<!here> @here <@U123> <!channel>', 'slack_mrkdwn');
    expect(out).not.toMatch(/<[!@]/);
  });

  it('neutralises Lark tags and link syntax', () => {
    const out = escapeText('<at id=all></at> [click](https://evil.example)', 'lark_md');
    expect(out).not.toContain('<');
    expect(out).not.toContain('[');
    expect(out).toContain('＜at id=all＞');
  });

  it('neutralises Adaptive Card link syntax but keeps other text', () => {
    expect(escapeText('[x](https://evil.example) <b>', 'adaptive_card_md')).toBe(
      '［x］(https://evil.example) <b>',
    );
  });

  it('leaves plain text alone apart from control characters', () => {
    expect(escapeText('a & <b>', 'plain')).toBe('a & <b>');
  });

  it('strips controls and bidi overrides, normalises newlines', () => {
    expect(sanitizeText('a\u0000b\r\nc‮d\te')).toBe('ab\ncd\te');
  });
});

describe('truncation', () => {
  it('returns short text untouched', () => {
    expect(fitText('hello', 'plain', 5)).toEqual({ text: 'hello', truncated: false });
  });

  it('truncates visibly with an ellipsis within the limit', () => {
    const r = fitText('hello world', 'plain', 6);
    expect(r).toEqual({ text: 'hello' + ELLIPSIS, truncated: true });
    expect(r.text.length).toBeLessThanOrEqual(6);
  });

  it('never splits a surrogate pair', () => {
    const text = '😀'.repeat(10);
    for (let max = 1; max <= 21; max++) {
      const r = fitText(text, 'plain', max);
      expect(r.text.length).toBeLessThanOrEqual(max);
      expect(hasLoneSurrogate(r.text)).toBe(false);
    }
  });

  it('never splits a ZWJ emoji sequence or a flag', () => {
    const family = '👨‍👩‍👧‍👦';
    const r = fitText(family + family + 'x', 'plain', family.length + 3);
    expect(r.text).toBe(family + ELLIPSIS);
    expect(fitText('🇻🇳🇻🇳', 'plain', 5).text).toBe('🇻🇳' + ELLIPSIS);
    expect(fitText('🇻🇳🇻🇳', 'plain', 4).text).toBe(ELLIPSIS);
  });

  it('keeps Vietnamese combining marks with their base letter', () => {
    const decomposed = 'Tiếng Việt'.normalize('NFD');
    const r = fitText(decomposed, 'plain', 4);
    expect(r.truncated).toBe(true);
    expect(r.text.normalize('NFC').startsWith('Ti')).toBe(true);
    expect(/[̀-ͯ]$/.test(r.text.slice(0, -1)) || !/^\p{M}/u.test(r.text)).toBe(true);
  });

  it('never cuts through an escape entity', () => {
    const r = fitText('&&&&', 'slack_mrkdwn', 8);
    expect(r.text).toBe('&amp;' + ELLIPSIS);
  });

  it('never cuts through a link atom', () => {
    const link = linkAtom('https://github.com/a/b', 'Open', 'slack_mrkdwn');
    const r = fitAtoms(['x', link, ...textAtoms(' tail', 'slack_mrkdwn')], link.length + 2);
    expect(r.text).toBe('x' + link + ELLIPSIS);
    const cut = fitAtoms(['x', link], 5);
    expect(cut.text).toBe('x' + ELLIPSIS);
  });

  it('handles a zero budget', () => {
    expect(fitText('abc', 'plain', 0)).toEqual({ text: '', truncated: true });
  });
});

describe('links', () => {
  it('only accepts https URLs within the cap', () => {
    expect(safeLinkUrl('https://github.com/a')).toBe('https://github.com/a');
    expect(safeLinkUrl('http://github.com/a')).toBeUndefined();
    expect(safeLinkUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeLinkUrl('https://u:p@github.com')).toBeUndefined();
    expect(safeLinkUrl('https://github.com/' + 'a'.repeat(2100))).toBeUndefined();
    expect(safeLinkUrl(undefined)).toBeUndefined();
    expect(safeLinkUrl('::')).toBeUndefined();
  });

  it('encodes characters that would end the link in each dialect', () => {
    expect(linkAtom('https://x.test/a|b?c=1&d=2', 'L>', 'slack_mrkdwn')).toBe(
      '<https://x.test/a%7Cb?c=1&amp;d=2|L&gt;>',
    );
    expect(linkAtom('https://x.test/a_(b)', '[L]', 'lark_md')).toBe('[［L］](https://x.test/a_%28b%29)');
    expect(linkAtom('https://x.test/a', 'L', 'plain')).toBe('https://x.test/a');
  });
});

describe('Retry-After', () => {
  const now = Date.parse('2026-10-13T00:00:00Z');

  it('parses delay-seconds', () => {
    expect(parseRetryAfter('30', now)).toBe(30_000);
    expect(parseRetryAfter(' 0 ', now)).toBe(0);
  });

  it('parses all three HTTP-date forms', () => {
    expect(parseRetryAfter('Tue, 13 Oct 2026 00:00:10 GMT', now)).toBe(10_000);
    expect(parseRetryAfter('Tuesday, 13-Oct-26 00:00:10 GMT', now)).toBe(10_000);
    expect(parseRetryAfter('Tue Oct 13 00:00:10 2026', now)).toBeGreaterThanOrEqual(0);
  });

  it('clamps past dates to zero and huge values to the cap', () => {
    expect(parseRetryAfter('Mon, 12 Oct 2026 00:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('9999999999', now)).toBe(MAX_RETRY_AFTER_MS);
  });

  it('ignores garbage', () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter('-5', now)).toBeUndefined();
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter('2026-10-13', now)).toBeUndefined();
    expect(parseDelaySeconds('3')).toBe(3000);
    expect(parseDelaySeconds('x')).toBeUndefined();
    expect(parseDelaySeconds(null)).toBeUndefined();
  });
});

describe('contact-detail redaction', () => {
  it('masks emails and phone numbers', () => {
    const r = redactContactDetails('Ping jane.doe+ci@example.co.uk or +84 912 345 678 about #123');
    expect(r.redacted).toBe(true);
    expect(r.text).toBe(`Ping ${REDACTED_EMAIL} or ${REDACTED_PHONE} about #123`);
  });

  it('leaves ordinary text alone', () => {
    expect(redactContactDetails('Fix build for v1.2.3 (#4567)')).toEqual({
      text: 'Fix build for v1.2.3 (#4567)',
      redacted: false,
    });
  });
});
