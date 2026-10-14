import { StaleWorkspaceNotice, useBoundWorkspace } from '../../workspace/bound';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useBlocker, useNavigate } from '@tanstack/react-router';
import { IconArrowLeft, IconArrowRight, IconCheck } from '@tabler/icons-react';
import { focusFirstInvalid } from '../../components/form';
import { PageHeader } from '../../components/PageHeader';
import { Button, Notice } from '../../components/ui';
import { t } from '../../i18n';
import { fieldErrorsOf, formLevelError } from '../errors';
import { IssuedSecret } from '../IssuedSecret';
import { useCreateIntegration, useOrgId } from '../hooks';
import { activeInstallations } from '../github/coverage';
import { useGithubConnection } from '../github/hooks';
import type { Integration } from '../../lib/api';
import { fromServer } from '../validation';
import {
  EMPTY_DRAFT,
  STEPS,
  earliestStep,
  isDirty,
  stepOf,
  toBody,
  validateAll,
  validateStep,
  type Draft,
  type WizardErrors,
  type WizardField,
} from './draft';
import { GithubGate } from './GithubGate';
import { Stepper } from './Stepper';
import { TestStep } from './TestStep';
import {
  DestinationStep,
  EventsStep,
  FiltersStep,
  ReviewStep,
  SourceStep,
  WebhookStep,
  type StepProps,
} from './steps';
import '../integrations.css';
import { useLocale } from '../../i18n/LocaleProvider';

const STEP_BODIES = [SourceStep, DestinationStep, WebhookStep, EventsStep, FiltersStep] as const;
const LAST = STEPS.length - 1;

/**
 * Six short steps, repository first (filters are optional); nothing is saved until the last one. Each "Continue" checks only that
 * step. The server re-validates on create, and its field errors send the person back to the
 * earliest step that needs attention, with the message beside the field.
 */
