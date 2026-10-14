import { useCallback } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { IconDownload, IconInbox, IconLock, IconRefresh } from '@tabler/icons-react';
import { Button, Notice } from '../components/ui';
import { PageHeader } from '../components/PageHeader';
import { t, tp } from '../i18n';
import { useLocale } from '../i18n/LocaleProvider';
import { authApi } from '../lib/api';
import { describeError } from '../integrations/errors';
import '../integrations/integrations.css';
import '../deliveries/deliveries.css';
import './audit.css';
import type { AuditEvent } from './api';
import { AuditFilters } from './AuditFilters';
import { AuditTable } from './AuditTable';
import { actionLabel, actorLabel, changePairs, detailPairs, outcomeLabel } from './copy';
import { toCsv } from './csv';
import { useAuditList, useAuditMembers } from './hooks';
import { hasAuditFilters, toAuditFilters, type AuditSearch } from './search';

/** A byte-order mark, so Excel reads the file as UTF-8 (Vietnamese names and labels). */
export const CSV_BOM = '\uFEFF';

/** How long the blob URL stays valid after the click (a revoke straight after can cancel it). */
const REVOKE_DELAY_MS = 10_000;

/** The loaded events as CSV text. Time is ISO UTC; `Who` is a name only, as on screen. */
export function eventsToCsv(rows: readonly AuditEvent[]): string {
  return toCsv(
    [
      t('audit.csv.header.time'),
      t('audit.csv.header.action'),
      t('audit.csv.header.result'),
      t('audit.csv.header.who'),
      t('audit.csv.header.subjectType'),
      t('audit.csv.header.subjectId'),
      t('audit.csv.header.details'),
      t('audit.csv.header.requestId'),
    ],
    rows.map((e) => [
      e.createdAt,
      actionLabel(e.action),
      outcomeLabel(e.outcome),
      actorLabel(e.actor),
      e.subjectType,
      e.subjectId ?? '',
      [...detailPairs(e), ...changePairs(e)].map((p) => `${p.label}: ${p.text}`).join('; '),
      e.correlationId ?? '',
    ]),
  );
}

function downloadCsv(rows: readonly AuditEvent[]): void {
  const url = URL.createObjectURL(new Blob([CSV_BOM, eventsToCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

function ListSkeleton() {
  useLocale();
  return (
    <div className="integration-list" aria-busy="true" aria-label={t('audit.loading')}>
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
    <section className="empty" aria-labelledby="audit-empty-title">
      <div className="empty-icon">
        <IconInbox size={24} aria-hidden="true" />
      </div>
      <h2 id="audit-empty-title">
        {filtered ? t('audit.empty.filtered.title') : t('audit.empty.none.title')}
      </h2>
      <p>{filtered ? t('audit.empty.filtered.body') : t('audit.empty.none.body')}</p>
      {filtered && (
        <Button variant="outline" type="button" onClick={onClear}>
          {t('audit.filter.clear')}
        </Button>
      )}
    </section>
  );
}

function Forbidden() {
  useLocale();
  return (
    <section className="empty" aria-labelledby="audit-forbidden-title">
      <div className="empty-icon">
        <IconLock size={24} aria-hidden="true" />
      </div>
      <h2 id="audit-forbidden-title">{t('audit.forbidden.title')}</h2>
      <p>{t('audit.forbidden.body')}</p>
    </section>
  );
}

export function AuditPage() {
  useLocale();
  const me = useQuery({ queryKey: ['me'], queryFn: authApi.me });
  const orgId = me.data?.user.org_id ?? null;
  const isAdmin = me.data?.user.role === 'admin';
  const search: AuditSearch = useSearch({ from: '/audit' });
  const navigate = useNavigate({ from: '/audit' });
  const list = useAuditList(orgId, toAuditFilters(search), isAdmin);
  const members = useAuditMembers(orgId, isAdmin);
  const setSearch = useCallback(
    (next: AuditSearch) => void navigate({ search: next, replace: true }),
    [navigate],
  );

  const rows = list.data?.pages.flatMap((p) => p.events) ?? [];
  const retentionDays = list.data?.pages[0]?.retentionDays ?? null;
  const firstPage = list.data?.pages[0];
  const total = firstPage?.total ?? null;
  const filtered = hasAuditFilters(search);

  return (
    <>
      <PageHeader
        eyebrow={t('audit.eyebrow')}
        title={t('audit.title')}
        description={t('audit.description')}
        action={
          isAdmin && rows.length > 0 ? (
            <Button variant="outline" type="button" onClick={() => downloadCsv(rows)}>
              <IconDownload size={18} aria-hidden="true" />
              {t('audit.export')}
            </Button>
          ) : undefined
        }
      />
      {me.isPending ? (
        <ListSkeleton />
      ) : !isAdmin ? (
        <Forbidden />
      ) : (
        <>
          {retentionDays !== null && (
            <p className="delivery-model">{t('audit.retention', { days: retentionDays })}</p>
          )}
          <AuditFilters search={search} members={members.data ?? []} onChange={setSearch} />
          {list.isPending ? (
            <ListSkeleton />
          ) : list.isError && rows.length === 0 ? (
            // A failed query is an error, never an empty log (F225).
            <Notice kind="error">
              <p className="notice-title">{t('audit.error.title')}</p>
              <p>
                {describeError(list.error).message} {t('audit.error.body')}
              </p>
              <Button variant="outline" onClick={() => void list.refetch()} disabled={list.isFetching}>
                <IconRefresh size={18} aria-hidden="true" />
                {t('audit.retry')}
              </Button>
            </Notice>
          ) : rows.length === 0 ? (
            <EmptyState filtered={filtered} onClear={() => setSearch({})} />
          ) : (
            <section aria-labelledby="audit-count">
              {list.isError && <Notice kind="warning">{t('audit.error.stale')}</Notice>}
              <p id="audit-count" className="list-count" aria-live="polite">
                {total !== null && (
                  <>
                    {firstPage?.totalCapped
                      ? t('audit.total.capped', { count: total })
                      : tp('audit.total', total)}{' '}
                  </>
                )}
                {tp('audit.count', rows.length)}{' '}
                {list.hasNextPage ? t('audit.count.more') : t('audit.count.end')}
              </p>
              <AuditTable rows={rows} onFilter={setSearch} />
              <p className="field-hint">{t('audit.export.hint')}</p>
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
                    {list.isFetchingNextPage ? t('audit.loadingMore') : t('audit.loadMore')}
                  </Button>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </>
  );
}
