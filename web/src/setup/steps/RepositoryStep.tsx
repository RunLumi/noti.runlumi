import { useRef, type FormEvent } from 'react';
import { IconArrowRight } from '@tabler/icons-react';
import { ErrorPanel } from '../../components/ErrorPanel';
import { focusFirstInvalid } from '../../components/form';
import { Skeleton } from '../../components/state';
import { Button } from '../../components/ui';
import { activeInstallations } from '../../integrations/github/coverage';
import { useGithubConnection } from '../../integrations/github/hooks';
import { ConnectGithubButton } from '../../integrations/github/ConnectGithubButton';
import { validateStep } from '../../integrations/wizard/draft';
import { SourceStep } from '../../integrations/wizard/steps';
import { t } from '../../i18n';
import { useLocale } from '../../i18n/LocaleProvider';
import { Prerequisite, StepActions, stepState, type SetupPageProps } from './shared';

/**
 * Step 2: choose the repository. Only repositories the GitHub connection shares with Noti are
 * listed; the picker says whether each account shares a chosen few or all of them, and where to
 * change that on GitHub. Nothing is saved yet: the repository is kept in this page's memory
 * until the destination step creates the integration in one go.
 */
export function RepositoryStep(props: SetupPageProps) {
  useLocale();
  const { orgId, progress, draft, errors, update, setErrors, goTo } = props;
  const connection = useGithubConnection(orgId || null);
  const formRef = useRef<HTMLFormElement>(null);
  const github = stepState(progress, 'github_connected');
  const created = stepState(progress, 'repositories_selected').state === 'done';
  if (github.state === 'blocked' || github.state === 'todo' || github.state === 'doing')
    return <Prerequisite slug="github" />;
  if (connection.isPending) return <Skeleton label={t('github.loading')} rows={1} />;
  if (connection.isError)
    return (
      <ErrorPanel error={connection.error} what="github.error" onRetry={() => void connection.refetch()} />
    );
  const installations = connection.data.installations;
  if (created)
    return (
      <div className="form-stack">
        <p>{t('setup.flow.repository.created')}</p>
        <StepActions back="github">
          <Button type="button" onClick={() => goTo('destination')}>
            {t('setup.flow.continue')}
            <IconArrowRight size={18} aria-hidden="true" />
          </Button>
        </StepActions>
      </div>
    );
  if (activeInstallations(installations).length === 0)
    return (
      <div className="form-stack">
        <p>{t('setup.flow.repository.none')}</p>
        <ConnectGithubButton orgId={orgId} reconnect fromSetup />
      </div>
    );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const found = validateStep(0, draft, installations);
    setErrors(found);
    if (Object.keys(found).length > 0) return focusFirstInvalid(formRef.current);
    goTo('destination');
  };
  return (
    <form ref={formRef} className="form-stack" onSubmit={submit} noValidate>
      <SourceStep draft={draft} errors={errors} update={update} installations={installations} />
      <StepActions back="github">
        <Button type="submit">
          {t('setup.flow.continue')}
          <IconArrowRight size={18} aria-hidden="true" />
        </Button>
      </StepActions>
    </form>
  );
}
