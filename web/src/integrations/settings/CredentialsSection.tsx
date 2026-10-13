import { useRef, useState, type FormEvent } from 'react';
import { IconKey } from '@tabler/icons-react';
import { focusFirstInvalid } from '../../components/form';
import { Badge, Button, Notice } from '../../components/ui';
import type { Integration } from '../../lib/api';
import { t } from '../../i18n';
import { CredentialsNotice } from '../CredentialsNotice';
import { DESTINATIONS } from '../destinations';
import { fieldErrorsOf, formLevelError } from '../errors';
import { useRotateCredentials } from '../hooks';
import {
  compact,
  fromServer,
  validateSigningSecret,
  validateWebhookUrl,
  type FieldErrors,
} from '../validation';
import { WebhookFields, WebhookGuide } from '../WebhookFields';
import { useLocale } from '../../i18n/LocaleProvider';

interface CredentialsSectionProps {
  readonly orgId: string;
  readonly integration: Integration;
}

const STATE_BADGE = { ok: 'success', legacy: 'warning', quarantined: 'danger' } as const;
const STATE_LABEL = {
  ok: 'settings.credentials.stateOk',
  legacy: 'settings.credentials.stateLegacy',
  quarantined: 'settings.credentials.stateQuarantined',
} as const;

/**
 * Credential rotation is a separate, explicit action (F211/F217). The stored URL is never
 * shown; the only operation is to replace it, which discards the old key material.
 */
export function CredentialsSection({ orgId, integration }: CredentialsSectionProps) {
  useLocale();
  const rotate = useRotateCredentials(orgId, integration.id);
  const info = DESTINATIONS[integration.destination];
  const destination = t(info.name);
  const [open, setOpen] = useState(integration.credentials !== 'ok');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [done, setDone] = useState(false);
  const openButton = useRef<HTMLButtonElement>(null);

  const reset = () => {
    setWebhookUrl('');
    setSigningSecret('');
    setErrors({});
  };

  const onChange = (field: 'webhookUrl' | 'signingSecret', value: string) => {
    (field === 'webhookUrl' ? setWebhookUrl : setSigningSecret)(value);
    setErrors((e) => ({ ...e, [field]: undefined }));
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (rotate.isPending) return;
    const found = compact({
      webhookUrl: validateWebhookUrl(webhookUrl, integration.destination),
      signingSecret: info.supportsSigningSecret ? validateSigningSecret(signingSecret) : undefined,
    });
    if (Object.keys(found).length > 0) {
      setErrors(found);
      focusFirstInvalid(form);
      return;
    }
    try {
      await rotate.mutateAsync({
        webhookUrl,
        ...(info.supportsSigningSecret && signingSecret !== '' ? { signingSecret } : {}),
      });
      reset();
      rotate.reset();
      setOpen(false);
      setDone(true);
      requestAnimationFrame(() => openButton.current?.focus());
    } catch (error) {
      setErrors(fromServer(fieldErrorsOf(error)).fields);
      focusFirstInvalid(form);
    }
  };

  const requestError = rotate.isError ? formLevelError(rotate.error) : null;

  return (
    <>
      <dl className="settings-facts">
        <div>
          <dt>{t('settings.credentials.destination')}</dt>
          <dd>{destination}</dd>
        </div>
        <div>
          <dt>{t('settings.credentials.host')}</dt>
          <dd className="mono-wrap">{integration.destinationHost ?? '—'}</dd>
        </div>
        <div>
          <dt>{t('settings.credentials.state')}</dt>
          <dd>
            <Badge variant={STATE_BADGE[integration.credentials]}>
              {t(STATE_LABEL[integration.credentials])}
            </Badge>
          </dd>
        </div>
      </dl>
      <p className="field-hint">{t('settings.credentials.destinationFixed')}</p>
      <CredentialsNotice integration={integration} showFix={false} />
      {done && <Notice kind="success">{t('settings.credentials.saved')}</Notice>}
      {open ? (
        <form className="rotate-form" onSubmit={(e) => void onSubmit(e)} noValidate>
          <p>{t('settings.credentials.replaceIntro', { destination })}</p>
          <WebhookGuide destination={integration.destination} />
          <WebhookFields
            destination={integration.destination}
            webhookUrl={webhookUrl}
            signingSecret={signingSecret}
            errors={errors}
            onChange={onChange}
            secretHint="field.signingSecret.rotateHint"
          />
          {requestError && (
            <Notice kind="error">
              <p>{requestError.message}</p>
              {requestError.reference && <p className="error-reference">{requestError.reference}</p>}
            </Notice>
          )}
          <div className="form-actions">
            <Button type="submit" aria-disabled={rotate.isPending || undefined}>
              {rotate.isPending ? t('settings.saving') : t('settings.credentials.save')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                reset();
                setOpen(false);
                requestAnimationFrame(() => openButton.current?.focus());
              }}
            >
              {t('wizard.cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <Button
          ref={openButton}
          type="button"
          variant="outline"
          onClick={() => {
            setDone(false);
            setOpen(true);
          }}
        >
          <IconKey size={18} aria-hidden="true" />
          {t('settings.credentials.replace')}
        </Button>
      )}
    </>
  );
}
