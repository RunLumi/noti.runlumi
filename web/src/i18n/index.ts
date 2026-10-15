import { en as coreEn, type PluralMessage } from './messages.en';
import { appEn } from './messages.app.en';
import { vi as coreVi } from './messages.vi';
import { appVi } from './messages.app.vi';
import { shellEn } from './messages.shell.en';
import { shellVi } from './messages.shell.vi';
import { getLocale, type Locale } from './locale';

/**
 * Translation-ready string lookup (F224). Components never build user-facing sentences by
 * concatenation: they pass a message id and named parameters. Plural messages are chosen with
 * `Intl.PluralRules` for the *active* locale, so Vietnamese (one category) and English (two)
 * each get their own forms instead of an English "(s)".
 *
 * Two locales ship: English (the source) and Vietnamese. `en` is complete by construction;
 * `vi` is checked against it by type and by `catalogue.test.ts`. If a Vietnamese id were ever
 * missing at runtime the English text is shown rather than a blank.
 */
export const en = { ...coreEn, ...appEn, ...shellEn } as const;
export type MessageId = keyof typeof en;
export type { PluralMessage };
export type Params = Readonly<Record<string, string | number>>;
export type Catalogue = Readonly<Record<MessageId, string | PluralMessage>>;

export const catalogues: Readonly<Record<Locale, Catalogue>> = {
  en,
  vi: { ...coreVi, ...appVi, ...shellVi },
};

const pluralRules = new Map<Locale, Intl.PluralRules>();
const numberFormats = new Map<Locale, Intl.NumberFormat>();

function pluralFor(locale: Locale): Intl.PluralRules {
  let rules = pluralRules.get(locale);
  if (!rules) pluralRules.set(locale, (rules = new Intl.PluralRules(locale)));
  return rules;
}

/** Locale-aware number formatting (marks differ: 1,234.5 in English, 1.234,5 in Vietnamese). */
export function formatNumber(value: number, locale: Locale = getLocale()): string {
  let format = numberFormats.get(locale);
  if (!format) numberFormats.set(locale, (format = new Intl.NumberFormat(locale)));
  return format.format(value);
}

function interpolate(template: string, params: Params | undefined, locale: Locale): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined) return import.meta.env.DEV ? `«${key}»` : '';
    return typeof value === 'number' ? formatNumber(value, locale) : value;
  });
}

function isPlural(value: string | PluralMessage): value is PluralMessage {
  return typeof value === 'object';
}

function lookup(id: MessageId, locale: Locale): string | PluralMessage {
  return catalogues[locale][id] ?? en[id];
}

/** Look up a message and fill `{name}` placeholders. */
export function t(id: MessageId, params?: Params): string {
  const locale = getLocale();
  const message = lookup(id, locale);
  return interpolate(isPlural(message) ? message.other : message, params, locale);
}

/** Look up a plural message for `count`; `{count}` is available to the template. */
export function tp(id: MessageId, count: number, params?: Params): string {
  const locale = getLocale();
  const message = lookup(id, locale);
  const all = { ...params, count };
  if (!isPlural(message)) return interpolate(message, all, locale);
  const category = pluralFor(locale).select(count);
  const template = (category === 'one' ? message.one : undefined) ?? message.other;
  return interpolate(template, all, locale);
}
