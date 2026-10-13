import { IconAlertCircle, IconExternalLink, IconLock } from '@tabler/icons-react';
import { Field, SecretInput } from '../components/form';
import type { DestinationKind } from '../lib/api';
import { t, type MessageId } from '../i18n';
import { DESTINATIONS } from './destinations';
import type { FieldErrors } from './validation';
import { useLocale } from '../i18n/LocaleProvider';

/** Numbered, provider-specific steps with the official guide as the fallback (F212). */
export function WebhookGuide({ destination }: { destination: DestinationKind }) {
  useLocale();
  const info = DESTINATIONS[destination];
  return (
    <section className="guide" aria-labelledby={`guide-${destination}`}>
      <h3 id={`guide-${destination}`}>{t('destination.guideTitle')}</h3>
      <ol className="guide-steps">
        {info.steps.map((step) => (
          <li key={step}>{t(step)}</li>
        ))}
      </ol>
      {info.notes?.map((note) => (
        <p key={note} className="guide-caveat">
          <IconAlertCircle size={18} aria-hidden="true" />
          <span>{t(note)}</span>
        </p>
      ))}
      <p className="guide-note">
        {t('destination.guideNote')}{' '}
        <a href={info.docsUrl} target="_blank" rel="noopener noreferrer" className="text-link">
          {t(info.docsLabel)}
          <IconExternalLink size={16} aria-hidden="true" />
        </a>
      </p>
    </section>
  );
}

interface WebhookFieldsProps {
  readonly destination: DestinationKind;
  readonly webhookUrl: string;
  readonly signingSecret: string;
  readonly errors: FieldErrors;
  readonly onChange: (field: 'webhookUrl' | 'signingSecret', value: string) => void;
  /** Hint under the signing secret; rotation explains that an empty value turns signing off. */
  readonly secretHint?: MessageId;
}

/**
 * The credential inputs. Values are write-only: they live in component state until submitted
 * and are never pre-filled from the server, which does not return them.
 */
export function WebhookFields({
  destination,
  webhookUrl,
  signingSecret,
  errors,
  onChange,
  secretHint = 'field.signingSecret.hint',
}: WebhookFieldsProps) {
  useLocale();
  const info = DESTINATIONS[destination];
  const urlLabel = t('field.webhookUrl');
  const secretLabel = t('field.signingSecret');
  return (
    <div className="form-stack">
      <Field
        label={urlLabel}
        hint={t(info.urlHint)}
        error={errors.webhookUrl}
        before={
          <p className="secret-warning">
            <IconLock size={18} aria-hidden="true" />
            <span>{t('field.webhookUrl.warning')}</span>
          </p>
        }
      >
        {(ids) => (
          <SecretInput
            ids={ids}
            fieldName={urlLabel}
            name="webhookUrl"
            value={webhookUrl}
            onChange={(e) => onChange('webhookUrl', e.target.value)}
          />
        )}
      </Field>
      {info.supportsSigningSecret && (
        <Field label={secretLabel} hint={t(secretHint)} error={errors.signingSecret}>
          {(ids) => (
            <SecretInput
              ids={ids}
              fieldName={secretLabel}
              name="signingSecret"
              value={signingSecret}
              onChange={(e) => onChange('signingSecret', e.target.value)}
            />
          )}
        </Field>
      )}
    </div>
  );
}
