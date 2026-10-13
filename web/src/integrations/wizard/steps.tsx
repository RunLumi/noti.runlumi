import { useId, type ReactNode } from 'react';
import { IconAlertCircle } from '@tabler/icons-react';
import { Field } from '../../components/form';
import { Input } from '../../components/ui';
import type { DestinationKind, GithubInstallation } from '../../lib/api';
import { RepoPicker } from '../github/RepoPicker';
import { t } from '../../i18n';
import { DESTINATION_ORDER, DESTINATIONS } from '../destinations';
import { EventList } from '../EventList';
import { EventPicker } from '../EventPicker';
import type { GithubEventType } from '../events';
import { WebhookFields, WebhookGuide } from '../WebhookFields';
import type { Draft, WizardErrors, WizardField } from './draft';

export interface StepProps {
  readonly draft: Draft;
  readonly errors: WizardErrors;
  readonly update: <K extends keyof Draft>(field: K, value: Draft[K]) => void;
  readonly installations: readonly GithubInstallation[];
}

export function DestinationStep({ draft, errors, update }: StepProps) {
  const base = useId();
  const errorId = base + '-error';
  return (
    <fieldset
      className="destination-choice"
      aria-describedby={[errors.destination ? errorId : '', base + '-note'].filter(Boolean).join(' ')}
    >
      <legend className="field-label">{t('wizard.destination.legend')}</legend>
      {errors.destination && (
        <p className="field-error" id={errorId} role="alert">
          <IconAlertCircle size={18} aria-hidden="true" />
          <span>{errors.destination}</span>
        </p>
      )}
      <div className="destination-options">
        {DESTINATION_ORDER.map((kind) => {
          const info = DESTINATIONS[kind];
          return (
            <label key={kind} className="destination-option">
              <input
                type="radio"
                name="destination"
                value={kind}
                checked={draft.destination === kind}
                aria-invalid={errors.destination ? true : undefined}
                onChange={() => update('destination', kind)}
              />
              <span className="destination-option-body">
                <span className="destination-option-name">{t(info.name)}</span>
                <span className="destination-option-where">{t(info.where)}</span>
                <span className="destination-option-what">{t(info.what)}</span>
              </span>
            </label>
          );
        })}
      </div>
      <p className="field-hint" id={base + '-note'}>
        {t('wizard.destination.changeNote')}
      </p>
    </fieldset>
  );
}

export function WebhookStep({ draft, errors, update }: StepProps) {
  const destination: DestinationKind = draft.destination ?? 'slack';
  return (
    <div className="webhook-step">
      <WebhookGuide destination={destination} />
      <WebhookFields
        destination={destination}
        webhookUrl={draft.webhookUrl}
        signingSecret={draft.signingSecret}
        errors={errors}
        onChange={(field, value) => update(field, value)}
      />
    </div>
  );
}

export function SourceStep({ draft, errors, update, installations }: StepProps) {
  return (
    <div className="form-stack">
      <RepoPicker
        installations={installations}
        repo={draft.repo}
        repoAccount={draft.repoAccount}
        error={errors.repo}
        onChange={(repo, account) => {
          update('repo', repo);
          update('repoAccount', account);
        }}
      />
      <Field label={t('field.name')} hint={t('field.name.hint')} error={errors.name}>
        {(ids) => (
          <Input
            id={ids.inputId}
            aria-describedby={ids.describedBy}
            aria-invalid={ids.invalid || undefined}
            name="name"
            value={draft.name}
            maxLength={80}
            placeholder={draft.repo || undefined}
            onChange={(e) => update('name', e.target.value)}
          />
        )}
      </Field>
    </div>
  );
}

export function EventsStep({ draft, errors, update }: StepProps) {
  return (
    <EventPicker
      value={draft.eventTypes}
      error={errors.eventTypes}
      onChange={(next: GithubEventType[]) => update('eventTypes', next)}
    />
  );
}

interface ReviewStepProps {
  readonly draft: Draft;
  readonly onEdit: (field: WizardField) => void;
}

function ReviewRow({
  label,
  field,
  onEdit,
  children,
}: {
  label: string;
  field: WizardField;
  onEdit: (field: WizardField) => void;
  children: ReactNode;
}) {
  return (
    <div className="review-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
      <dd className="review-edit">
        <button
          type="button"
          className="btn btn-ghost"
          aria-label={t('wizard.review.editLabel', { field: label })}
          onClick={() => onEdit(field)}
        >
          {t('wizard.review.edit')}
        </button>
      </dd>
    </div>
  );
}

/** A summary that never shows the URL or secret back, only that they were provided. */
export function ReviewStep({ draft, onEdit }: ReviewStepProps) {
  const destination = draft.destination ? t(DESTINATIONS[draft.destination].name) : '';
  return (
    <div className="review">
      <p>{t('wizard.review.intro')}</p>
      <dl className="review-list">
        <ReviewRow label={t('integration.destination')} field="destination" onEdit={onEdit}>
          {destination}
        </ReviewRow>
        <ReviewRow label={t('wizard.review.webhook')} field="webhookUrl" onEdit={onEdit}>
          {t('wizard.review.webhookValue')}
        </ReviewRow>
        {draft.destination === 'lark' && (
          <ReviewRow label={t('wizard.review.secret')} field="signingSecret" onEdit={onEdit}>
            {t(draft.signingSecret ? 'wizard.review.secretValue' : 'wizard.review.secretNone')}
          </ReviewRow>
        )}
        <ReviewRow label={t('field.repo')} field="repo" onEdit={onEdit}>
          <span className="mono-wrap">{draft.repo}</span>
        </ReviewRow>
        <ReviewRow label={t('field.nameRequired')} field="name" onEdit={onEdit}>
          {draft.name.trim() || draft.repo}
        </ReviewRow>
        <ReviewRow label={t('field.events')} field="eventTypes" onEdit={onEdit}>
          <EventList eventTypes={draft.eventTypes} />
        </ReviewRow>
      </dl>
    </div>
  );
}
