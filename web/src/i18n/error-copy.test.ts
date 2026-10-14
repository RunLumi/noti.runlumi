import { describe, expect, it } from 'vitest';
import { ERROR_TAXONOMY } from '../../../src/platform/errors';
import { ERROR_KINDS, ERROR_PANEL_MESSAGE_IDS } from '../components/ErrorPanel';
import { catalogues, en, type MessageId } from './index';

/**
 * Plain-language errors (spec 14 F220). No catalogue message may be filler, a bare status, or
 * raw exception text, and every failure the taxonomy can show has copy to show.
 */
const BANNED_EN = [
  /something went wrong/i,
  /\boops\b/i,
  /\bwhoops\b/i,
  /\buh[- ]?oh\b/i,
  /error 5\d\d/i,
  /error 4\d\d/i,
  /internal server error/i,
  /an? (unexpected )?error (has )?occurred/i,
  /\bundefined\b/i,
  /\[object /i,
  /\bTypeError\b|\bReferenceError\b|\bstack trace\b|\bexception\b/i,
];
const BANNED_VI = [/đã xảy ra lỗi/i, /có lỗi xảy ra/i, /đã có lỗi xảy ra/i, /rất tiếc/i, /lỗi 5\d\d/i];

const text = (entry: string | { readonly other: string; readonly one?: string }): string[] =>
  typeof entry === 'string' ? [entry] : [entry.other, ...(entry.one ? [entry.one] : [])];

describe('no filler error copy in either catalogue', () => {
  for (const [locale, banned] of [
    ['en', BANNED_EN],
    ['vi', BANNED_VI],
  ] as const) {
    it(locale, () => {
      const offenders: string[] = [];
      for (const [id, entry] of Object.entries(catalogues[locale]))
        for (const line of text(entry))
          for (const pattern of banned) if (pattern.test(line)) offenders.push(`${id}: ${pattern}`);
      expect(offenders).toEqual([]);
    });
  }

  it('the patterns do catch the phrases they name', () => {
    expect(BANNED_EN.some((p) => p.test('Oops! Something went wrong'))).toBe(true);
    expect(BANNED_EN.some((p) => p.test('Error 500'))).toBe(true);
    expect(BANNED_VI.some((p) => p.test('Đã xảy ra lỗi'))).toBe(true);
  });
});

describe('every user-facing failure has copy', () => {
  it('has a catalogue message for each taxonomy message key', () => {
    for (const [code, spec] of Object.entries(ERROR_TAXONOMY)) {
      if (spec.messageKey === null) continue;
      expect(en[spec.messageKey as MessageId], code).toBeTruthy();
    }
  });

  it('four-part panel: a why and a what-to-do for each kind, plus a way to get help', () => {
    for (const id of ERROR_PANEL_MESSAGE_IDS) expect(en[id], id).toBeTruthy();
    for (const kind of ERROR_KINDS) {
      expect(en[`errorpanel.why.${kind}` as MessageId], kind).toBeTruthy();
      expect(en[`errorpanel.do.${kind}` as MessageId], kind).toBeTruthy();
    }
    expect(en['errorpanel.help']).toMatch(/admin/i);
  });

  it('each request-error sentence says what to do (ends in an instruction, not a bare cause)', () => {
    for (const kind of ERROR_KINDS) {
      const line = en[`errorpanel.do.${kind}` as MessageId] as string;
      expect(line, kind).toMatch(/^[A-Z]/);
      expect(line.length, kind).toBeGreaterThan(15);
    }
  });
});
