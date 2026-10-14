import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { IconArrowRight } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { ErrorPanel } from '../../components/ErrorPanel';
import { Skeleton } from '../../components/state';
import { Button, Notice } from '../../components/ui';
import { formLevelError } from '../../integrations/errors';
import { EventPicker } from '../../integrations/EventPicker';
import { isGithubEventType, sortEvents, type GithubEventType } from '../../integrations/events';
import { useIntegration, useUpdateIntegration } from '../../integrations/hooks';
import { validateEvents } from '../../integrations/validation';
import { t } from '../../i18n';
import { useLocale } from '../../i18n/LocaleProvider';
import { setupKeys } from '../hooks';
import { Prerequisite, StepActions, stepState, ContinueLink, type SetupPageProps } from './shared';
import type { Integration } from '../../lib/api';

/**
 * Step 4, optional: change which updates are sent. The integration already exists with the quiet
 * default (failed builds), so a person who has no opinion presses Continue and nothing is
 * written. More precise rules (filters, quiet hours, summaries) stay in the integration's
 * settings, linked here, so there is one place for them.
 */
function EventsEditor({
  orgId,
  integration,
  goTo,
}: { orgId: string; integration: Integration } & Pick<SetupPageProps, 'goTo'>) {
  useLocale();
  const qc = useQueryClient();
  const save = useUpdateIntegration(orgId, integration.id);
  const saved = sortEvents(integration.eventTypes.filter(isGithubEventType));
  const [events, setEvents] = useState<GithubEventType[]>(saved);
  const [error, setError] = useState<string | undefined>();
  const changed = events.join() !== saved.join();
  const next = async () => {
    const problem = validateEvents(events);
    setError(problem);
    if (problem) return;
    if (changed) {
      try {
        await save.mutateAsync({ eventTypes: events });
      } catch {
        return;
      }
    }
    await qc.invalidateQueries({ queryKey: setupKeys.all(orgId) });
    goTo('test');
  };
  const failure = save.isError ? formLevelError(save.error) : null;
  return (
    <div className="form-stack">
      <p>{t('setup.flow.events.intro')}</p>
      <EventPicker
        value={events}
        error={error}
        onChange={(value) => {
          setEvents(value);
          setError(undefined);
        }}
      />
      <p className="field-hint">
        {t('setup.flow.events.more')}{' '}
        <Link to="/integrations/$id" params={{ id: integration.id }} hash="filters" className="text-link">
          {t('setup.flow.events.moreLink')}
        </Link>
      </p>
      {failure && (
        <Notice kind="error">
          <p>{failure.message}</p>
          {failure.reference && <p className="error-reference">{failure.reference}</p>}
        </Notice>
      )}
      <StepActions back="destination">
        <Button type="button" aria-disabled={save.isPending || undefined} onClick={() => void next()}>
          {save.isPending
            ? t('setup.flow.events.saving')
            : t(changed ? 'setup.flow.events.save' : 'setup.flow.events.keep')}
          {!save.isPending && <IconArrowRight size={18} aria-hidden="true" />}
        </Button>
      </StepActions>
    </div>
  );
}

export function EventsStep({ orgId, progress, goTo }: SetupPageProps) {
  useLocale();
  const id = progress.resume.integrationId;
  const integration = useIntegration(orgId, id ?? '');
  const created = stepState(progress, 'repositories_selected').state === 'done';
  if (!created || id === null) return <Prerequisite slug="destination" />;
  if (integration.isPending) return <Skeleton label={t('settings.loading')} rows={1} />;
  if (integration.isError)
    return (
      <ErrorPanel
        error={integration.error}
        what="errorpanel.what.integration"
        onRetry={() => void integration.refetch()}
      />
    );
  if (integration.data.sourceId !== null)
    return (
      <div className="form-stack">
        <p>{t('setup.flow.events.source')}</p>
        <StepActions back="destination">
          <ContinueLink to="test" />
        </StepActions>
      </div>
    );
  return <EventsEditor orgId={orgId} integration={integration.data} goTo={goTo} />;
}
