import { useRef, useState, type FormEvent } from 'react';
import { IconArrowRight, IconCheck } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { focusFirstInvalid } from '../../components/form';
import { Button, Notice } from '../../components/ui';
import { fieldErrorsOf, formLevelError } from '../../integrations/errors';
import { IssuedSecret } from '../../integrations/IssuedSecret';
import { useCreateIntegration, useIntegration } from '../../integrations/hooks';
import { DESTINATIONS } from '../../integrations/destinations';
import { fromServer } from '../../integrations/validation';
import { toBody, validateStep } from '../../integrations/wizard/draft';
import { DestinationStep as ChooseDestination, WebhookStep } from '../../integrations/wizard/steps';
import type { Integration } from '../../lib/api';
import { t } from '../../i18n';
import { useLocale } from '../../i18n/LocaleProvider';
import { setupKeys } from '../hooks';
import { CapabilitySummary } from '../CapabilitySummary';
import { Prerequisite, StepActions, stepState, ContinueLink, type SetupPageProps } from './shared';

/** An integration already exists: this step is done, and what was chosen is shown, never re-asked. */
function AlreadyConnected({ orgId, id }: { orgId: string; id: string }) {
  useLocale();
  const integration = useIntegration(orgId, id);
  const found = integration.data;
  return (
    <div className="form-stack">
      <p>
        {found
          ? t('setup.flow.destination.created', {
              name: found.name,
              destination: t(DESTINATIONS[found.destination].name),
            })
          : t('setup.flow.destination.createdPlain')}
      </p>
      {found && <CapabilitySummary kind={found.destination} />}
      <StepActions back="repository">
        <ContinueLink to="events" />
      </StepActions>
    </div>
  );
}

/**
 * Step 3: choose where messages go and paste the webhook address. This is where the integration
 * is created, with the quiet default events (the next step can change them). It goes through
 * the same `POST /api/integrations` as the Integrations screen: there is no setup-only write
 * path, so editing the integration elsewhere can never put setup out of step.
 */
export function DestinationStep(props: SetupPageProps) {
  useLocale();
  const { orgId, stale, progress, draft, errors, update, setErrors, installations, clearDraft, goTo } = props;
  const qc = useQueryClient();
  const create = useCreateIntegration(orgId);
  const formRef = useRef<HTMLFormElement>(null);
  const [notice, setNotice] = useState<string[]>([]);
  // A custom webhook's signing secret is shown once, before moving on.
  const [issued, setIssued] = useState<{ integration: Integration; secret: string } | null>(null);
  const done = stepState(progress, 'destination_connected');
  const existing = progress.resume.integrationId;
  const proceed = async () => {
    clearDraft();
    await qc.invalidateQueries({ queryKey: setupKeys.all(orgId) });
    goTo('events');
  };

  if (issued)
    return (
      <IssuedSecret
        name={issued.integration.name}
        secret={issued.secret}
        kind="created"
        doneLabel="integration.secret.continue"
        onDone={() => {
          setIssued(null);
          void proceed();
        }}
      />
    );
  if (existing !== null && (done.state === 'done' || done.state === 'blocked'))
    return <AlreadyConnected orgId={orgId} id={existing} />;
  if (draft.repo === '') return <Prerequisite slug="repository" />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending || stale) return;
    const found = { ...validateStep(1, draft, installations), ...validateStep(2, draft, installations) };
    setErrors(found);
    if (Object.keys(found).length > 0 || !draft.destination) return focusFirstInvalid(formRef.current);
    setNotice([]);
    try {
      const { integration, signingSecret } = await create.mutateAsync(
        toBody({ ...draft, destination: draft.destination }),
      );
      if (signingSecret) return setIssued({ integration, secret: signingSecret });
      await proceed();
    } catch (error) {
      const server = fromServer(fieldErrorsOf(error));
      if (Object.keys(server.fields).length > 0) {
        setNotice([t('wizard.serverErrors')]);
        setErrors(server.fields);
        focusFirstInvalid(formRef.current);
      }
    }
  };
  const requestError = create.isError ? formLevelError(create.error) : null;
  return (
    <form ref={formRef} className="form-stack" onSubmit={(e) => void submit(e)} noValidate>
      <p className="field-hint">{t('setup.flow.destination.repo', { repo: draft.repo })}</p>
      <ChooseDestination draft={draft} errors={errors} update={update} installations={installations} />
      {draft.destination && (
        <>
          <CapabilitySummary kind={draft.destination} />
          <WebhookStep draft={draft} errors={errors} update={update} installations={installations} />
        </>
      )}
      {notice.length > 0 && (
        <Notice kind="error">
          {notice.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </Notice>
      )}
      {requestError && (
        <Notice kind="error">
          <p>{requestError.message}</p>
          {requestError.reference && <p className="error-reference">{requestError.reference}</p>}
        </Notice>
      )}
      <StepActions back="repository">
        <Button type="submit" aria-disabled={create.isPending || stale || undefined}>
          <IconCheck size={18} aria-hidden="true" />
          {create.isPending ? t('wizard.creating') : t('setup.flow.destination.save')}
          {!create.isPending && <IconArrowRight size={18} aria-hidden="true" />}
        </Button>
      </StepActions>
    </form>
  );
}
