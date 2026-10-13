import { Badge, Button, Notice } from '../../components/ui';
import { t } from '../../i18n';
import type { RoutingLogEntry } from '../../lib/api';
import { EVENT_LABEL, isGithubEventType } from '../events';
import { useRoutingLog } from './hooks';
import { describeDecision } from './model';

const WHEN = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

function Entry({ entry }: { entry: RoutingLogEntry }) {
  const sent = entry.outcome === 'delivered';
  const event = isGithubEventType(entry.eventType) ? t(EVENT_LABEL[entry.eventType]) : entry.eventType;
  const when = WHEN.format(new Date(entry.decidedAt));
  return (
    <li className="routing-log-entry">
      <Badge variant={sent ? 'success' : 'warning'}>
        {t(sent ? 'filters.log.sent' : 'filters.log.skipped')}
      </Badge>
      <div className="routing-log-body">
        <p className="routing-log-event">{event}</p>
        <p className="routing-log-reason">
          {describeDecision({
            pass: sent,
            unknown: entry.unknownFact,
            filterId: entry.filterId,
            reason: entry.reason,
          })}
        </p>
      </div>
      <time className="routing-log-time" dateTime={entry.decidedAt}>
        {when}
      </time>
    </li>
  );
}

/**
 * Why updates were sent or held back, newest first (provenance, F137). It shows the event type
 * and a reason, never the content of an event, because Noti does not keep it.
 */
export function RoutingLog({ orgId, integrationId }: { orgId: string; integrationId: string }) {
  const log = useRoutingLog(orgId, integrationId);
  const entries = log.data?.pages.flatMap((p) => p.entries) ?? [];
  return (
    <section className="routing-log" aria-labelledby="routing-log-title">
      <h3 id="routing-log-title">{t('filters.log.title')}</h3>
      <p className="field-hint">{t('filters.log.intro')}</p>
      {log.isPending ? (
        <p role="status">{t('filters.log.loading')}</p>
      ) : log.isError ? (
        <Notice kind="error">
          <p>{t('filters.log.error')}</p>
          <Button variant="outline" onClick={() => void log.refetch()}>
            {t('integrations.retry')}
          </Button>
        </Notice>
      ) : entries.length === 0 ? (
        <p>{t('filters.log.empty')}</p>
      ) : (
        <>
          <ul className="routing-log-list">
            {entries.map((entry) => (
              <Entry key={entry.id} entry={entry} />
            ))}
          </ul>
          {log.hasNextPage && (
            <Button
              variant="outline"
              aria-disabled={log.isFetchingNextPage || undefined}
              onClick={() => void log.fetchNextPage()}
            >
              {t('filters.log.more')}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
