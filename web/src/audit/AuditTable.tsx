import { IconCircleCheck, IconShieldX } from '@tabler/icons-react';
import { Button } from '../components/ui';
import { t } from '../i18n';
import { useLocale } from '../i18n/LocaleProvider';
import { Time } from '../deliveries/Time';
import { isAuditSubjectType, type AuditEvent } from './api';
import { actionLabel, actorLabel, changePairs, detailPairs, outcomeLabel, subjectTypeLabel } from './copy';
import type { AuditSearch } from './search';

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

function Pairs({ pairs }: { readonly pairs: readonly { label: string; text: string }[] }) {
  useLocale();
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

interface DetailsProps {
  readonly event: AuditEvent;
  readonly onFilter: (patch: AuditSearch) => void;
}

/** The recorded facts, then what an update changed, then the request it was made in. */
function Details({ event, onFilter }: DetailsProps) {
  useLocale();
  const pairs = detailPairs(event);
  const changes = changePairs(event);
  if (pairs.length === 0 && changes.length === 0 && event.correlationId === null)
    return <span className="cell-sub">{t('audit.noDetails')}</span>;
  return (
    <div className="audit-detail-stack">
      {pairs.length > 0 && <Pairs pairs={pairs} />}
      {changes.length > 0 && (
        <section className="audit-changes" aria-label={t('audit.changes.heading')}>
          <p className="audit-changes-title">{t('audit.changes.heading')}</p>
          <Pairs pairs={changes} />
        </section>
      )}
      {event.correlationId !== null && (
        <div className="audit-request">
          <span className="cell-sub">
            {t('audit.detail.requestId')}: <code>{event.correlationId}</code>
          </span>
          <Button
            variant="ghost"
            type="button"
            onClick={() => onFilter({ correlationId: event.correlationId ?? '' })}
          >
            {t('audit.showRequest')}
          </Button>
        </div>
      )}
    </div>
  );
}

interface AuditTableProps {
  readonly rows: readonly AuditEvent[];
  /** Replace the filters with this one, so "events about this" and "this request" are one click. */
  readonly onFilter: (patch: AuditSearch) => void;
}

/**
 * Explicit ARIA roles on a div-less table: the narrow layout turns rows into stacked cards with
 * CSS `display`, which would otherwise drop table semantics in some browsers.
 */
export function AuditTable({ rows, onFilter }: AuditTableProps) {
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
                  {event.subjectId && (
                    <Button
                      variant="ghost"
                      type="button"
                      aria-label={t('audit.showAbout.label', {
                        subject: `${subjectTypeLabel(event.subjectType)} ${event.subjectId}`,
                      })}
                      onClick={() =>
                        onFilter({
                          target: event.subjectId ?? '',
                          ...(isAuditSubjectType(event.subjectType) ? { targetType: event.subjectType } : {}),
                        })
                      }
                    >
                      {t('audit.showAbout')}
                    </Button>
                  )}
                </div>
              </td>
              <td role="cell" data-label={t('audit.col.result')}>
                <Outcome outcome={event.outcome} />
              </td>
              <td role="cell" data-label={t('audit.col.details')}>
                <Details event={event} onFilter={onFilter} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
