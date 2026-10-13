import { useCallback, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { IconInbox, IconRefresh } from '@tabler/icons-react';
import { Button, Notice } from '../components/ui';
import { PageHeader } from '../components/PageHeader';
import { t, tp } from '../i18n';
import { describeError } from '../integrations/errors';
import { useIntegrations, useOrgId } from '../integrations/hooks';
import '../integrations/integrations.css';
import './deliveries.css';
import type { DeliveryItem } from './api';
import { DeliveryDetail } from './DeliveryDetail';
import { DeliveryFilters } from './DeliveryFilters';
import { DeliveryTable } from './DeliveryTable';
import { useDeliveryList } from './hooks';
import { hasFilters, toFilters, type ActivitySearch } from './search';
import { useLocale } from '../i18n/LocaleProvider';

function ListSkeleton() {
  useLocale();
  return (
    <div className="integration-list" aria-busy="true" aria-label={t('deliveries.loading')}>
      {[0, 1, 2].map((i) => (
        <div key={i} className="integration-card skeleton-card" aria-hidden="true">
          <span className="skeleton skeleton-title" />
          <span className="skeleton skeleton-line" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ filtered, onClear }: { readonly filtered: boolean; readonly onClear: () => void }) {
  useLocale();
  return (
    <section className="empty" aria-labelledby="deliveries-empty-title">
      <div className="empty-icon">
        <IconInbox size={24} aria-hidden="true" />
      </div>
      <h2 id="deliveries-empty-title">
        {filtered ? t('deliveries.empty.filtered.title') : t('deliveries.empty.none.title')}
      </h2>
      <p>{filtered ? t('deliveries.empty.filtered.body') : t('deliveries.empty.none.body')}</p>
      {filtered && (
        <Button variant="outline" type="button" onClick={onClear}>
          {t('deliveries.filter.clear')}
        </Button>
      )}
    </section>
  );
}

interface Selected {
  readonly id: string;
  readonly initial: DeliveryItem | null;
}

export function DeliveryLogPage() {
  useLocale();
  const orgId = useOrgId();
  const search: ActivitySearch = useSearch({ from: '/activity' });
  const navigate = useNavigate({ from: '/activity' });
  const integrations = useIntegrations(orgId);
  const list = useDeliveryList(orgId, toFilters(search));
  const [selected, setSelected] = useState<Selected | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const setSearch = useCallback(
    (next: ActivitySearch) => void navigate({ search: next, replace: true }),
    [navigate],
  );
  const open = useCallback((delivery: DeliveryItem, trigger: HTMLElement) => {
    returnFocus.current = trigger;
    setSelected({ id: delivery.id, initial: delivery });
  }, []);

  const rows = list.data?.pages.flatMap((p) => p.deliveries) ?? [];
  const filtered = hasFilters(search);

  return (
    <>
      <PageHeader
        eyebrow={t('deliveries.eyebrow')}
        title={t('deliveries.title')}
        description={t('deliveries.description')}
      />
      <p className="delivery-model">{t('deliveries.model')}</p>
      <DeliveryFilters
        search={search}
        integrations={integrations.data?.integrations ?? []}
        onChange={setSearch}
      />
      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError && rows.length === 0 ? (
        // A failed query is an error, never an empty log (F213, F225).
        <Notice kind="error">
          <p className="notice-title">{t('deliveries.error.title')}</p>
          <p>
            {describeError(list.error).message} {t('deliveries.error.body')}
          </p>
          <Button variant="outline" onClick={() => void list.refetch()} disabled={list.isFetching}>
            <IconRefresh size={18} aria-hidden="true" />
            {t('deliveries.retry')}
          </Button>
        </Notice>
      ) : rows.length === 0 ? (
        <EmptyState filtered={filtered} onClear={() => setSearch({})} />
      ) : (
        <section aria-labelledby="deliveries-count">
          {list.isError && <Notice kind="warning">{t('deliveries.error.stale')}</Notice>}
          <p id="deliveries-count" className="list-count" aria-live="polite">
            {tp('deliveries.count', rows.length)}{' '}
            {list.hasNextPage ? t('deliveries.count.more') : t('deliveries.count.end')}
          </p>
          <DeliveryTable rows={rows} onOpen={open} />
          {list.hasNextPage && (
            <div className="load-more">
              <Button
                variant="outline"
                type="button"
                onClick={() => {
                  if (!list.isFetchingNextPage) void list.fetchNextPage();
                }}
                aria-disabled={list.isFetchingNextPage || undefined}
              >
                {list.isFetchingNextPage ? t('deliveries.loadingMore') : t('deliveries.loadMore')}
              </Button>
            </div>
          )}
        </section>
      )}
      {orgId && selected && (
        <DeliveryDetail
          key={selected.id}
          orgId={orgId}
          id={selected.id}
          initial={selected.initial}
          returnFocus={returnFocus}
          onClose={() => setSelected(null)}
          onShowNew={(id) => setSelected({ id, initial: null })}
        />
      )}
    </>
  );
}
