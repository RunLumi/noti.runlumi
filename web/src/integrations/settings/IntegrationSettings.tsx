import { useEffect, type ReactNode } from 'react';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { IconArrowLeft } from '@tabler/icons-react';
import { PageHeader } from '../../components/PageHeader';
import { ErrorPanel } from '../../components/ErrorPanel';
import { Skeleton } from '../../components/state';
import { Notice } from '../../components/ui';
import { useDeliveryList } from '../../deliveries/hooks';
import { CapabilitySummary } from '../../setup/CapabilitySummary';
import { t } from '../../i18n';
import { DESTINATIONS } from '../destinations';
import { EnabledSwitch } from '../EnabledSwitch';
import { isNotFound } from '../errors';
import { useIntegration, useOrgId } from '../hooks';
import { destinationLabel } from '../IntegrationCard';
import { CredentialsSection } from './CredentialsSection';
import { DeleteDialog } from './DeleteDialog';
import { HealthSection, HistorySection } from './HealthSection';
import { RepairPanel } from './RepairPanel';
import { repairsFor } from './repair';
import { DetailsForm } from './DetailsForm';
import { FiltersSection } from './FiltersSection';
import { NoiseSection } from '../noise/NoiseSection';
import { TestSend } from '../test/TestSend';
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
 * One screen per integration with a stable section order (F217, ADR 0025): status (with the
 * repair panel when something needs fixing), source and updates, filters, destination (what it
 * can show, and the test), quiet hours and summaries, credentials, health, history, then delete.
 * Each section saves on its own. The section ids are anchors that repair links and credential
 * warnings point at.
 */
export function IntegrationSettings() {
  useLocale();
  const { id = '' } = useParams({ strict: false });
  const { created } = useSearch({ strict: false });
  const orgId = useOrgId();
  const query = useIntegration(orgId, id);
  const loaded = query.data !== undefined;
  // The newest deliveries speak for the present: the repair panel and the health section read them.
  const recent = useDeliveryList(orgId, { integrationId: id });
  const rows = recent.data?.pages.flatMap((page) => page.deliveries) ?? [];

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
        <Skeleton label={t('settings.loading')} rows={2} />
      </>
    );

  if (query.isError && !query.data) {
    const notFound = isNotFound(query.error);
    return (
      <>
        <PageHeader
          before={<BackLink />}
          eyebrow={t('settings.eyebrow')}
          title={notFound ? t('settings.notFound.title') : t('integrations.error.title')}
        />
        {notFound ? (
          <Notice kind="error">
            <p>{t('settings.notFound.body')}</p>
          </Notice>
        ) : (
          <ErrorPanel
            error={query.error}
            what="errorpanel.what.integration"
            onRetry={() => void query.refetch()}
          />
        )}
      </>
    );
  }

  const integration = query.data;
  if (!orgId || !integration) return null;
  const destination = t(DESTINATIONS[integration.destination].name);
  const repairs = repairsFor(integration, rows);

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
          <RepairPanel repairs={repairs} integrationId={integration.id} />
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
        <Section id="destination" title={t('settings.destination.title')}>
          <CapabilitySummary kind={integration.destination} />
        </Section>
        <Section id="test" title={t('test.title')}>
          <TestSend key={integration.id} orgId={orgId} integration={integration} />
        </Section>
        <Section id="noise" title={t('noise.title')}>
          <NoiseSection key={integration.id} orgId={orgId} integration={integration} />
        </Section>
        <Section id="credentials" title={t('settings.credentials.title')}>
          <CredentialsSection orgId={orgId} integration={integration} />
        </Section>
        <Section id="health" title={t('settings.health.title')}>
          <HealthSection
            integration={integration}
            deliveries={{
              isPending: recent.isPending,
              isError: recent.isError,
              error: recent.error,
              refetch: () => void recent.refetch(),
              rows,
            }}
          />
        </Section>
        <Section id="history" title={t('settings.history.title')}>
          <HistorySection integration={integration} />
        </Section>
        <Section id="delete" title={t('settings.danger.title')} tone="danger">
          <p>{t('settings.danger.body')}</p>
          <DeleteDialog orgId={orgId} integration={integration} />
        </Section>
      </div>
    </>
  );
}
