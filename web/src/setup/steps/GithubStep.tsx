import { Link } from '@tanstack/react-router';
import { IconBrandGithub } from '@tabler/icons-react';
import { ErrorPanel } from '../../components/ErrorPanel';
import { Skeleton } from '../../components/state';
import { ConnectGithubButton } from '../../integrations/github/ConnectGithubButton';
import { Installation } from '../../integrations/github/GithubPanel';
import { GithubReturnStatus } from '../../integrations/github/ReturnStatus';
import { activeInstallations } from '../../integrations/github/coverage';
import { useGithubConnection } from '../../integrations/github/hooks';
import { t } from '../../i18n';
import { useLocale } from '../../i18n/LocaleProvider';
import { BlockedNotice, ContinueLink, StepActions, stepState, type SetupPageProps } from './shared';

/**
 * Step 1: connect the GitHub account whose repositories Noti should watch. Which account is
 * connected is shown by name and type, with a way to connect a different one, because the most
 * common first-run mistake is installing on the wrong account (F208). When this server has no
 * GitHub App the step says so and who can fix it, instead of offering a button that cannot work.
 */
export function GithubStep({ orgId, progress }: SetupPageProps) {
  useLocale();
  const connection = useGithubConnection(orgId || null);
  const step = stepState(progress, 'github_connected');
  const ready = step.state === 'done' || step.state === 'skipped';
  const accounts = activeInstallations(connection.data?.installations ?? []);
  return (
    <div className="form-stack">
      <GithubReturnStatus orgId={orgId} next="/setup/repository" />
      {step.state === 'blocked' && step.blockedBy && (
        <BlockedNotice reason={step.blockedBy}>
          <p>
            <Link to="/sources" className="text-link">
              {t('setup.flow.github.useSource')}
            </Link>
          </p>
        </BlockedNotice>
      )}
      {step.state === 'skipped' && <p>{t('setup.flow.github.skipped')}</p>}
      {step.state !== 'blocked' && step.state !== 'skipped' && !ready && (
        <>
          <div className="github-gate">
            <div className="empty-icon">
              <IconBrandGithub size={24} aria-hidden="true" />
            </div>
            <h3>{t('setup.flow.github.title')}</h3>
            <p>{t('setup.flow.github.body')}</p>
            <ConnectGithubButton orgId={orgId} fromSetup />
            <p className="field-hint">{t('github.samlHint')}</p>
          </div>
        </>
      )}
      {step.state === 'done' &&
        (connection.isPending ? (
          <Skeleton label={t('github.loading')} rows={1} />
        ) : connection.isError ? (
          <ErrorPanel
            error={connection.error}
            what="github.error"
            onRetry={() => void connection.refetch()}
          />
        ) : (
          <section aria-labelledby="setup-github-accounts" className="setup-connected">
            <h3 id="setup-github-accounts">{t('setup.flow.github.connected')}</h3>
            <ul className="installations">
              {accounts.map((installation) => (
                <Installation key={installation.id} orgId={orgId} installation={installation} />
              ))}
            </ul>
            {connection.data.configured && (
              <div className="setup-wrong-account">
                <h4>{t('setup.flow.github.wrong.title')}</h4>
                <p className="field-hint">{t('setup.flow.github.wrong.body')}</p>
                <ConnectGithubButton orgId={orgId} variant="outline" another fromSetup />
              </div>
            )}
          </section>
        ))}
      <StepActions>{ready && <ContinueLink to="repository" />}</StepActions>
    </div>
  );
}
