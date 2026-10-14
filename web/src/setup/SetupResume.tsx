import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ErrorPanel } from '../components/ErrorPanel';
import { PageHeader } from '../components/PageHeader';
import { Skeleton } from '../components/state';
import { useOrgId } from '../integrations/hooks';
import { t } from '../i18n';
import { useLocale } from '../i18n/LocaleProvider';
import { useSetupProgress } from './hooks';
import { slugForStep } from './model';

/**
 * `/setup` itself: ask the server where this workspace left off and go there, replacing this
 * entry in history so Back does not land on a page that only redirects. A finished workspace
 * opens the last page, which says what is live.
 */
export function SetupResume() {
  useLocale();
  const orgId = useOrgId();
  const progress = useSetupProgress(orgId);
  const navigate = useNavigate();
  const resume = progress.data?.resume;
  useEffect(() => {
    if (!resume) return;
    void navigate({ to: '/setup/$step', params: { step: slugForStep(resume.step) }, replace: true });
  }, [resume, navigate]);
  return (
    <>
      <PageHeader eyebrow={t('setup.flow.eyebrow')} title={t('route.title.setup')} />
      {progress.isError ? (
        <ErrorPanel
          error={progress.error}
          what="errorpanel.what.setup"
          onRetry={() => void progress.refetch()}
        />
      ) : (
        <Skeleton label={t('setup.flow.loading')} rows={2} />
      )}
    </>
  );
}
