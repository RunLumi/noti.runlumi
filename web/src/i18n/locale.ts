/**
 * Active locale: detection, persistence and the `<html lang>` attribute (F224, WCAG 3.1.1).
 *
 * Order of precedence: a choice the person made (localStorage) beats the browser's language
 * list, which beats English. Every storage and DOM access is guarded: storage can be blocked
 * or throw (private windows, cleared site data), and the unit tests run without a DOM.
 */
export const LOCALES = ['en', 'vi'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_STORAGE_KEY = 'noti.locale';

export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((locale) => locale === value);
}

/** `vi-VN` and `VI` both match `vi`. Returns `null` for a language we do not ship. */
export function matchLocale(tag: string | null | undefined): Locale | null {
  const primary = tag?.trim().toLowerCase().split(/[-_]/)[0];
  return LOCALES.find((locale) => locale === primary) ?? null;
}

/** First supported language in the browser's preference order, else English. */
export function detectLocale(languages: readonly string[]): Locale {
  for (const tag of languages) {
    const match = matchLocale(tag);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

export function readStoredLocale(): Locale | null {
  try {
    const value = globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

function writeStored(locale: Locale): void {
  try {
    globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // The choice still applies for this page view; it just is not remembered.
  }
}

function browserLanguages(): readonly string[] {
  // Without a DOM (the Node unit tests) there is no person to ask: stay on English so
  // assertions do not depend on the machine's LANG.
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return [];
  return navigator.languages.length > 0 ? navigator.languages : [navigator.language];
}

function applyToDocument(locale: Locale): void {
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

/** The locale a fresh page view starts in. Exported so tests can re-run the decision. */
export function initialLocale(): Locale {
  return readStoredLocale() ?? detectLocale(browserLanguages());
}

let current: Locale = initialLocale();
applyToDocument(current);
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Switch language. `persist: false` is for tests and previews that must not stick. */
export function setLocale(locale: Locale, options: { readonly persist?: boolean } = {}): void {
  if (options.persist ?? true) writeStored(locale);
  applyToDocument(locale);
  if (locale === current) return;
  current = locale;
  listeners.forEach((listener) => listener());
}
