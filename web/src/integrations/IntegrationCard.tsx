import { Link } from '@tanstack/react-router';
import { IconFolderCode, IconChevronRight, IconSend } from '@tabler/icons-react';
import type { Integration } from '../lib/api';
import { t } from '../i18n';
import { CredentialsNotice } from './CredentialsNotice';
import { DESTINATIONS } from './destinations';
import { HealthNotice } from './HealthNotice';
import { EnabledSwitch } from './EnabledSwitch';
import { EventList } from './EventList';
import { useLocale } from '../i18n/LocaleProvider';
import { TestSend } from './test/TestSend';

const EVENTS_SHOWN = 4;

export function destinationLabel(integration: Integration): string {
  const destination = t(DESTINATIONS[integration.destination].name);
  return integration.destinationHost
    ? t('integration.destinationValue', { destination, host: integration.destinationHost })
    : t('integration.destinationNoHost', { destination });
}

interface IntegrationCardProps {
  readonly orgId: string;
  readonly integration: Integration;
}

/** One integration as an opaque work sheet: what it watches, where it sends, and its state. */
export function IntegrationCard({ orgId, integration }: IntegrationCardProps) {
  useLocale();
  const headingId = 'integration-' + integration.id;
  return (
    <article
      className={integration.enabled ? 'integration-card' : 'integration-card integration-card-paused'}
      aria-labelledby={headingId}
    >
      <header className="integration-card-head">
        <h3 id={headingId} className="integration-name" title={integration.name}>
          {integration.name}
        </h3>
        <Link
          to="/integrations/$id"
          params={{ id: integration.id }}
          className="btn btn-outline integration-manage"
          aria-label={t('integration.manageLabel', { name: integration.name })}
        >
          {t('integration.manage')}
          <IconChevronRight size={18} aria-hidden="true" />
        </Link>
      </header>
      <dl className="integration-facts">
        <div>
          <dt>
            <IconFolderCode size={18} aria-hidden="true" />
            {t(integration.sourceId ? 'integration.source' : 'integration.repo')}
          </dt>
          {integration.sourceId ? (
            <dd>
              <Link to="/sources" className="text-link">
                {t('integration.source.value')}
              </Link>
            </dd>
          ) : (
            <dd className="mono-wrap" title={integration.repo}>
              {integration.repo}
            </dd>
          )}
        </div>
        <div>
          <dt>
            <IconSend size={18} aria-hidden="true" />
            {t('integration.destination')}
          </dt>
          <dd>{destinationLabel(integration)}</dd>
        </div>
        <div className="integration-facts-wide">
          <dt>{t('integration.events')}</dt>
          <dd>
            {integration.sourceId ? (
              t('settings.details.source')
            ) : (
              <EventList eventTypes={integration.eventTypes} limit={EVENTS_SHOWN} />
            )}
          </dd>
        </div>
      </dl>
      <CredentialsNotice integration={integration} />
      <HealthNotice integration={integration} />
      <footer className="integration-card-foot">
        <EnabledSwitch orgId={orgId} integration={integration} />
        <TestSend orgId={orgId} integration={integration} variant="compact" />
      </footer>
    </article>
  );
}
