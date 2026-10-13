import { describe, expect, it } from 'vitest';
import { catalogues, en, type PluralMessage } from './index';
import { compareCatalogues } from './catalogue-check';

/**
 * The Vietnamese catalogue must stay in lock-step with English (F224). Types already reject a
 * missing id at compile time; these tests make the failure explicit in CI and add what types
 * cannot see: placeholder agreement, plural shape, stray braces, and untranslated copies.
 */
const vi = catalogues.vi;
type Entry = string | PluralMessage;

const ids = Object.keys(en) as (keyof typeof en)[];
const placeholders = (text: string): string[] => [...new Set(text.match(/\{\w+\}/g) ?? [])].sort();
/** Words of running text: placeholders, addresses and symbols do not count. */
const proseWords = (text: string): number => (text.replace(/\{\w+\}/g, '').match(/\p{L}{2,}/gu) ?? []).length;
const variants = (entry: Entry): Record<string, string> =>
  typeof entry === 'string' ? { other: entry } : { ...entry };

const templateOf = (id: keyof typeof en): string => variants(vi[id]).other ?? '';

describe('Vietnamese catalogue', () => {
  it('has every English message id', () => {
    const missing = ids.filter((id) => !(id in vi));
    expect(missing, `missing from vi: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no ids that English lacks (typos and leftovers)', () => {
    const extra = Object.keys(vi).filter((id) => !(id in en));
    expect(extra, `unknown in vi: ${extra.join(', ')}`).toEqual([]);
  });

  it('has a non-empty translation for every id', () => {
    const empty = ids.filter((id) => Object.values(variants(vi[id])).some((text) => text.trim() === ''));
    expect(empty).toEqual([]);
  });

  it('uses exactly the same {placeholders} as English, for every message', () => {
    const mismatched: string[] = [];
    for (const id of ids) {
      const source = variants(en[id]);
      const target = variants(vi[id]);
      const expected = placeholders(source.other ?? '');
      // English `one` and `other` must agree with each other, or the template is malformed.
      if (source.one !== undefined && placeholders(source.one).join() !== expected.join())
        mismatched.push(`${id}: English one/other disagree`);
      for (const [category, text] of Object.entries(target)) {
        if (placeholders(text).join() !== expected.join())
          mismatched.push(`${id}.${category}: ${placeholders(text).join(' ')} != ${expected.join(' ')}`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('has no stray braces beyond English’s: no half-written placeholder', () => {
    // A message may legitimately show literal braces (a list of unsupported characters), so
    // compare with the English text rather than forbidding them.
    const stray = (text: string) => (text.replace(/\{\w+\}/g, '').match(/[{}]/g) ?? []).length;
    const broken = ids.filter(
      (id) => stray(variants(vi[id]).other ?? '') !== stray(variants(en[id]).other ?? ''),
    );
    expect(broken).toEqual([]);
  });

  it('gives plural messages only the categories Vietnamese uses', () => {
    // `Intl.PluralRules('vi')` has a single category, "other"; an English `one` form copied
    // across would never be chosen and hides an untranslated sentence.
    const categories = new Intl.PluralRules('vi').resolvedOptions().pluralCategories;
    expect(categories).toEqual(['other']);
    const wrong = ids.filter((id) => {
      const entry = vi[id];
      return typeof entry === 'object' && Object.keys(entry).some((c) => !categories.includes(c as 'other'));
    });
    expect(wrong).toEqual([]);
  });

  it('keeps plural-ness: a plural English message is plural in Vietnamese and vice versa', () => {
    const shape = ids.filter((id) => (typeof en[id] === 'object') !== (typeof vi[id] === 'object'));
    expect(shape).toEqual([]);
  });

  it('actually translates: no long sentence is a verbatim copy of the English', () => {
    // Short labels (Lark, Slack, Webhook URL, owner/repository) are legitimately identical.
    const copied = ids.filter((id) => {
      const source = variants(en[id]).other ?? '';
      return proseWords(source) >= 4 && source === variants(vi[id]).other;
    });
    expect(copied).toEqual([]);
  });

  it('keeps provider labels verbatim: the Lark steps name the Chinese menu text', () => {
    // F212: the user must find these exact characters on Lark's own screen.
    const lark = [templateOf('destination.lark.step2'), templateOf('destination.lark.step3')].join(' ');
    for (const label of ['设置', '群机器人', '添加机器人', '自定义机器人']) expect(lark).toContain(label);
    expect(templateOf('destination.lark.step5')).toContain('签名校验');
  });

  it('does not translate product or developer terms', () => {
    expect(templateOf('field.webhookUrl')).toBe('Webhook URL');
    for (const id of ids) {
      const source = variants(en[id]).other ?? '';
      const target = variants(vi[id]).other ?? '';
      for (const term of ['GitHub', 'Slack', 'Lark', 'Noti', 'Microsoft Teams']) {
        const whole = new RegExp(`\\b${term}\\b`);
        if (whole.test(source)) expect(target, `${id} dropped "${term}"`).toMatch(whole);
      }
    }
  });

  it('really is Vietnamese: composed tone marks are present throughout', () => {
    // A catalogue that silently fell back to ASCII would pass the checks above.
    const tonal = /[ạảãàáâậầấẩẫăắằặẳẵéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵđ]/i;
    const bare = ids.filter((id) => {
      const text = variants(vi[id]).other ?? '';
      return proseWords(text) >= 4 && !/[@/]/.test(text) && !tonal.test(text);
    });
    expect(bare).toEqual([]);
  });

  it('is stored in Unicode NFC, so a tone mark is one code point everywhere it is searched', () => {
    const decomposed = ids.filter((id) =>
      Object.values(variants(vi[id])).some((text) => text !== text.normalize('NFC')),
    );
    expect(decomposed).toEqual([]);
  });
});

describe('English catalogue', () => {
  it('has no empty messages', () => {
    const empty = ids.filter((id) => Object.values(variants(en[id])).some((text) => text.trim() === ''));
    expect(empty).toEqual([]);
  });
});

describe('the catalogue checks themselves', () => {
  const source = { a: 'Hello {name}', b: { one: '{count} item', other: '{count} items' } };

  it('accepts a faithful translation', () => {
    expect(compareCatalogues(source, { a: 'Xin chào {name}', b: { other: '{count} mục' } })).toEqual([]);
  });

  it('fails on a missing id', () => {
    expect(compareCatalogues(source, { a: 'Xin chào {name}' })).toEqual(['b: missing']);
  });

  it('fails on an id the source does not have', () => {
    expect(compareCatalogues(source, { a: 'Xin chào {name}', b: { other: '{count}' }, c: 'thừa' })).toEqual([
      'c: not in the source catalogue',
    ]);
  });

  it('fails on a dropped, renamed or invented placeholder', () => {
    expect(compareCatalogues(source, { a: 'Xin chào', b: { other: '{count}' } })).toHaveLength(1);
    expect(compareCatalogues(source, { a: 'Xin chào {ten}', b: { other: '{count}' } })).toHaveLength(1);
    expect(compareCatalogues(source, { a: 'Xin chào {name} {extra}', b: { other: '{count}' } })).toHaveLength(
      1,
    );
  });

  it('passes for the shipped catalogues', () => {
    expect(compareCatalogues(en, vi)).toEqual([]);
  });
});
