import { useRef, type RefObject } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import type { UseQueryResult } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { IconExternalLink, IconX } from '@tabler/icons-react';
import { Button, Notice } from '../components/ui';
import { CopyButton } from '../sources/CopyButton';
import '../sources/sources.css';
import { t } from '../i18n';
import type { DeliveryDetail as DeliveryDetailData, DeliveryItem } from './api';
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

/**
 * Section headings sit one level under the title: `h3` under the dialog's `h2`, `h2` under the
 * delivery page's `h1` (ADR 0056), so the outline never skips a level in either place.
 */
type SectionHeading = 'h2' | 'h3';

function Explanation({ delivery, H }: { readonly delivery: DeliveryItem; readonly H: SectionHeading }) {
  useLocale();
  const { error } = delivery;
  if (delivery.state !== 'dead_lettered' && delivery.state !== 'retrying') return null;
  const copy = error ? failureCopy(error, delivery.integration.destination) : null;
  return (
    <section className="detail-section" aria-labelledby="detail-what">
      <H id="detail-what">{t('delivery.detail.whatHappened')}</H>
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
  H,
}: {
  readonly delivery: DeliveryItem;
  readonly onShowNew: (id: string) => void;
  readonly H: SectionHeading;
}) {
  useLocale();
  const { suppression } = delivery;
  if (!suppression && !delivery.possibleDuplicate) return null;
  return (
    <section className="detail-section" aria-labelledby="detail-duplicates">
      <H id="detail-duplicates">
        {suppression ? t('delivery.detail.suppressed.title') : t('delivery.detail.possibleDuplicate.title')}
      </H>
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

/**
 * The request id the sender got back as `x-request-id` (F11, F193). Monospace, copyable, and one
 * link to every delivery that request created, which is how a support reply finds the rest.
 */
function RequestId({
  delivery,
  onFollow,
}: {
  readonly delivery: DeliveryItem;
  readonly onFollow: () => void;
}) {
  useLocale();
  const id = delivery.correlationId;
  return (
    <div>
      <dt>{t('delivery.detail.requestId')}</dt>
      <dd>
        {id ? (
          <div className="request-id">
            <code className="mono-wrap">{id}</code>
            <CopyButton
              text={id}
              label="delivery.detail.requestId.copy"
              copied="delivery.detail.requestId.copied"
              failed="delivery.detail.requestId.copyFailed"
            />
            <Link to="/activity" search={{ correlationId: id }} className="text-link" onClick={onFollow}>
              {t('delivery.detail.requestId.show')}
            </Link>
          </div>
        ) : (
          <span className="muted">{t('delivery.detail.requestId.none')}</span>
        )}
      </dd>
    </div>
  );
}

function Facts({ delivery, H }: { readonly delivery: DeliveryItem; readonly H: SectionHeading }) {
  useLocale();
  return (
    <section className="detail-section" aria-labelledby="detail-facts">
      <H id="detail-facts">{t('delivery.detail.facts')}</H>
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

interface DeliveryDetailBodyProps {
  readonly orgId: string;
  readonly delivery: DeliveryItem;
  readonly query: UseQueryResult<DeliveryDetailData>;
  readonly heading: SectionHeading;
  readonly onShowNew: (id: string) => void;
  /** Called when "show every delivery from this request" is followed. */
  readonly onFollowRequest: () => void;
}

/**
 * Everything the detail says about one delivery. The dialog on Activity and the delivery's own
 * page (`/activity/:deliveryId`, ADR 0056) render this same body, so the two cannot drift apart.
 */
export function DeliveryDetailBody({
  orgId,
  delivery,
  query,
  heading: H,
  onShowNew,
  onFollowRequest,
}: DeliveryDetailBodyProps) {
  useLocale();
  return (
    <>
      <section className="detail-section" aria-label={t(STATE_LABEL[delivery.state])}>
        <StateChip state={delivery.state} />
        <p>{t(STATE_MEANING[delivery.state])}</p>
      </section>
      <Explanation delivery={delivery} H={H} />
      <Duplicates delivery={delivery} onShowNew={onShowNew} H={H} />
      <Facts delivery={delivery} H={H} />
      <section className="detail-section" aria-labelledby="detail-timeline">
        <H id="detail-timeline">
          {query.data?.attemptDetail === 'full' ? t('attempts.title') : t('delivery.detail.timeline')}
        </H>
        {query.isError && <p className="muted">{t('delivery.detail.error')}</p>}
        {query.data?.attemptDetail === 'full' && (
          <>
            <AttemptTimeline attempts={query.data.attempts} destination={delivery.integration.destination} />
            <p className="muted small">{t('attempts.note')}</p>
          </>
        )}
        {query.data && query.data.attemptDetail !== 'full' && <p className="muted">{t('attempts.empty')}</p>}
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
        <H id="detail-replays">{t('delivery.detail.replays')}</H>
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
      <RedeliverPanel orgId={orgId} delivery={delivery} onShowNew={onShowNew} heading={H} />
      <details className="support-details">
        <summary>{t('delivery.detail.support')}</summary>
        <dl className="facts">
          <div>
            <dt>{t('delivery.detail.supportId')}</dt>
            <dd className="mono-wrap">{delivery.id}</dd>
          </div>
          <RequestId delivery={delivery} onFollow={onFollowRequest} />
          {delivery.error && (
            <div>
              <dt>{t('delivery.detail.supportCode')}</dt>
              <dd className="mono-wrap">{delivery.error.code}</dd>
            </div>
          )}
        </dl>
      </details>
    </>
  );
}

/** The integration's name for a delivery's title, or "Deleted integration". */
export function deliveryName(delivery: DeliveryItem | null): string {
  if (!delivery) return '';
  return delivery.integrationExists ? delivery.integration.name : t('deliveries.integrationDeleted');
}

/**
 * The quick look from the Activity list. It keeps the list, its filters and the row focus returns
 * to. "Open as a page" inside it goes to the delivery's own address, for a bookmark or a support
 * reply (ADR 0056).
 */
export function DeliveryDetail({ orgId, id, initial, returnFocus, onClose, onShowNew }: DeliveryDetailProps) {
  useLocale();
  const query = useDeliveryDetail(orgId, id);
  const delivery = query.data?.delivery ?? initial;
  // After "show every delivery from this request" the list reloads and the row that opened this
  // dialog may be gone for a moment, so focus goes to the page heading instead (WCAG 2.4.3).
  const followedRequest = useRef(false);
  const finalFocus = (): HTMLElement | boolean => {
    if (!followedRequest.current) return returnFocus.current ?? true;
    const heading = document.querySelector<HTMLElement>('main h1');
    if (heading && !heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    return heading ?? true;
  };
  const name = deliveryName(delivery);
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-backdrop" />
        <Dialog.Popup className="drawer" finalFocus={finalFocus}>
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
          <p className="drawer-permalink">
            <Link
              to="/activity/$deliveryId"
              params={{ deliveryId: id }}
              className="text-link"
              aria-describedby="delivery-open-page-hint"
            >
              <IconExternalLink size={16} aria-hidden="true" />
              {t('delivery.detail.openPage')}
            </Link>
            <span id="delivery-open-page-hint" className="muted small">
              {t('delivery.detail.openPageHint')}
            </span>
          </p>
          {query.isError && !delivery && (
            <Notice kind="error">
              <p>{describeDeliveryError(query.error).message}</p>
            </Notice>
          )}
          {!delivery && query.isPending && <p className="muted">{t('delivery.detail.loading')}</p>}
          {delivery && (
            <DeliveryDetailBody
              orgId={orgId}
              delivery={delivery}
              query={query}
              heading="h3"
              onShowNew={onShowNew}
              onFollowRequest={() => {
                followedRequest.current = true;
                onClose();
              }}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
