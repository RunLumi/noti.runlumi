import type { ComponentType } from 'react';
import { Link } from '@tanstack/react-router';
import {
  IconCircleCheck,
  IconGauge,
  IconHeartbeat,
  IconMinus,
  IconPlayerPause,
  IconPlus,
  IconRefresh,
  IconSearch,
} from '@tabler/icons-react';
import { PageHeader } from '../components/PageHeader';
import { EmptyState, Skeleton } from '../components/state';
import { Button, Notice } from '../components/ui';
import { absoluteTime } from '../deliveries/Time';
import { t, tp, type MessageId } from '../i18n';
import { DESTINATIONS } from '../integrations/destinations';
import { describeError } from '../integrations/errors';
import { useIntegrations, useOrgId } from '../integrations/hooks';
import '../integrations/integrations.css';
import '../deliveries/deliveries.css';
import './destinations.css';
import { useLocale } from '../i18n/LocaleProvider';
import { destinationRow, type CredentialHealth, type DestinationRow, type Sending } from './health';

type Tone = 'success' | 'neutral' | 'warning' | 'danger';
type Icon = ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;

/** Each state has its own word and its own shape; colour is never the only signal (WCAG 1.4.1). */
const SENDING: Readonly<Record<Sending | 'none', { label: MessageId; icon: Icon; tone: Tone }>> = {
  closed: { label: 'destinations.sending.closed', icon: IconCircleCheck, tone: 'success' },
  open: { label: 'destinations.sending.open', icon: IconPlayerPause, tone: 'warning' },
  half_open: { label: 'destinations.sending.halfOpen', icon: IconSearch, tone: 'warning' },
  none: { label: 'destinations.notReported', icon: IconMinus, tone: 'neutral' },
};

const CREDENTIALS: Readonly<Record<CredentialHealth, { label: MessageId; tone: Tone }>> = {
  ok: { label: 'destinations.credentials.ok', tone: 'neutral' },
  legacy: { label: 'destinations.credentials.legacy', tone: 'warning' },
  quarantined: { label: 'destinations.credentials.quarantined', tone: 'danger' },
  revoked: { label: 'destinations.credentials.revoked', tone: 'danger' },
};

function SendingCell({ row }: { readonly row: DestinationRow }) {
  useLocale();
  const { label, icon: StateIcon, tone } = SENDING[row.sending ?? 'none'];
  return (
    <>
      <span className={`badge state-chip badge-${tone}`}>
        <StateIcon size={14} aria-hidden={true} />
        {t(label)}
      </span>
      {row.retryAt && (
        <span className="cell-sub">
          {t('destinations.sending.openUntil', { time: absoluteTime(row.retryAt) })}
        </span>
      )}
      {row.pacedUntil && (
        <span className="cell-sub">
          <IconGauge size={14} aria-hidden="true" />{' '}
          {t('destinations.sending.paced', { time: absoluteTime(row.pacedUntil) })}
        </span>
      )}
      {row.timesOpened !== null && row.timesOpened > 0 && (
        <span className="cell-sub">{tp('destinations.timesOpened', row.timesOpened)}</span>
      )}
    </>
  );
}

function DestinationsTable({ rows }: { readonly rows: readonly DestinationRow[] }) {
  useLocale();
  const cols = {
    integration: t('destinations.col.integration'),
    destination: t('destinations.col.destination'),
    switch: t('destinations.col.switch'),
    sending: t('destinations.col.sending'),
    failures: t('destinations.col.failures'),
    credentials: t('destinations.col.credentials'),
  };
  return (
    <div className="table-wrap card delivery-table-wrap">
      {/* Explicit roles: the narrow layout stacks rows with CSS `display`, which drops table semantics in some browsers. */}
      <table className="delivery-table" role="table" aria-label={t('destinations.tableLabel')}>
        <thead role="rowgroup">
          <tr role="row">
            {Object.values(cols).map((name) => (
              <th key={name} role="columnheader" scope="col">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((row) => {
            const { integration } = row;
            const credentials = CREDENTIALS[row.credentials];
            return (
              <tr key={integration.id} role="row">
                <td role="cell" data-label={cols.integration}>
                  <Link
                    to="/integrations/$id"
                    params={{ id: integration.id }}
                    className="text-link cell-main destination-link"
                  >
                    {integration.name}
                  </Link>
                  <span className="cell-sub">
                    {integration.sourceId ? t('integration.source.value') : integration.repo}
                  </span>
                </td>
                <td role="cell" data-label={cols.destination}>
                  <span className="cell-main">{t(DESTINATIONS[integration.destination].name)}</span>
                  {integration.destinationHost && (
                    <span className="cell-sub">{integration.destinationHost}</span>
                  )}
                </td>
                <td role="cell" data-label={cols.switch}>
                  {integration.enabled ? t('destinations.switch.on') : t('destinations.switch.off')}
                </td>
                <td role="cell" data-label={cols.sending}>
                  <SendingCell row={row} />
                </td>
                <td role="cell" data-label={cols.failures}>
                  {row.consecutiveFailures === null ? (
                    <span className="muted">{t('destinations.notReported')}</span>
                  ) : (
                    row.consecutiveFailures
                  )}
                </td>
                <td role="cell" data-label={cols.credentials}>
                  {credentials.tone === 'neutral' ? (
                    t(credentials.label)
                  ) : (
                    <span className={`badge badge-${credentials.tone}`}>{t(credentials.label)}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * `/destinations` (spec 14 F205, "Is it working?"): every integration's destination, its switch, the
 * delivery circuit breaker and pacing hold, and its webhook URL state, exactly as
 * `GET /api/integrations` reports them (ADR 0056). No new metric is computed here: where the server
 * sends no health record the page says "Not reported", and each row links to its integration, whose
 * settings page reads the recent deliveries.
 */
export function DestinationsHealthPage() {
  useLocale();
  const orgId = useOrgId();
  const list = useIntegrations(orgId);
  const rows = (list.data?.integrations ?? []).map(destinationRow);
  return (
    <>
      <PageHeader
        eyebrow={t('destinations.eyebrow')}
        title={t('destinations.title')}
        description={t('destinations.description')}
      />
      {list.isPending ? (
        <Skeleton label={t('destinations.loading')} rows={3} />
      ) : list.isError ? (
        // A failed query is an error, never an empty list (F225).
        <Notice kind="error">
          <p className="notice-title">{t('destinations.error.title')}</p>
          <p>
            {describeError(list.error).message} {t('integrations.error.body')}
          </p>
          <Button variant="outline" onClick={() => void list.refetch()} disabled={list.isFetching}>
            <IconRefresh size={18} aria-hidden="true" />
            {t('destinations.retry')}
          </Button>
        </Notice>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<IconHeartbeat size={24} aria-hidden="true" />}
          title={t('destinations.empty.title')}
          action={
            <Link to="/integrations/new" className="btn btn-primary">
              <IconPlus size={18} aria-hidden="true" />
              {t('integrations.empty.action')}
            </Link>
          }
        >
          <p>{t('destinations.empty.body')}</p>
        </EmptyState>
      ) : (
        <section aria-labelledby="destinations-count">
          <div className="list-summary">
            <h2 id="destinations-count">{tp('destinations.count', rows.length)}</h2>
          </div>
          {list.data?.truncated && <Notice>{t('integrations.truncated')}</Notice>}
          <DestinationsTable rows={rows} />
          <p className="field-hint destinations-note">{t('destinations.breakerNote')}</p>
          {rows.some((r) => r.sending === null) && (
            <p className="field-hint destinations-note">{t('destinations.notReported.note')}</p>
          )}
        </section>
      )}
    </>
  );
}
