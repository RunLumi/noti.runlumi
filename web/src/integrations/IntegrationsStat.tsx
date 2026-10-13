import { Link } from '@tanstack/react-router';
import { Card } from '../components/ui';
import { t } from '../i18n';
import { useIntegrations, useOrgId } from './hooks';
import { useLocale } from '../i18n/LocaleProvider';

/**
 * The Overview count, read from `GET /api/integrations` (F206: no number without a query).
 * Loading shows a word, a failed query says so, and neither ever renders a guessed 0.
 */
export function IntegrationsStat() {
  useLocale();
  const orgId = useOrgId();
  const list = useIntegrations(orgId);
  const integrations = list.data?.integrations ?? [];
  const enabled = integrations.filter((i) => i.enabled).length;
  const total = list.data?.truncated ? `${integrations.length}+` : String(integrations.length);
  return (
    <Card aria-busy={list.isPending || undefined}>
      <span className="stat-label">{t('overview.integrations')}</span>
      <strong>{list.isPending ? '—' : list.isError ? '—' : total}</strong>
      <small>
        {list.isPending ? (
          t('overview.integrations.loading')
        ) : list.isError ? (
          t('overview.integrations.error')
        ) : integrations.length === 0 ? (
          <Link to="/integrations/new" className="text-link">
            {t('overview.integrations.none')}
          </Link>
        ) : (
          t('overview.integrations.breakdown', { enabled, paused: integrations.length - enabled })
        )}
      </small>
    </Card>
  );
}
