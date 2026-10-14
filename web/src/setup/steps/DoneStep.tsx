import { Link } from '@tanstack/react-router';
import { IconCircleCheck, IconPlus } from '@tabler/icons-react';
import { ErrorPanel } from '../../components/ErrorPanel';
import { Skeleton } from '../../components/state';
import { Notice } from '../../components/ui';
import { DESTINATIONS } from '../../integrations/destinations';
import { useIntegration } from '../../integrations/hooks';
import { t } from '../../i18n';
import { useLocale } from '../../i18n/LocaleProvider';
import { slugForStep } from '../model';
import { ContinueLink, StepActions, stepState, type SetupPageProps } from './shared';

/**
 * The last page says what is live in one sentence, from the real integration, and what has not
 * happened yet. A real event has to arrive to prove the whole path; tests do not count, and the
 * page says so rather than claiming a finish line it has not seen (F216).
 */
export function DoneStep({ orgId, progress }: SetupPageProps) {
  useLocale();
  const id = progress.resume.integrationId;
  const integration = useIntegration(orgId, id ?? '');
  const test = stepState(progress, 'test_delivered');
  const activated = stepState(progress, 'activated').state === 'done';
  if (!progress.complete)
    return (
      <div className="form-stack">
        <Notice>
          <p className="notice-title">{t('setup.flow.done.unfinished.title')}</p>
          <p>{t('setup.flow.done.unfinished.body')}</p>
        </Notice>
        <StepActions back="test">
          <ContinueLink to={slugForStep(progress.resume.step)} />
        </StepActions>
      </div>
    );
  if (id !== null && integration.isPending) return <Skeleton label={t('settings.loading')} rows={1} />;
  if (integration.isError)
    return (
      <ErrorPanel
        error={integration.error}
        what="errorpanel.what.integration"
        onRetry={() => void integration.refetch()}
      />
    );
  const found = integration.data;
  return (
    <div className="form-stack">
      <section className="setup-done" aria-labelledby="setup-done-title">
        <h3 id="setup-done-title">
          <IconCircleCheck size={22} aria-hidden="true" />
          {t('setup.flow.done.title')}
        </h3>
        {found && (
          <p>
            {t('setup.flow.done.live', {
              source: found.sourceId ? t('integration.source.value') : found.repo,
              destination: t(DESTINATIONS[found.destination].name),
            })}
          </p>
        )}
        {test.verification === 'accepted' && <p>{t('setup.flow.done.accepted')}</p>}
        <p>{t(activated ? 'setup.flow.done.realYes' : 'setup.flow.done.realNo')}</p>
      </section>
      <StepActions back="test">
        {found && (
          <Link to="/activity" search={{ integration: found.id }} className="btn btn-primary">
            {t('setup.flow.done.activity')}
          </Link>
        )}
        {found && (
          <Link to="/integrations/$id" params={{ id: found.id }} className="btn btn-outline">
            {t('setup.flow.done.manage')}
          </Link>
        )}
        <Link to="/integrations/new" className="btn btn-outline">
          <IconPlus size={18} aria-hidden="true" />
          {t('setup.flow.done.another')}
        </Link>
      </StepActions>
    </div>
  );
}
