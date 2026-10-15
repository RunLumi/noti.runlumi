import type { MessageId } from '../i18n';
import { SETUP_PAGES, isSetupSlug } from '../setup/model';

/**
 * The human name of the page at `pathname`, as a message id. It feeds the document title,
 * the breadcrumb and the "page opened" announcement, so a screen-reader user hears the same
 * name a sighted user reads in the tab and the heading (WCAG 2.4.2 Page Titled).
 */
export function routeTitleId(pathname: string): MessageId {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path === '/') return 'route.title.overview';
  if (path === '/integrations') return 'route.title.integrations';
  if (path === '/integrations/new') return 'route.title.integrationNew';
  if (path.startsWith('/integrations/')) return 'route.title.integration';
  if (path.startsWith('/activity/')) return 'route.title.delivery';
  if (path.startsWith('/sources/')) return 'route.title.source';
  if (path === '/setup') return 'route.title.setup';
  if (path.startsWith('/setup/')) {
    const slug = path.slice('/setup/'.length);
    return isSetupSlug(slug) ? SETUP_PAGES[slug].title : 'route.title.unknown';
  }
  switch (path) {
    case '/sources':
      return 'sources.title';
    case '/activity':
      return 'route.title.activity';
    case '/destinations':
      return 'route.title.destinations';
    case '/audit':
      return 'route.title.audit';
    case '/team':
      return 'route.title.team';
    case '/settings':
      return 'route.title.settings';
    case '/onboarding':
      return 'route.title.onboarding';
    case '/invite':
      return 'route.title.invite';
    case '/signin':
      return 'route.title.signin';
    case '/signup':
      return 'route.title.signup';
    case '/forgot-password':
      return 'route.title.forgot';
    case '/verify':
      return 'route.title.verify';
    case '/reset':
      return 'route.title.reset';
    default:
      return 'route.title.unknown';
  }
}
