import type { MouseEvent } from 'react';
import { t } from '../i18n';
import './a11y.css';

export const MAIN_ID = 'main-content';

/**
 * Bypass block (WCAG 2.4.1): the first focusable element on every screen. It moves focus to
 * the main landmark itself instead of relying on the browser's fragment navigation, which
 * does not reliably move focus in every browser and would also write `#main-content` into
 * the URL and the router's history.
 */
export function SkipLink() {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const main = document.getElementById(MAIN_ID);
    if (!main) return;
    event.preventDefault();
    main.focus();
    main.scrollIntoView?.({ block: 'start' });
  };
  return (
    <a className="skip-link" href={`#${MAIN_ID}`} onClick={onClick}>
      {t('shell.skip')}
    </a>
  );
}
