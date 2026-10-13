import { getLocale, type Locale } from './locale';

/**
 * Locale-aware dates and relative times (F224). Everything goes through `Intl`, using the
 * active locale, so Vietnamese gets "13 thg 10, 2026, 14:30" and "3 giờ trước" rather than
 * English strings or a hand-built "dd/mm". Formatters are cached per locale and style.
 * Timestamps are ISO strings in UTC; `Intl` renders them in the reader's own time zone.
 */
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
const relativeFormats = new Map<Locale, Intl.RelativeTimeFormat>();

function dateTimeFormat(locale: Locale, style: 'date' | 'datetime'): Intl.DateTimeFormat {
  const key = `${locale}:${style}`;
  let format = dateTimeFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(
      locale,
      style === 'date' ? { dateStyle: 'medium' } : { dateStyle: 'medium', timeStyle: 'short' },
    );
    dateTimeFormats.set(key, format);
  }
  return format;
}

function relativeFormat(locale: Locale): Intl.RelativeTimeFormat {
  let format = relativeFormats.get(locale);
  if (!format)
    relativeFormats.set(locale, (format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })));
  return format;
}

/** The input unchanged when it is not a date, so a bad value is visible instead of "Invalid Date". */
export function formatDate(value: string | Date, locale: Locale = getLocale()): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : dateTimeFormat(locale, 'date').format(date);
}

export function formatDateTime(value: string | Date, locale: Locale = getLocale()): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : dateTimeFormat(locale, 'datetime').format(date);
}

export function formatRelative(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  locale: Locale = getLocale(),
): string {
  return relativeFormat(locale).format(value, unit);
}
