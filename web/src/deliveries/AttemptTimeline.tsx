import { t, tp } from '../i18n';
import { useLocale } from '../i18n/LocaleProvider';
import type { MessageId } from '../i18n/messages.en';
import type { AttemptItem, DeliveryItem } from './api';
import { failureCopy } from './copy';
import { Time, absoluteTime } from './Time';

const REASON_COPY: Readonly<Record<string, MessageId>> = {
  circuit_open: 'attempts.reason.circuit_open',
  destination_paced: 'attempts.reason.destination_paced',
  circuit_open_timeout: 'attempts.reason.circuit_open_timeout',
  destination_paced_timeout: 'attempts.reason.destination_paced_timeout',
  claim_expired: 'attempts.reason.claim_expired',
};

interface AttemptTimelineProps {
  readonly attempts: readonly AttemptItem[];
  readonly destination: DeliveryItem['integration']['destination'];
}

/**
 * Every try, oldest first (F181, F184). Each line says what happened in words, with the status
 * CLASS as a sentence and a short minted code for support. Nothing the destination answered is
 * shown, because the server never sends it. Outcome is text, never colour alone.
 */
export function AttemptTimeline({ attempts, destination }: AttemptTimelineProps) {
  useLocale();
  return (
    <ol className="attempt-list" aria-label={t('attempts.list')}>
      {attempts.map((a, index) => {
        const waited = a.outcome === 'deferred';
        const stopped = a.outcome === 'dead_lettered' && a.detail?.endsWith('_timeout') === true;
        const reason = a.detail ? REASON_COPY[a.detail] : undefined;
        const failure = a.error && !waited ? failureCopy(a.error, destination) : null;
        return (
          <li key={`${a.attempt}-${a.startedAt}-${index}`} className={`attempt attempt-${a.outcome}`}>
            <div className="attempt-head">
              <span className="attempt-title">
                {stopped
                  ? t('attempts.stoppedWaiting')
                  : waited
                    ? a.repeatCount > 0
                      ? tp('attempts.waitedTimes', a.repeatCount)
                      : t('attempts.waited')
                    : t('attempts.item', { number: a.attempt })}
              </span>
              <span className="badge badge-neutral attempt-outcome">
                {t(`attempts.outcome.${a.outcome}`)}
              </span>
              <span className="attempt-time" title={absoluteTime(a.startedAt)}>
                <Time iso={a.startedAt} />
              </span>
            </div>
            <p className="attempt-line">
              {reason ? t(reason) : t(`attempts.statusClass.${a.statusClass}`)}
              {!waited && a.statusClass !== 'none'
                ? ` · ${t('attempts.duration', { ms: a.durationMs })}`
                : ''}
            </p>
            {failure && <p className="attempt-line muted">{failure}</p>}
            {a.retryAfterSeconds !== null && !waited && (
              <p className="attempt-line muted">
                {t('attempts.retryAfter', { seconds: a.retryAfterSeconds })}
              </p>
            )}
            {a.possibleDuplicate && <p className="attempt-line">{t('attempts.possibleDuplicate')}</p>}
            {a.detail && !reason && (
              <p className="attempt-code mono-wrap">{t('attempts.code', { code: a.detail })}</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
