import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { IconArrowLeft, IconRefresh } from '@tabler/icons-react';
import { PageHeader } from '../components/PageHeader';
import { Skeleton } from '../components/state';
import { Button, Notice } from '../components/ui';
import { t } from '../i18n';
import { isNotFound } from '../integrations/errors';
import { useOrgId } from '../integrations/hooks';
import '../integrations/integrations.css';
import { RootNotFound } from '../shell/NotFound';
import { describeDeliveryError } from './copy';
import { DeliveryDetailBody, deliveryName } from './DeliveryDetail';
import { useDeliveryDetail } from './hooks';
import './deliveries.css';
import { useLocale } from '../i18n/LocaleProvider';

function BackLink() {
  useLocale();
  return (
    <Link to="/activity" className="text-link back-link">
      <IconArrowLeft size={18} aria-hidden="true" />
      {t('delivery.page.back')}
    </Link>
  );
}

/**
 * `/activity/:deliveryId` (ADR 0056): the delivery detail at its own address, so it survives a
 * reload and can be pasted into a support reply. It renders the dialog's body, from
 * `GET /api/deliveries/:id` alone (nothing from the list is assumed). The server answers 404 for
 * an unknown id and for another workspace's id alike, so both get the shell's 404 page and
 * nothing says which it was. Opening a replay or a redelivery moves to that delivery's page.
 */
export function DeliveryPage() {
  useLocale();
  const { deliveryId = '' } = useParams({ strict: false });
  const orgId = useOrgId();
  const query = useDeliveryDetail(orgId, deliveryId || null);
  const navigate = useNavigate();

  if (query.isError && isNotFound(query.error)) return <RootNotFound />;
  if (query.isPending)
    return (
      <>
        <PageHeader
          before={<BackLink />}
          eyebrow={t('delivery.page.eyebrow')}
          title={t('delivery.page.loading')}
        />
        <Skeleton label={t('delivery.page.loading')} rows={3} />
      </>
    );
  if (query.isError && !query.data)
    return (
      <>
        <PageHeader
          before={<BackLink />}
          eyebrow={t('delivery.page.eyebrow')}
          title={t('delivery.page.error.title')}
        />
        <Notice kind="error">
          <p>{describeDeliveryError(query.error).message}</p>
          <Button variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}>
            <IconRefresh size={18} aria-hidden="true" />
            {t('delivery.page.retry')}
          </Button>
        </Notice>
      </>
    );
  const delivery = query.data?.delivery;
  if (!orgId || !delivery) return null;
  return (
    <>
      <PageHeader
        before={<BackLink />}
        eyebrow={t('delivery.page.eyebrow')}
        title={t('delivery.detail.title', { name: deliveryName(delivery) })}
        description={t('deliveries.model')}
      />
      {/* Keyed by id: opening another delivery from here starts its redelivery panel afresh. */}
      <div className="card delivery-page" key={delivery.id}>
        <DeliveryDetailBody
          orgId={orgId}
          delivery={delivery}
          query={query}
          heading="h2"
          onShowNew={(id) => void navigate({ to: '/activity/$deliveryId', params: { deliveryId: id } })}
          onFollowRequest={() => undefined}
        />
      </div>
    </>
  );
}