export function CreateWizard() {
  useLocale();
  // Bound at mount: another tab switching workspace must not redirect this form's write.
  const ws = useBoundWorkspace(useOrgId());
  const orgId = ws.orgId;
  const create = useCreateIntegration(orgId);
  const navigate = useNavigate();
  const formRef = useRef<HTMLFormElement>(null);
  const connection = useGithubConnection(orgId || null);
  const installations = connection.data?.installations ?? [];
  // No active installation means no repository can be named: step 1 becomes "Connect GitHub".
  const gated = activeInstallations(installations).length === 0;
  const steps = gated ? ['wizard.step.github' as const, ...STEPS.slice(1)] : STEPS;
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<WizardErrors>({});
  const [formNotice, setFormNotice] = useState<string[]>([]);
  const leaving = useRef(false);
  // A custom webhook's signing secret, shown once after the save; see `IssuedSecret`.
  const [issued, setIssued] = useState<{ integration: Integration; secret: string } | null>(null);
  // Set once the integration is saved: the optional "Test it" step is shown instead of leaving.
  const [saved, setSaved] = useState<Integration | null>(null);

  useBlocker({
    shouldBlockFn: () => !leaving.current && isDirty(draft) && !window.confirm(t('wizard.leaveConfirm')),
    enableBeforeUnload: () => !leaving.current && isDirty(draft),
  });

  const update: StepProps['update'] = (field, value) => {
    setDraft((d) => ({ ...d, [field]: value }));
    setFormNotice([]);
    // A field's error clears as soon as the person changes that field.
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== field)));
  };

  const goTo = (next: number) => {
    setStep(next);
    // A request error belongs to the attempt that caused it, not to every later step.
    if (create.isError) create.reset();
    // Discrete events commit synchronously, so the new step is in the DOM by the next frame.
    requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('.wizard-step-title')?.focus());
  };

  const showErrors = (found: WizardErrors, at: number) => {
    setErrors(found);
    setStep(at);
    focusFirstInvalid(formRef.current);
  };

  const submit = async () => {
    if (create.isPending || ws.stale) return;
    const all = validateAll(draft, installations);
    if (Object.keys(all).length > 0 || !draft.destination) return showErrors(all, earliestStep(all, 0));
    setFormNotice([]);
    try {
      const { integration: created, signingSecret } = await create.mutateAsync(
        toBody({ ...draft, destination: draft.destination }),
      );
      leaving.current = true;
      if (signingSecret) {
        // Stay on this page until the person has copied it: it cannot be shown again.
        setIssued({ integration: created, secret: signingSecret });
        return;
      }
      setSaved(created);
    } catch (error) {
      const server = fromServer(fieldErrorsOf(error));
      if (Object.keys(server.fields).length > 0) {
        setFormNotice([t('wizard.serverErrors')]);
        showErrors(server.fields, earliestStep(server.fields, LAST));
      }
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (step === 0 && gated) return;
    if (step === LAST) return void submit();
    const found = validateStep(step, draft, installations);
    if (Object.keys(found).length > 0) return showErrors(found, step);
    // This step now passes, so any earlier server message about its fields is stale.
    setErrors((current) =>
      Object.fromEntries(Object.entries(current).filter(([key]) => stepOf(key as WizardField) !== step)),
    );
    goTo(step + 1);
  };

  const toIntegration = (id: string) =>
    void navigate({ to: '/integrations/$id', params: { id }, search: { created: true } });

  if (issued) {
    return (
      <div className="wizard">
        <IssuedSecret
          name={issued.integration.name}
          secret={issued.secret}
          kind="created"
          doneLabel="integration.secret.continue"
          onDone={() => {
            setSaved(issued.integration);
            setIssued(null);
          }}
        />
      </div>
    );
  }
  // Every step plus the optional test; the six before it are done once the integration exists.
  const allSteps = [...steps, 'wizard.step.test' as const];
  if (saved && orgId)
    return (
      <TestStep orgId={orgId} integration={saved} steps={allSteps} onDone={() => toIntegration(saved.id)} />
    );

  const editFromReview = (field: WizardField) => goTo(stepOf(field));
  const Body = STEP_BODIES[step];
  const requestError = create.isError ? formLevelError(create.error) : null;

  return (
    <>
      <PageHeader
        before={
          <Link to="/integrations" className="text-link back-link">
            <IconArrowLeft size={18} aria-hidden="true" />
            {t('settings.back')}
          </Link>
        }
        eyebrow={t('wizard.eyebrow')}
        title={t('wizard.title')}
        description={t('wizard.description')}
      />
      <div className="wizard">
        <Stepper steps={allSteps} current={step} />
        <form ref={formRef} className="wizard-sheet" onSubmit={onSubmit} noValidate>
          <h2 className="wizard-step-title" tabIndex={-1}>
            {t('wizard.stepOf', {
              current: step + 1,
              total: allSteps.length,
              title: t(steps[step] ?? STEPS[0]),
            })}
          </h2>
          <StaleWorkspaceNotice show={ws.stale} />
          {formNotice.length > 0 && (
            <Notice kind="error">
              {formNotice.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </Notice>
          )}
          {step === 0 && gated ? (
            <GithubGate orgId={orgId} connection={connection} />
          ) : Body ? (
            <Body draft={draft} errors={errors} update={update} installations={installations} />
          ) : (
            <ReviewStep draft={draft} onEdit={editFromReview} />
          )}
          {requestError && (
            <Notice kind="error">
              <p>{requestError.message}</p>
              {requestError.reference && <p className="error-reference">{requestError.reference}</p>}
            </Notice>
          )}
          <div className="wizard-actions">
            {step > 0 ? (
              <Button type="button" variant="outline" onClick={() => goTo(step - 1)}>
                <IconArrowLeft size={18} aria-hidden="true" />
                {t('wizard.back')}
              </Button>
            ) : (
              <Link to="/integrations" className="btn btn-ghost">
                {t('wizard.cancel')}
              </Link>
            )}
            {!(step === 0 && gated) && (
              <Button type="submit" aria-disabled={create.isPending || ws.stale || undefined}>
                {step === LAST ? (
                  <>
                    <IconCheck size={18} aria-hidden="true" />
                    {create.isPending ? t('wizard.creating') : t('wizard.create')}
                  </>
                ) : (
                  <>
                    {t('wizard.continue')}
                    <IconArrowRight size={18} aria-hidden="true" />
                  </>
                )}
              </Button>
            )}
          </div>
        </form>
      </div>
    </>
  );
}
