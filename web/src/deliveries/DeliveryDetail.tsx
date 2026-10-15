import type { RefObject } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Link } from '@tanstack/react-router';
import { IconX } from '@tabler/icons-react';
import { Button, Notice } from '../components/ui';
import { t } from '../i18n';
import type { DeliveryItem } from './api';
import { AttemptTimeline } from './AttemptTimeline';
import { STATE_LABEL, STATE_MEANING, describeDeliveryError, destinationName, failureCopy } from './copy';
import { useDeliveryDetail } from './hooks';
import { RedeliverPanel } from './RedeliverPanel';
import { StateChip } from './StateChip';
import { Time, absoluteTime } from './Time';
import { useLocale } from '../i18n/LocaleProvider';

interface DeliveryDetailProps {
  readonly orgId: string;
  readonly id: string;
  /** The row already on screen, shown while the detail request is in flight. */
  readonly initial: DeliveryItem | null;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onShowNew: (id: string) => void;
}

function Explanation({ delivery }: { readonly delivery: DeliveryItem }) {
  useLocale();
  const { error } = delivery;
  if (delivery.state !== 'dead_lettered' && delivery.state !== 'retrying') return null;
  const copy = error ? failureCopy(error, delivery.integration.destination) : null;
  return (
    <section className="detail-section" aria-labelledby="detail-what">
      <h3 id="detail-what">{t('delivery.detail.whatHappened')}</h3>
      <p>{copy ?? t('delivery.detail.noMessage')}</p>
      {delivery.pausedReason && <p>{t(`delivery.detail.paused.${delivery.pausedReason}`)}</p>}
      {delivery.state === 'retrying' && delivery.nextAttemptAt && (
        <p>{t('delivery.detail.nextRetry', { time: absoluteTime(delivery.nextAttemptAt) })}</p>
      )}
      {delivery.state === 'dead_lettered' && error && (
        <p className="muted">
          {error.retryable ? t('delivery.detail.retryable') : t('delivery.detail.permanent')}
        </p>
      )}
      {delivery.state === 'dead_lettered' && error?.userActionable && delivery.integrationExists && (
        <p>
          <Link to="/integrations/$id" params={{ id: delivery.integration.id }} className="text-link">
            {t('delivery.detail.fixLink')}
          </Link>
        </p>
      )}
    </section>
  );
}

/** F185: say plainly when a duplicate was detected and not sent, or was possible and undetectable. */
function Duplicates({
  delivery,
  onShowNew,
}: {
  readonly delivery: DeliveryItem;
  readonly onShowNew: (id: string) => void;
}) {
  useLocale();
  const { suppression } = delivery;
  if (!suppression && !delivery.possibleDuplicate) return null;
  return (
    <section className="detail-section" aria-labelledby="detail-duplicates">
      <h3 id="detail-duplicates">
        {suppression ? t('delivery.detail.suppressed.title') : t('delivery.detail.possibleDuplicate.title')}
      </h3>
      {suppression ? (
        <>
          <p>{t(`delivery.detail.suppressed.${suppression.reason}`)}</p>
          {suppression.originalState === 'dead_lettered' && (
            <p>{t('delivery.detail.suppressed.originalFailed')}</p>
          )}
          {suppression.duplicateOf && (
            <>
              <p className="mono-wrap muted">
                {t('delivery.detail.suppressed.of', { id: suppression.duplicateOf })}
              </p>
              <button
                type="button"
                className="text-link"
                onClick={() => onShowNew(suppression.duplicateOf ?? '')}
              >
                {t('delivery.detail.suppressed.open')}
              </button>
            </>
          )}
        </>
      ) : (
        <p>{t('delivery.detail.possibleDuplicate.body')}</p>
      )}
    </section>
  );
}

