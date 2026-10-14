import { Link } from '@tanstack/react-router';
import { IconPlus, IconRefresh, IconWebhook } from '@tabler/icons-react';
import { Button, Notice } from '../components/ui';
import { t, tp } from '../i18n';
import { PageHeader } from '../components/PageHeader';
import { describeError } from './errors';
import { useIntegrations, useOrgId } from './hooks';
import { IntegrationCard } from './IntegrationCard';
import { GithubPanel } from './github/GithubPanel';
import { GithubReturnStatus } from './github/ReturnStatus';
import './integrations.css';
import { useLocale } from '../i18n/LocaleProvider';

function NewIntegrationLink() {
  useLocale();
  return (
    <Link to="/integrations/new" className="btn btn-primary">
      <IconPlus size={18} aria-hidden="true" />
      {t('integrations.new')}
    </Link>
  );
}

/** Shape-matched placeholder rows; the container carries `aria-busy` (F225). */
function ListSkeleton() {
  useLocale();
  return (
    <div className="integration-list" aria-busy="true" aria-label={t('integrations.loading')}>
      {[0, 1].map((i) => (
        <div key={i} className="integration-card skeleton-card" aria-hidden="true">
          <span className="skeleton skeleton-title" />
          <span className="skeleton skeleton-line" />
          <span className="skeleton skeleton-line skeleton-short" />
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  useLocale();
  return (
    <section className="empty integrations-empty" aria-labelledby="integrations-empty-title">
      <div className="empty-icon">
        <IconWebhook size={24} aria-hidden="true" />
      </div>
      <h2 id="integrations-empty-title">{t('integrations.empty.title')}</h2>
      <p>{t('integrations.empty.body')}</p>
      <Link to="/integrations/new" className="btn btn-primary">
        <IconPlus size={18} aria-hidden="true" />
        {t('integrations.empty.action')}
      </Link>
    </section>
  );
}

export function IntegrationsPage() {
  useLocale();
  const orgId = useOrgId();
  const list = useIntegrations(orgId);
  const integrations = list.data?.integrations ?? [];
  const paused = integrations.filter((i) => !i.enabled).length;
  return (
    <>
      <PageHeader
        eyebrow={t('integrations.eyebrow')}
        title={t('integrations.title')}
        description={t('integrations.description')}
        action={integrations.length > 0 ? <NewIntegrationLink /> : undefined}
      />
      {orgId && <GithubReturnStatus orgId={orgId} resumeSetup />}
      {orgId && <GithubPanel orgId={orgId} />}
      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError ? (
        // A failed query is an error, never an empty list (F225).
        <Notice kind="error">
          <p className="notice-title">{t('integrations.error.title')}</p>
          <p>
            {describeError(list.error).message} {t('integrations.error.body')}
          </p>
          <Button variant="outline" onClick={() => void list.refetch()} disabled={list.isFetching}>
            <IconRefresh size={18} aria-hidden="true" />
            {t('integrations.retry')}
          </Button>
        </Notice>
      ) : integrations.length === 0 ? (
        <EmptyState />
      ) : (
        <section aria-labelledby="integrations-list-title">
          <div className="list-summary">
            <h2 id="integrations-list-title">{tp('integrations.count', integrations.length)}</h2>
            {paused > 0 && (
              <span className="list-summary-meta">{tp('integrations.paused.count', paused)}</span>
            )}
          </div>
          {list.data?.truncated && <Notice>{t('integrations.truncated')}</Notice>}
          <div className="integration-list">
            {integrations.map((integration) => (
              <IntegrationCard key={integration.id} orgId={orgId ?? ''} integration={integration} />
            ))}
          </div>
        </section>
      )}
      <p className="roadmap-line">{t('integrations.roadmap')}</p>
    </>
  );
}
