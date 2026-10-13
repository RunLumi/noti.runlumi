import { useEffect, useRef, useState } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { t } from '../i18n';
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

/**
 * Single-page navigation does not reload, so the browser neither retitles the tab, nor moves
 * focus, nor announces anything. This does all three after a route change (WCAG 2.4.2, 2.4.3,
 * 4.1.3):
 *
 *  - `document.title` becomes "<page> · Lumi Noti", also on first load and when the language
 *    changes;
 *  - the polite live region announces "<page> page opened";
 *  - focus moves to the page's `<h1>`, so the next Tab continues from the new content instead
 *    of from a link that no longer exists. The first render is left alone: the browser's own
 *    page-load focus behaviour is right there.
 *
 * Only a change of *path* counts. Filtering the activity log changes the query string and must
 * not steal focus from the filter the person is using.
 */
export function RouteA11y() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [announcement, setAnnouncement] = useState('');
  const lastPath = useRef<string | null>(null);
  const page = t(routeTitleId(pathname));

  useEffect(() => {
    document.title = t('route.titleWithApp', { page });
    const isFirstRender = lastPath.current === null;
    const changed = lastPath.current !== pathname;
    lastPath.current = pathname;
    if (isFirstRender || !changed) return;
    setAnnouncement(t('route.announce', { page }));
    // Wait a frame so the new route has committed its heading.
    const frame = requestAnimationFrame(() => focusPageStart());
    return () => cancelAnimationFrame(frame);
  }, [pathname, page]);

  return (
    <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
      {announcement}
    </div>
  );
}
