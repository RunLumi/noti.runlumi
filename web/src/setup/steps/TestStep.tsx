import { Link } from '@tanstack/react-router';
import { ErrorPanel } from '../../components/ErrorPanel';
import { Skeleton } from '../../components/state';
import { EnabledSwitch } from '../../integrations/EnabledSwitch';
import { useIntegration } from '../../integrations/hooks';
import { TestSend } from '../../integrations/test/TestSend';
import { t } from '../../i18n';
import { useLocale } from '../../i18n/LocaleProvider';
import {
  BlockedNotice,
  ContinueLink,
  Prerequisite,
  StepActions,
  stepState,
  type SetupPageProps,
} from './shared';

/**
 * Step 5: send a real test through the integration and read what the destination answered. The
 * step is done only when the server has seen a confirmed or accepted delivery; a failed or
 * unanswered test leaves it open, with the fix beside it. A paused or quarantined integration
 * is not asked to send: the repair comes first, here, and the page says why.
 */
export function TestStep({ orgId, progress }: SetupPageProps) {
  useLocale();
  const id = progress.resume.integrationId;
  const integration = useIntegration(orgId, id ?? '');
  const step = stepState(progress, 'test_delivered');
  if (id === null) return <Prerequisite slug="destination" />;
  if (integration.isPending) return <Skeleton label={t('settings.loading')} rows={1} />;
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
      {step.state === 'done' && (
        <p className="setup-verified" role="status">
          {t(step.verification === 'accepted' ? 'setup.flow.test.accepted' : 'setup.flow.test.confirmed')}
        </p>
      )}
      {step.state === 'blocked' && step.blockedBy && (
        <BlockedNotice reason={step.blockedBy}>
          {step.blockedBy === 'credentials_quarantined' ? (
            <p>
              <Link to="/integrations/$id" params={{ id: found.id }} hash="credentials" className="text-link">
                {t('test.failed.fix')}
              </Link>
            </p>
          ) : (
            <EnabledSwitch orgId={orgId} integration={found} />
          )}
        </BlockedNotice>
      )}
      <p>{t('setup.flow.test.intro')}</p>
      <TestSend orgId={orgId} integration={found} />
      <StepActions back="events">
        <ContinueLink to="done" label={step.state === 'done' ? 'setup.flow.continue' : 'setup.flow.skip'} />
      </StepActions>
    </div>
  );
}
