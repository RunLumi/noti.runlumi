import { en, type MessageId, type PluralMessage } from './messages.en';

/**
 * Translation-ready string lookup (F224). Components never build user-facing sentences by
 * concatenation: they pass a message id and named parameters. Plural messages are chosen with
 * `Intl.PluralRules`, so a second locale gets its own categories instead of an English "(s)".
 *
 * Only one locale ships today. Adding one means adding a catalogue with the same ids; it is
 * not a claim that the product is translated.
 */
export type { MessageId };
export type Params = Readonly<Record<string, string | number>>;

const LOCALE = 'en';
const pluralRules = new Intl.PluralRules(LOCALE);
const numberFormat = new Intl.NumberFormat(LOCALE);

function interpolate(template: string, params: Params | undefined): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key];
    if (value === undefined) return import.meta.env.DEV ? `«${key}»` : '';
    return typeof value === 'number' ? numberFormat.format(value) : value;
  });
}

function isPlural(value: string | PluralMessage): value is PluralMessage {
  return typeof value === 'object';
}

/** Look up a message and fill `{name}` placeholders. */
export function t(id: MessageId, params?: Params): string {
  const message = en[id];
  if (isPlural(message)) return interpolate(message.other, params);
  return interpolate(message, params);
}

/** Look up a plural message for `count`; `{count}` is available to the template. */
export function tp(id: MessageId, count: number, params?: Params): string {
  const message = en[id];
  const all = { ...params, count };
  if (!isPlural(message)) return interpolate(message, all);
  const category = pluralRules.select(count);
  const template = (category === 'one' ? message.one : undefined) ?? message.other;
  return interpolate(template, all);
}
