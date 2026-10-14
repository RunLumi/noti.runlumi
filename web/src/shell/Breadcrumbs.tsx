import { Link, useRouterState } from '@tanstack/react-router';
import { IconChevronRight } from '@tabler/icons-react';
import { useIntegration, useOrgId } from '../integrations/hooks';
import { t } from '../i18n';
import { useLocale } from '../i18n/LocaleProvider';
import { crumbsFor, type Crumb } from './crumbs';

/** The integration's own name once loaded; the generic page name while it is not (or if it failed). */
function IntegrationName({ id }: { id: string }) {
  useLocale();
  const orgId = useOrgId();
  const integration = useIntegration(orgId, id);
  return <>{integration.data?.name ?? t('route.title.integration')}</>;
}

function CrumbLabel({ crumb }: { crumb: Crumb }) {
  useLocale();
  return crumb.integrationId ? <IntegrationName id={crumb.integrationId} /> : <>{t(crumb.label)}</>;
}

/**
 * Where the person is, as a labelled trail (spec 14 F205): Workspace, then the section, then the
 * page. Earlier crumbs are links; the last is the current page (`aria-current="page"`). It is an
 * ordered list inside a `nav`, so a screen reader announces "Breadcrumb, list of 3 items".
 */
export function Breadcrumbs() {
  useLocale();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const crumbs = crumbsFor(pathname);
  return (
    <nav aria-label={t('shell.breadcrumbs')} className="breadcrumbs">
      <ol>
        <li>
          {crumbs.length === 1 && pathname === '/' ? (
            <span>{t('shell.breadcrumbRoot')}</span>
          ) : (
            <Link to="/">{t('shell.breadcrumbRoot')}</Link>
          )}
        </li>
        {crumbs.map((crumb) => (
          <li key={crumb.label + (crumb.integrationId ?? '')}>
            <IconChevronRight size={14} aria-hidden="true" />
            {crumb.to ? (
              <Link to={crumb.to as '/integrations'}>
                <CrumbLabel crumb={crumb} />
              </Link>
            ) : (
              <span aria-current="page">
                <CrumbLabel crumb={crumb} />
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
