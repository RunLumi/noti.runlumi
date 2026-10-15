import { useEffect, useRef, useState } from 'react';
import { IconRepeat } from '@tabler/icons-react';
import { Button, Notice } from '../components/ui';
import { t } from '../i18n';
import type { DeliveryItem } from './api';
import { STATE_LABEL, describeDeliveryError, destinationName } from './copy';
import { useReplay } from './hooks';
import { useLocale } from '../i18n/LocaleProvider';

interface RedeliverPanelProps {
  readonly orgId: string;
  readonly delivery: DeliveryItem;
  /** Called with the new delivery's id so the log can open it. */
  readonly onShowNew: (id: string) => void;
  /** `h3` in the dialog, `h2` on the delivery's own page (ADR 0056). */
  readonly heading?: 'h2' | 'h3';
}

const IN_FLIGHT = new Set(['pending', 'claimed', 'retrying']);

/**
 * Manual redelivery (F182/F218). Only failed deliveries get the control, only admins see it
 * enabled, and a click asks first because the destination may receive the message twice.
 * Not optimistic: what is shown is what the server said happened.
 */
export function RedeliverPanel({ orgId, delivery, onShowNew, heading: H = 'h3' }: RedeliverPanelProps) {
  useLocale();
  const replay = useReplay(orgId);
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  if (delivery.state !== 'dead_lettered') return null;
  const latest = delivery.latestReplayState;
  const destination = destinationName(delivery.integration.destination);
  const error = replay.isError ? describeDeliveryError(replay.error) : null;

  const submit = () => {
    if (replay.isPending) return;
    replay.mutate(delivery.id, { onSettled: () => setConfirming(false) });
  };

  let status: string | null = null;
  if (!delivery.canReplay) {
    if (latest === 'sent' || latest === 'accepted') status = t('redeliver.succeeded');
    else if (latest !== null && IN_FLIGHT.has(latest))
      status = t('redeliver.inFlight', { state: t(STATE_LABEL[latest]).toLowerCase() });
    else if (delivery.integrationStatus !== 'available')
      status = t(`redeliver.integration.${delivery.integrationStatus}`);
    else status = t('redeliver.adminOnly');
  }

  return (
    <section className="detail-section" aria-labelledby="redeliver-title">
      <H id="redeliver-title">{t('deliveries.redelivery')}</H>
      {replay.isSuccess && (
        <Notice kind="success">
          <p>{replay.data.created ? t('redeliver.queued') : t('redeliver.already')}</p>
          <Button variant="outline" type="button" onClick={() => onShowNew(replay.data.deliveryId)}>
            {t('redeliver.viewNew')}
          </Button>
        </Notice>
      )}
      {error && (
        <Notice kind="error">
          <p>{error.message}</p>
          {error.reference && <p className="error-reference">{error.reference}</p>}
        </Notice>
      )}
      {status && !replay.isSuccess && <p className="muted">{status}</p>}
      {delivery.canReplay && !replay.isSuccess && !confirming && (
        <Button type="button" onClick={() => setConfirming(true)} disabled={replay.isPending}>
          <IconRepeat size={18} aria-hidden="true" />
          {t('redeliver.button')}
        </Button>
      )}
      {delivery.canReplay && !replay.isSuccess && confirming && (
        <div className="confirm-box" role="group" aria-labelledby="redeliver-confirm-title">
          <p id="redeliver-confirm-title" className="confirm-title">
            {t('redeliver.title')}
          </p>
          <p>{t('redeliver.body', { destination })}</p>
          {delivery.error?.userActionable && <p>{t('redeliver.brokenWarning')}</p>}
          <div className="form-actions">
            <Button ref={cancelRef} type="button" variant="outline" onClick={() => setConfirming(false)}>
              {t('redeliver.cancel')}
            </Button>
            <Button type="button" onClick={submit} aria-disabled={replay.isPending || undefined}>
              {replay.isPending ? t('redeliver.sending') : t('redeliver.confirm')}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
