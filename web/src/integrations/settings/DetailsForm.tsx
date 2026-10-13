import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { Field, focusFirstInvalid } from '../../components/form';
import { Button, Input, Notice } from '../../components/ui';
import type { GithubInstallation, Integration, UpdateIntegrationBody } from '../../lib/api';
import { t } from '../../i18n';
import { fieldErrorsOf, formLevelError } from '../errors';
import { EventPicker } from '../EventPicker';
import { eventsCoverageError } from '../filters/model';
import { isGithubEventType, sortEvents, type GithubEventType } from '../events';
import { integrationKeys, useUpdateIntegration } from '../hooks';
import { activeInstallations, allInstallationFor } from '../github/coverage';
import { useGithubConnection } from '../github/hooks';
import { RepoPicker } from '../github/RepoPicker';
import { validateRepoChoice } from '../wizard/draft';
import { compact, fromServer, validateEvents, validateName, type FieldErrors } from '../validation';

interface DetailsFormProps {
  readonly orgId: string;
  readonly integration: Integration;
}

interface Values {
  readonly name: string;
  readonly repo: string;
  readonly eventTypes: readonly GithubEventType[];
}

function valuesOf(integration: Integration): Values {
  return {
    name: integration.name,
    repo: integration.repo,
    eventTypes: sortEvents(integration.eventTypes.filter(isGithubEventType)),
  };
}

/** The typed-name mode applies when only an `all` installation covers the repository. */
function accountFor(repo: string, installations: readonly GithubInstallation[]): string | null {
  const lower = repo.toLowerCase();
  const listed = activeInstallations(installations).some((i) =>
    i.repositories.some((r) => r.toLowerCase() === lower),
  );
  return listed ? null : (allInstallationFor(repo, installations)?.account ?? null);
}

/** Only the fields that changed, so a save never rewrites what the person did not touch. */
function diff(saved: Values, next: Values): UpdateIntegrationBody {
  const sameEvents = saved.eventTypes.join() === next.eventTypes.join();
  return {
    ...(next.name !== saved.name ? { name: next.name } : {}),
    ...(next.repo !== saved.repo ? { repo: next.repo } : {}),
    ...(sameEvents ? {} : { eventTypes: next.eventTypes }),
  };
}

/**
 * Name, repository and updates, saved explicitly (F217). Unknown legacy event values are not
 * offered as checkboxes; saving the events list replaces them with the catalog selection.
 */
export function DetailsForm({ orgId, integration }: DetailsFormProps) {
  const save = useUpdateIntegration(orgId, integration.id);
  const saved = valuesOf(integration);
  const [values, setValues] = useState<Values>(saved);
  // The server copy this form was last based on. When it changes (a refetch, a toggle), the
  // form adopts it — unless the person has unsaved edits, which are never overwritten.
  const [baseline, setBaseline] = useState<Values>(saved);
  if (JSON.stringify(saved) !== JSON.stringify(baseline)) {
    if (Object.keys(diff(baseline, values)).length === 0) setValues(saved);
    setBaseline(saved);
  }
  const qc = useQueryClient();
  const connection = useGithubConnection(orgId);
  const installations = connection.data?.installations ?? [];
  // `undefined` until the person picks: derive the mode from the saved repository.
  const [pickedAccount, setPickedAccount] = useState<string | null | undefined>(undefined);
  const repoAccount = pickedAccount !== undefined ? pickedAccount : accountFor(values.repo, installations);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [done, setDone] = useState(false);
  const patch = diff(saved, values);
  const dirty = Object.keys(patch).length > 0;

  useBlocker({
    // After a delete the integration's cache entry is gone; there is nothing left to lose.
    shouldBlockFn: () =>
      dirty &&
      qc.getQueryData(integrationKeys.detail(orgId, integration.id)) !== undefined &&
      !window.confirm(t('settings.leaveConfirm')),
    enableBeforeUnload: () => dirty,
  });

  const set = <K extends keyof Values>(field: K, value: Values[K]) => {
    setValues((v) => ({ ...v, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined }));
    setDone(false);
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (save.isPending || !dirty) return;
    const found = compact({
      name: validateName(values.name),
      // Coverage is checked only for a new choice; an unchanged repository is not re-sent.
      repo: values.repo === saved.repo ? undefined : validateRepoChoice(values.repo, installations),
      // Saved "only" filters must still fit the selected updates (the API refuses otherwise).
      eventTypes:
        validateEvents(values.eventTypes) ??
        (patch.eventTypes ? eventsCoverageError(integration.filters, values.eventTypes) : undefined),
    });
    if (Object.keys(found).length > 0) {
      setErrors(found);
      focusFirstInvalid(form);
      return;
    }
    try {
      const next = await save.mutateAsync(patch);
      setValues(valuesOf(next));
      setPickedAccount(undefined);
      setDone(true);
    } catch (error) {
      setErrors(fromServer(fieldErrorsOf(error)).fields);
      focusFirstInvalid(form);
    }
  };

  const requestError = save.isError ? formLevelError(save.error) : null;

  return (
    <form className="form-stack" onSubmit={(e) => void onSubmit(e)} noValidate>
      <Field label={t('field.nameRequired')} error={errors.name}>
        {(ids) => (
          <Input
            id={ids.inputId}
            aria-describedby={ids.describedBy}
            aria-invalid={ids.invalid || undefined}
            value={values.name}
            maxLength={80}
            onChange={(e) => set('name', e.target.value)}
          />
        )}
      </Field>
      <RepoPicker
        installations={installations}
        repo={values.repo}
        repoAccount={repoAccount}
        error={errors.repo}
        onChange={(repo, account) => {
          setPickedAccount(account);
          set('repo', repo);
        }}
      />
      <EventPicker
        value={values.eventTypes}
        error={errors.eventTypes}
        onChange={(next) => set('eventTypes', next)}
      />
      {requestError && (
        <Notice kind="error">
          <p>{requestError.message}</p>
          {requestError.reference && <p className="error-reference">{requestError.reference}</p>}
        </Notice>
      )}
      {done && <Notice kind="success">{t('settings.saved')}</Notice>}
      <div className="form-actions">
        <Button type="submit" aria-disabled={save.isPending || !dirty || undefined}>
          {save.isPending ? t('settings.saving') : t('settings.save')}
        </Button>
        <span className="form-actions-note" role="status">
          {dirty ? t('settings.unsaved') : done ? '' : t('settings.noChanges')}
        </span>
      </div>
    </form>
  );
}
