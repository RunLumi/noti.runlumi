import type { MessageId } from '../i18n';
import { routeTitleId } from '../a11y/route-titles';
import { SETUP_PAGES, isSetupSlug } from '../setup/model';

/**
 * The breadcrumb trail for a path, below the workspace root (spec 14 F205). Top-level pages have
 * one crumb; nested pages (an integration's settings, the create wizard, a setup step) have the
 * section as a link and the page as the current crumb. The integration's own name is not known
 * here: the crumb carries its id so the shell can fill the name in from the data it has. A
 * source's page does the same with `sourceId`. A delivery's page keeps the generic "Delivery"
 * crumb: it has no name of its own, and its heading already names the integration (ADR 0056).
 */
export interface Crumb {
  readonly label: MessageId;
  /** Where the crumb links, or null for the current page. */
  readonly to: string | null;
  /** Set on the integration crumb: its display name replaces the generic label once loaded. */
  readonly integrationId?: string;
  /** Set on the source crumb: the source's name replaces the generic label once loaded. */
  readonly sourceId?: string;
}

const section = (pathname: string): string => `/${pathname.split('/')[1] ?? ''}`;

export function crumbsFor(pathname: string): readonly Crumb[] {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'integrations' && parts.length === 2)
    return [
      { label: 'route.title.integrations', to: '/integrations' },
      parts[1] === 'new'
        ? { label: 'route.title.integrationNew', to: null }
        : { label: 'route.title.integration', to: null, integrationId: parts[1] ?? '' },
    ];
  if (parts[0] === 'activity' && parts.length === 2)
    return [
      { label: 'route.title.activity', to: '/activity' },
      { label: 'route.title.delivery', to: null },
    ];
  if (parts[0] === 'sources' && parts.length === 2)
    return [
      { label: 'sources.title', to: '/sources' },
      { label: 'route.title.source', to: null, sourceId: parts[1] ?? '' },
    ];
  if (parts[0] === 'setup' && parts.length === 2 && isSetupSlug(parts[1]))
    return [
      { label: 'route.title.setup', to: '/setup' },
      { label: SETUP_PAGES[parts[1]].title, to: null },
    ];
  return [{ label: routeTitleId(section(path)), to: null }];
}
