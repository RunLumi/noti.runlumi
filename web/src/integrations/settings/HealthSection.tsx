import { Link } from '@tanstack/react-router';
import { Skeleton } from '../../components/state';
import { ErrorPanel } from '../../components/ErrorPanel';
import { Time } from '../../deliveries/Time';
import { failureCopy } from '../../deliveries/copy';
import type { DeliveryItem } from '../../deliveries/api';
import { t, tp } from '../../i18n';
import { useLocale } from '../../i18n/LocaleProvider';
import type { Integration } from '../../lib/api';
import { HealthNotice } from '../HealthNotice';
import { summariseHealth } from './repair';

interface HealthSectionProps {
  readonly integration: Integration;
  readonly deliveries: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly error: unknown;
    readonly refetch: () => void;
    readonly rows: readonly DeliveryItem[];
  };
}

/**
 * Real delivery history for this integration (F217 "Health"), read from the delivery ledger:
 * when something last got through, when something last failed and why, and the circuit
 * breaker's state. It says how many recent deliveries it looked at, so "no failure" never
 * means more than it knows.
 */
export function HealthSection({ integration, deliveries }: HealthSectionProps) {
  useLocale();
  if (deliveries.isPending) return <Skeleton label={t('deliveries.loading')} rows={1} />;
  if (deliveries.isError)
    return (
      <ErrorPanel error={deliveries.error} what="errorpanel.what.history" onRetry={deliveries.refetch} />
    );
  if (deliveries.rows.length === 0) return <p className="field-hint">{t('health.none')}</p>;
  const health = summariseHealth(deliveries.rows);
  const failure = health.lastFailed?.error
    ? failureCopy(health.lastFailed.error, integration.destination)
    : null;
  return (
    <div className="health-section">
      <dl className="settings-facts">
        <div>
          <dt>{t('health.lastDelivered')}</dt>
          <dd>
            {health.lastDelivered ? (
              <>
                <Time iso={health.lastDelivered.updatedAt} />
                {health.lastDelivered.isTest ? ` · ${t('delivery.testBadge')}` : ''}
                {health.lastDelivered.state === 'accepted' ? ` · ${t('health.acceptedOnly')}` : ''}
              </>
            ) : (
              t('health.noneDelivered')
            )}
          </dd>
        </div>
        <div>
          <dt>{t('health.lastFailed')}</dt>
          <dd>
            {health.lastFailed ? (
              <>
                <Time iso={health.lastFailed.updatedAt} />
                {failure ? <span className="health-reason"> {failure}</span> : null}
              </>
            ) : (
              t('health.noneFailed')
            )}
          </dd>
        </div>
      </dl>
      <p className="field-hint">{tp('health.basis', health.considered)}</p>
      <HealthNotice integration={integration} />
    </div>
  );
}

/** Links into the delivery log for this integration, including the failed view where redelivery lives. */
export function HistorySection({ integration }: { integration: Integration }) {
  useLocale();
  return (
    <div className="history-links">
      <p>{t('history.body')}</p>
      <ul className="history-list">
        <li>
          <Link to="/activity" search={{ integration: integration.id }} className="text-link">
            {t('history.all')}
          </Link>
        </li>
        <li>
          <Link
            to="/activity"
            search={{ integration: integration.id, state: 'dead_lettered' }}
            className="text-link"
          >
            {t('history.failed')}
          </Link>
        </li>
      </ul>
    </div>
  );
}
