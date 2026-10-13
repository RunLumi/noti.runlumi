import { Link } from '@tanstack/react-router';
import { Card } from '../components/ui';
import { t, tp } from '../i18n';
import { useOrgId } from '../integrations/hooks';
import './deliveries.css';
import { useDeliverySummary } from './hooks';

/**
 * The Overview's two delivery figures, read from `GET /api/deliveries/summary` (F206: no
 * number without a query). While loading or after a failure they show a dash and say so; a
 * zero is only ever a real count from the server.
 */
export function DeliveryStats() {
  const orgId = useOrgId();
  const summary = useDeliverySummary(orgId);
  const counts = summary.data;
  const busy = summary.isPending;
  const failed = summary.isError;
  return (
    <>
      <Card aria-busy={busy || undefined}>
        <span className="stat-label">{t('overview.delivered')}</span>
        <strong>{counts ? counts.sent : '—'}</strong>
        <small>
          {busy
            ? t('overview.stats.loading')
            : failed || !counts
              ? t('overview.stats.error')
              : counts.sent + counts.accepted === 0
                ? t('overview.delivered.none')
                : counts.accepted > 0
                  ? tp('overview.delivered.accepted', counts.accepted)
                  : t('overview.delivered.confirmed')}
        </small>
      </Card>
      <Card aria-busy={busy || undefined}>
        <span className="stat-label">{t('overview.failed')}</span>
        <strong>{counts ? counts.dead_lettered : '—'}</strong>
        <small>
          {busy ? (
            t('overview.stats.loading')
          ) : failed || !counts ? (
            t('overview.stats.error')
          ) : counts.dead_lettered > 0 ? (
            <Link to="/activity" search={{ state: 'dead_lettered' }} className="text-link">
              {t('overview.failed.view')}
            </Link>
          ) : (
            t('overview.failed.clear')
          )}
          {counts && counts.retrying > 0 && (
            <span className="stat-link"> · {tp('overview.failed.retrying', counts.retrying)}</span>
          )}
        </small>
      </Card>
    </>
  );
}
