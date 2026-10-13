import { useSyncExternalStore, type ReactNode } from 'react';
import { getLocale, setLocale, subscribeLocale, type Locale } from './locale';

/** The active locale, re-read whenever it changes. */
export function useLocale(): readonly [Locale, (next: Locale) => void] {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  return [locale, setLocale];
}

/**
 * `t()` is a plain function, so a component shows the new language only if it renders again.
 * Every component therefore calls `useLocale()` (a `useSyncExternalStore` subscription), and a
 * language change re-renders them in place: nothing remounts, so focus, open dialogs and typed
 * form values survive. `locale-reactivity.test.ts` fails if a component forgets.
 * This provider only keeps the store subscribed at the root.
 */
export function LocaleProvider({ children }: { readonly children: ReactNode }) {
  useLocale();
  return <>{children}</>;
}
