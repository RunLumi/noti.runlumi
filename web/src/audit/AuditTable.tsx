import { IconCircleCheck, IconShieldX } from '@tabler/icons-react';
import { t } from '../i18n';
import { useLocale } from '../i18n/LocaleProvider';
import { Time } from '../deliveries/Time';
import type { AuditEvent } from './api';
import { actionLabel, actorLabel, detailPairs, outcomeLabel, subjectTypeLabel } from './copy';

function Outcome({ outcome }: { readonly outcome: AuditEvent['outcome'] }) {
  useLocale();
  const denied = outcome === 'denied';
  const Icon = denied ? IconShieldX : IconCircleCheck;
  // A word and an icon, never colour alone.
  return (
    <span className={`badge state-chip badge-${denied ? 'danger' : 'success'}`}>
      <Icon size={14} aria-hidden={true} />
      {outcomeLabel(outcome)}
    </span>
  );
}

function Details({ event }: { readonly event: AuditEvent }) {
  useLocale();
  const pairs = detailPairs(event);
  if (pairs.length === 0) return <span className="cell-sub">{t('audit.noDetails')}</span>;
  return (
    <dl className="audit-details">
      {pairs.map((p) => (
        <div key={p.label}>
          <dt>{p.label}</dt>
          <dd>{p.text}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Explicit ARIA roles on a div-less table: the narrow layout turns rows into stacked cards with
 * CSS `display`, which would otherwise drop table semantics in some browsers.
 */
export function AuditTable({ rows }: { readonly rows: readonly AuditEvent[] }) {
  useLocale();
  return (
    <div className="table-wrap card delivery-table-wrap">
      <table className="delivery-table audit-table" role="table" aria-label={t('audit.tableLabel')}>
        <thead role="rowgroup">
          <tr role="row">
            <th role="columnheader" scope="col">
              {t('audit.col.when')}
            </th>
            <th role="columnheader" scope="col">
              {t('audit.col.what')}
            </th>
            <th role="columnheader" scope="col">
              {t('audit.col.who')}
            </th>
            <th role="columnheader" scope="col">
              {t('audit.col.subject')}
            </th>
            <th role="columnheader" scope="col">
              {t('audit.col.result')}
            </th>
            <th role="columnheader" scope="col">
              {t('audit.col.details')}
            </th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((event) => (
            <tr key={event.id} role="row">
              <td role="cell" data-label={t('audit.col.when')}>
                <Time iso={event.createdAt} />
              </td>
              <td role="cell" data-label={t('audit.col.what')}>
                <span className="cell-main">{actionLabel(event.action)}</span>
              </td>
              <td role="cell" data-label={t('audit.col.who')}>
                <span className="cell-main">{actorLabel(event.actor)}</span>
              </td>
              <td role="cell" data-label={t('audit.col.subject')}>
                <div>
                  <span className="cell-main">{subjectTypeLabel(event.subjectType)}</span>
                  {event.subjectId && <span className="cell-sub">{event.subjectId}</span>}
                </div>
              </td>
              <td role="cell" data-label={t('audit.col.result')}>
                <Outcome outcome={event.outcome} />
              </td>
              <td role="cell" data-label={t('audit.col.details')}>
                <Details event={event} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
