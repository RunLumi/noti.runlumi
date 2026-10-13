import { Fragment, useSyncExternalStore, type ReactNode } from 'react';
import { getLocale, setLocale, subscribeLocale, type Locale } from './locale';

/** The active locale, re-read whenever it changes. */
export function useLocale(): readonly [Locale, (next: Locale) => void] {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  return [locale, setLocale];
}

/**
 * Re-renders everything below it when the language changes. `t()` is a plain function and
 * components do not subscribe to it individually, so the subtree is keyed by locale and
 * remounts. The trade-off is explicit: a language switch discards uncommitted component state
 * (an unfinished form). The router, query cache and URL live above this boundary and survive,
 * so the person stays on the same page with the same data.
 */
export function LocaleProvider({ children }: { readonly children: ReactNode }) {
  const [locale] = useLocale();
  return <Fragment key={locale}>{children}</Fragment>;
}
