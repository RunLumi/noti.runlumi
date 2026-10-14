import { useState, type ComponentType } from 'react';
import { Link, useBlocker, useNavigate, useParams } from '@tanstack/react-router';
import { PageHeader } from '../components/PageHeader';
import { ErrorPanel } from '../components/ErrorPanel';
import { Skeleton } from '../components/state';
import { useOrgId } from '../integrations/hooks';
import { useGithubConnection } from '../integrations/github/hooks';
import { EMPTY_DRAFT, isDirty, type Draft, type WizardErrors } from '../integrations/wizard/draft';
import { t } from '../i18n';
import { useLocale } from '../i18n/LocaleProvider';
import { RootNotFound } from '../shell/NotFound';
import { StaleWorkspaceNotice, useBoundWorkspace } from '../workspace/bound';
import { useSetupProgress } from './hooks';
import { SETUP_PAGES, isSetupSlug, type SetupSlug } from './model';
import { SetupStepper } from './SetupStepper';
import { DestinationStep } from './steps/DestinationStep';
import { DoneStep } from './steps/DoneStep';
import { EventsStep } from './steps/EventsStep';
import { GithubStep } from './steps/GithubStep';
import { RepositoryStep } from './steps/RepositoryStep';
import type { SetupPageProps } from './steps/shared';
import { TestStep } from './steps/TestStep';
import '../integrations/integrations.css';
import './setup.css';

const PAGES: Readonly<Record<SetupSlug, ComponentType<SetupPageProps>>> = {
  github: GithubStep,
  repository: RepositoryStep,
  destination: DestinationStep,
  events: EventsStep,
  test: TestStep,
  done: DoneStep,
};

/**
 * The `/setup/:step` route space (spec 14 F216, ADR 0025). Every page is an address, so Back,
 * Forward, a bookmark and a link to a colleague all work. What is done is never remembered here:
 * the server derives it on every load (`/api/setup/progress`), so a refresh, a second device or
 * a returning person all land on the right step. The only thing held in this component is the
 * draft of the step in progress (repository, destination, webhook address), in memory, and it
 * goes when the person leaves setup (they are asked first if it holds something).
 */
export function SetupFlow() {
  useLocale();
  const { step } = useParams({ strict: false });
  const navigate = useNavigate();
  const ws = useBoundWorkspace(useOrgId());
  const orgId = ws.orgId;
  const progress = useSetupProgress(orgId || null);
  const connection = useGithubConnection(orgId || null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<WizardErrors>({});

  useBlocker({
    shouldBlockFn: ({ next }) =>
      !next.pathname.startsWith('/setup') && isDirty(draft) && !window.confirm(t('setup.flow.leaveConfirm')),
    enableBeforeUnload: () => isDirty(draft),
  });

  if (!isSetupSlug(step)) return <RootNotFound />;
  const Page = PAGES[step];
  const position = Object.keys(PAGES).indexOf(step) + 1;
  const total = Object.keys(PAGES).length;
  const props = (data: NonNullable<typeof progress.data>): SetupPageProps => ({
    orgId,
    stale: ws.stale,
    progress: data,
    draft,
    errors,
    installations: connection.data?.installations ?? [],
    update: (field, value) => {
      setDraft((d) => ({ ...d, [field]: value }));
      setErrors((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== field)));
    },
    setErrors,
    clearDraft: () => {
      setDraft(EMPTY_DRAFT);
      setErrors({});
    },
    goTo: (slug) => void navigate({ to: '/setup/$step', params: { step: slug } }),
  });

  return (
    <>
      <PageHeader
        eyebrow={t('setup.flow.eyebrow')}
        title={t(SETUP_PAGES[step].title)}
        description={t(SETUP_PAGES[step].description)}
        action={
          <Link to="/" className="btn btn-ghost">
            {t('setup.flow.later')}
          </Link>
        }
      />
      <div className="wizard setup-flow">
        {progress.data ? (
          <SetupStepper progress={progress.data} current={step} />
        ) : (
          <div className="setup-nav" aria-hidden="true" />
        )}
        <div className="wizard-sheet">
          <h2 className="wizard-step-title">
            {t('wizard.stepOf', { current: position, total, title: t(SETUP_PAGES[step].title) })}
          </h2>
          <StaleWorkspaceNotice show={ws.stale} />
          {progress.isPending ? (
            <Skeleton label={t('setup.flow.loading')} rows={2} />
          ) : progress.isError ? (
            <ErrorPanel
              error={progress.error}
              what="errorpanel.what.setup"
              onRetry={() => void progress.refetch()}
            />
          ) : (
            <Page {...props(progress.data)} />
          )}
        </div>
      </div>
    </>
  );
}
