import { useEffect, useRef, useState } from 'react';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { t } from '../i18n';
import { useLocale } from '../i18n/LocaleProvider';
import { MAIN_ID } from './SkipLink';
import { routeTitleId } from './route-titles';
import './a11y.css';

/** The element a new page hands focus to: its first `<h1>`, else the main landmark. */
export function focusPageStart(root: ParentNode = document): void {
  const target =
    root.querySelector<HTMLElement>('main h1') ??
    root.querySelector<HTMLElement>('h1') ??
    root.querySelector<HTMLElement>(`#${MAIN_ID}`);
  if (!target) return;
  // A heading is not focusable by default; `-1` makes it a programmatic target only, so it is
  // never added to the Tab order.
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: false });
}

/** Longest we wait for a page to render its heading before settling for `<main>`. */
export const HEADING_WAIT_MS = 1000;

/**
 * Focus the page heading as soon as it exists, waiting up to `HEADING_WAIT_MS` for a route
 * that renders its `<h1>` only after data has loaded (a loading state has none). Gives up
 * quietly, and leaves focus alone, if the person has meanwhile moved it somewhere real.
 */
export function focusHeadingWhenReady(
  root: Document = document,
  timeoutMs: number = HEADING_WAIT_MS,
): () => void {
  const startedAt = root.activeElement;
  const personMoved = () => root.activeElement !== startedAt && root.activeElement !== root.body;
  const heading = () => root.querySelector<HTMLElement>('main h1') ?? root.querySelector<HTMLElement>('h1');
  let observer: MutationObserver | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    observer?.disconnect();
    clearTimeout(timer);
  };
  const attempt = (final: boolean) => {
    if (personMoved()) return stop();
    const found = heading();
    if (found || final) {
      stop();
      focusPageStart(root);
    }
  };
  const frame = requestAnimationFrame(() => {
    attempt(false);
    if (!heading() && !personMoved()) {
      observer = new MutationObserver(() => attempt(false));
      observer.observe(root.body, { childList: true, subtree: true });
      timer = setTimeout(() => attempt(true), timeoutMs);
    }
  });
  return () => {
    cancelAnimationFrame(frame);
    stop();
  };
}

/**
 * Single-page navigation does not reload, so the browser neither retitles the tab nor moves
 * focus. After a route change this does (WCAG 2.4.2, 2.4.3):
 *
 *  - `document.title` becomes "<page> · Lumi Noti", on first load and when the language changes;
 *  - focus moves to the page's `<h1>` (waiting for it if the route is still loading), so the
 *    next Tab continues from the new content. The heading is the announcement: its name is read
 *    when it takes focus, so there is no second live-region message for a navigation.
 *    The first render and redirects (`replace`) are left alone.
 *
 * The polite live region is used only for what has no focus move: a change of language on
 * the same page. Its text alternates with a trailing no-break space so an identical message is
 * announced again.
 *
 * A language change re-renders in place (every component subscribes with `useLocale()`,
 * enforced by `locale-reactivity.test.ts`); nothing remounts, so focus, open dialogs and typed
 * values survive.
 *
 * Only a change of *path* moves focus. Filtering the activity log changes the query string and
 * must not steal focus from the filter in use.
 *
 * Not implemented: restoring the previously focused element on browser Back/Forward. Those
 * navigations focus the heading like any other.
 */
export function RouteA11y() {
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [locale] = useLocale();
  const [announcement, setAnnouncement] = useState('');
  const lastPath = useRef<string | null>(null);
  const lastAction = useRef<string>('PUSH');
  const lastLocale = useRef(locale);
  const page = t(routeTitleId(pathname));

  useEffect(
    () =>
      router.history.subscribe(({ action }) => {
        lastAction.current = action.type;
      }),
    [router],
  );

  useEffect(() => {
    document.title = t('route.titleWithApp', { page });
  }, [page]);

  useEffect(() => {
    if (lastLocale.current === locale) return;
    lastLocale.current = locale;
    setAnnouncement(
      (previous) =>
        t('locale.changed', { language: t(locale === 'vi' ? 'locale.vi' : 'locale.en') }) +
        (previous.endsWith('\u00a0') ? '' : '\u00a0'),
    );
  }, [locale]);

  useEffect(() => {
    const isFirstRender = lastPath.current === null;
    const changed = lastPath.current !== pathname;
    lastPath.current = pathname;
    if (isFirstRender || !changed || lastAction.current === 'REPLACE') return;
    return focusHeadingWhenReady();
  }, [pathname]);

  return (
    <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
      {announcement}
    </div>
  );
}