function Facts({ delivery }: { readonly delivery: DeliveryItem }) {
  useLocale();
  return (
    <section className="detail-section" aria-labelledby="detail-facts">
      <h3 id="detail-facts">{t('delivery.detail.facts')}</h3>
      <dl className="facts">
        <div>
          <dt>{t('delivery.detail.destination')}</dt>
          <dd>
            {destinationName(delivery.integration.destination)}
            {delivery.integration.destinationHost ? ` · ${delivery.integration.destinationHost}` : ''}
          </dd>
        </div>
        {delivery.integration.credentialFingerprint && (
          <div>
            <dt>{t('delivery.detail.fingerprint')}</dt>
            <dd className="mono-wrap">{delivery.integration.credentialFingerprint}</dd>
          </div>
        )}
        <div>
          <dt>{t('delivery.detail.attempts')}</dt>
          <dd>{delivery.attempts}</dd>
        </div>
        {delivery.createdAt && (
          <div>
            <dt>{t('delivery.detail.created')}</dt>
            <dd>
              <Time iso={delivery.createdAt} />
            </dd>
          </div>
        )}
        <div>
          <dt>{t('delivery.detail.updated')}</dt>
          <dd>
            <Time iso={delivery.updatedAt} />
          </dd>
        </div>
        {delivery.replayOf && (
          <div>
            <dt>{t('delivery.detail.replayOf')}</dt>
            <dd className="mono-wrap">{delivery.replayOf}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

export function DeliveryDetail({ orgId, id, initial, returnFocus, onClose, onShowNew }: DeliveryDetailProps) {
  useLocale();
  const query = useDeliveryDetail(orgId, id);
  const delivery = query.data?.delivery ?? initial;
  const name = delivery
    ? delivery.integrationExists
      ? delivery.integration.name
      : t('deliveries.integrationDeleted')
    : '';
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-backdrop" />
        <Dialog.Popup className="drawer" finalFocus={returnFocus}>
          <div className="drawer-head">
            <Dialog.Title className="drawer-title">{t('delivery.detail.title', { name })}</Dialog.Title>
            <Dialog.Close
              render={
                <Button
                  variant="ghost"
                  type="button"
                  aria-label={t('delivery.detail.close')}
                  className="drawer-close"
                />
              }
            >
              <IconX size={20} aria-hidden="true" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="drawer-model">{t('deliveries.model')}</Dialog.Description>
          {query.isError && !delivery && (
            <Notice kind="error">
              <p>{describeDeliveryError(query.error).message}</p>
            </Notice>
          )}
          {!delivery && query.isPending && <p className="muted">{t('delivery.detail.loading')}</p>}
          {delivery && (
            <>
              <section className="detail-section" aria-label={t(STATE_LABEL[delivery.state])}>
                <StateChip state={delivery.state} />
                <p>{t(STATE_MEANING[delivery.state])}</p>
              </section>
              <Explanation delivery={delivery} />
              <Duplicates delivery={delivery} onShowNew={onShowNew} />
              <Facts delivery={delivery} />
              <section className="detail-section" aria-labelledby="detail-timeline">
                <h3 id="detail-timeline">
                  {query.data?.attemptDetail === 'full' ? t('attempts.title') : t('delivery.detail.timeline')}
                </h3>
                {query.isError && <p className="muted">{t('delivery.detail.error')}</p>}
                {query.data?.attemptDetail === 'full' && (
                  <>
                    <AttemptTimeline
                      attempts={query.data.attempts}
                      destination={delivery.integration.destination}
                    />
                    <p className="muted small">{t('attempts.note')}</p>
                  </>
                )}
                {query.data && query.data.attemptDetail !== 'full' && (
                  <p className="muted">{t('attempts.empty')}</p>
                )}
                {query.data && query.data.attemptDetail !== 'full' && (
                  <ol className="timeline">
                    {query.data.timeline.map((entry) => (
                      <li key={entry.kind}>
                        <span>{t(`delivery.timeline.${entry.kind}`)}</span>
                        <Time iso={entry.at} />
                      </li>
                    ))}
                  </ol>
                )}
                {query.data && query.data.attemptDetail !== 'full' && (
                  <p className="muted small">{t('delivery.detail.timeline.note')}</p>
                )}
              </section>
              <section className="detail-section" aria-labelledby="detail-replays">
                <h3 id="detail-replays">{t('delivery.detail.replays')}</h3>
                {query.data && query.data.replays.length === 0 && (
                  <p className="muted">{t('delivery.detail.replays.none')}</p>
                )}
                {query.data && query.data.replays.length > 0 && (
                  <ul className="replay-list">
                    {query.data.replays.map((r) => (
                      <li key={r.id}>
                        <button type="button" className="text-link" onClick={() => onShowNew(r.id)}>
                          {t(STATE_LABEL[r.state])}
                          {r.createdAt ? ' · ' + absoluteTime(r.createdAt) : ''}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <RedeliverPanel orgId={orgId} delivery={delivery} onShowNew={onShowNew} />
              <details className="support-details">
                <summary>{t('delivery.detail.support')}</summary>
                <dl className="facts">
                  <div>
                    <dt>{t('delivery.detail.supportId')}</dt>
                    <dd className="mono-wrap">{delivery.id}</dd>
                  </div>
                  {delivery.error && (
                    <div>
                      <dt>{t('delivery.detail.supportCode')}</dt>
                      <dd className="mono-wrap">{delivery.error.code}</dd>
                    </div>
                  )}
                </dl>
              </details>
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
