import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { IconArrowLeft, IconRefresh } from '@tabler/icons-react';
import { PageHeader } from '../components/PageHeader';
import { Skeleton } from '../components/state';
import { Button, Notice } from '../components/ui';
import { authApi } from '../lib/api';
import { t } from '../i18n';
import { describeError, isNotFound } from '../integrations/errors';
import { useOrgId } from '../integrations/hooks';
import '../integrations/integrations.css';
import { RootNotFound } from '../shell/NotFound';
import { useSource } from './hooks';
import { SourceCard } from './SourceCard';
import { SourceOutcome, useSourceOutcome } from './SourcesPage';
import './sources.css';
import { useLocale } from '../i18n/LocaleProvider';

function BackLink() {
  useLocale();
  return (
    <Link to="/sources" className="text-link back-link">
      <IconArrowLeft size={18} aria-hidden="true" />
      {t('sources.detail.back')}
    </Link>
  );
}

/**
 * `/sources/:sourceId` (ADR 0056): the same card the list shows, at an address that survives a reload and can be
 * pasted into a support reply. The server answers 404 for a deleted source and for another workspace's id alike,
 * so both get the shell's 404 page and nothing says which it was. A rotated secret is revealed here exactly as on
 * the list: once, in memory. After a delete the page goes back to the list; it never carries anything in the URL.
 */
export function SourceDetailPage() {
  useLocale();
  const { sourceId = '' } = useParams({ strict: false });
  const orgId = useOrgId();
  const query = useSource(orgId, sourceId);
  const me = useQuery({ queryKey: ['me'], queryFn: authApi.me });
  const isAdmin = me.data?.user.role === 'admin';
  const outcome = useSourceOutcome();
  const navigate = useNavigate();

  if (query.isError && isNotFound(query.error)) return <RootNotFound />;
  if (query.isPending)
    return (
      <>
        <PageHeader
          before={<BackLink />}
          eyebrow={t('sources.detail.eyebrow')}
          title={t('sources.detail.loading')}
        />
        <Skeleton label={t('sources.detail.loading')} rows={2} />
      </>
    );
  if (query.isError && !query.data)
    return (
      <>
        <PageHeader
          before={<BackLink />}
          eyebrow={t('sources.detail.eyebrow')}
          title={t('sources.detail.error.title')}
        />
        <Notice kind="error">
          <p>{describeError(query.error).message}</p>
          <Button variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}>
            <IconRefresh size={18} aria-hidden="true" />
            {t('sources.detail.retry')}
          </Button>
        </Notice>
      </>
    );
  const source = query.data;
  if (!orgId || !source) return null;
  return (
    <>
      <PageHeader before={<BackLink />} eyebrow={t('sources.detail.eyebrow')} title={source.name} />
      <SourceOutcome outcome={outcome} />
      <SourceCard
        orgId={orgId}
        source={source}
        isAdmin={isAdmin}
        standalone
        onRotated={(result) => outcome.show('rotated', result)}
        onDeleted={() => void navigate({ to: '/sources' })}
      />
    </>
  );
}
