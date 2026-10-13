import { useEffect, type ReactNode } from 'react';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { IconArrowLeft, IconRefresh } from '@tabler/icons-react';
import { PageHeader } from '../../components/PageHeader';
import { Button, Notice } from '../../components/ui';
import { t } from '../../i18n';
import { DESTINATIONS } from '../destinations';
import { EnabledSwitch } from '../EnabledSwitch';
import { describeError, isNotFound } from '../errors';
import { useIntegration, useOrgId } from '../hooks';
import { destinationLabel } from '../IntegrationCard';
import { CredentialsSection } from './CredentialsSection';
import { DeleteDialog } from './DeleteDialog';
import { DetailsForm } from './DetailsForm';
import { FiltersSection } from './FiltersSection';
import { NoiseSection } from '../noise/NoiseSection';
import '../integrations.css';
import { useLocale } from '../../i18n/LocaleProvider';

function BackLink() {
  useLocale();
  return (
    <Link to="/integrations" className="text-link back-link">
      <IconArrowLeft size={18} aria-hidden="true" />
      {t('settings.back')}
    </Link>
  );
}

function Section({
  id,
  title,
  children,
  tone,
}: {
  id: string;
  title: string;
  children: ReactNode;
  tone?: 'danger';
}) {
  useLocale();
  return (
    <section
      id={id}
      className={tone ? `settings-section settings-section-${tone}` : 'settings-section'}
      aria-labelledby={id + '-title'}
    >
      <h2 id={id + '-title'}>{title}</h2>
      {children}
    </section>
  );
}

/**
 * One screen per integration with a stable section order (F217): status, repository and
 * updates, filters, quiet hours and summaries, destination and webhook URL, then delete. Each section saves on its own.
 */
export function IntegrationSettings() {
  useLocale();
  const { id = '' } = useParams({ strict: false });
  const { created } = useSearch({ strict: false });
  const orgId = useOrgId();
  const query = useIntegration(orgId, id);
  const loaded = query.data !== undefined;

  // `#credentials` links (from a credential warning) target a section rendered after load.
  useEffect(() => {
    const target =
      loaded && window.location.hash ? document.getElementById(window.location.hash.slice(1)) : null;
    target?.scrollIntoView({ block: 'start' });
  }, [loaded]);

  if (query.isPending)
    return (
      <>
        <PageHeader before={<BackLink />} eyebrow={t('settings.eyebrow')} title={t('settings.loading')} />
        <div className="integration-card skeleton-card" aria-busy="true" aria-label={t('settings.loading')}>
          <span className="skeleton skeleton-title" aria-hidden="true" />
          <span className="skeleton skeleton-line" aria-hidden="true" />
        </div>
      </>
    );

  if (query.isError && !query.data) {
    const notFound = isNotFound(query.error);
    const error = describeError(query.error);
    return (
      <>
        <PageHeader
          before={<BackLink />}
          eyebrow={t('settings.eyebrow')}
          title={notFound ? t('settings.notFound.title') : t('integrations.error.title')}
        />
        <Notice kind="error">
          <p>{notFound ? t('settings.notFound.body') : error.message}</p>
          {!notFound && (
            <Button variant="outline" onClick={() => void query.refetch()}>
              <IconRefresh size={18} aria-hidden="true" />
              {t('integrations.retry')}
            </Button>
          )}
        </Notice>
      </>
    );
  }

  const integration = query.data;
  if (!orgId || !integration) return null;
  const destination = t(DESTINATIONS[integration.destination].name);

  return (
    <>
      <PageHeader
        before={<BackLink />}
        eyebrow={t('settings.eyebrow')}
        title={integration.name}
        description={
          <>
            <span className="mono-wrap">
              {integration.sourceId ? t('integration.source.value') : integration.repo}
            </span>{' '}
            → {destinationLabel(integration)}
          </>
        }
      />
      {created === true && (
        <Notice kind="success">{t('settings.created', { name: integration.name })}</Notice>
      )}
      <div className="settings">
        <Section id="status" title={t('settings.status.title')}>
          <EnabledSwitch orgId={orgId} integration={integration} />
          <p className="field-hint">
            {!integration.enabled
              ? t('settings.status.off')
              : integration.credentials === 'quarantined'
                ? t('settings.status.onBlocked')
                : t('settings.status.on', { destination })}
          </p>
        </Section>
        <Section id="details" title={t('settings.details.title')}>
          {integration.sourceId ? (
            <p>{t('settings.details.source')}</p>
          ) : (
            <DetailsForm key={integration.id} orgId={orgId} integration={integration} />
          )}
        </Section>
        <Section id="filters" title={t('filters.title')}>
          <FiltersSection orgId={orgId} integration={integration} />
        </Section>
        <Section id="noise" title={t('noise.title')}>
          <NoiseSection key={integration.id} orgId={orgId} integration={integration} />
        </Section>
        <Section id="credentials" title={t('settings.credentials.title')}>
          <CredentialsSection orgId={orgId} integration={integration} />
        </Section>
        <Section id="delete" title={t('settings.danger.title')} tone="danger">
          <p>{t('settings.danger.body')}</p>
          <DeleteDialog orgId={orgId} integration={integration} />
        </Section>
      </div>
    </>
  );
}
