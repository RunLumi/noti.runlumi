import { StaleWorkspaceNotice, useBoundWorkspace } from '../../workspace/bound';
import { useRef, useState, type FormEvent } from 'react';
import { IconKey } from '@tabler/icons-react';
import { focusFirstInvalid } from '../../components/form';
import { Badge, Button, Notice } from '../../components/ui';
import type { Integration } from '../../lib/api';
import { t } from '../../i18n';
import { CredentialsNotice } from '../CredentialsNotice';
import { IssuedSecret } from '../IssuedSecret';
import { DESTINATIONS } from '../destinations';
import { fieldErrorsOf, formLevelError } from '../errors';
import { useCanRevoke, useRotateCredentials } from '../hooks';
import {
  compact,
  fromServer,
  validateSigningSecret,
  validateWebhookUrl,
  type FieldErrors,
} from '../validation';
import { WebhookFields, WebhookGuide } from '../WebhookFields';
import { RevokeDialog } from './RevokeDialog';
import { useLocale } from '../../i18n/LocaleProvider';

interface CredentialsSectionProps {
  readonly orgId: string;
  readonly integration: Integration;
}

const STATE_BADGE = { ok: 'success', legacy: 'warning', quarantined: 'danger', revoked: 'danger' } as const;
const STATE_LABEL = {
  ok: 'settings.credentials.stateOk',
  legacy: 'settings.credentials.stateLegacy',
  quarantined: 'settings.credentials.stateQuarantined',
  revoked: 'settings.credentials.stateRevoked',
} as const;

/**
 * Credential rotation is a separate, explicit action (F211/F217). The stored URL is never
 * shown; the only operation is to replace it, which discards the old key material.
 */
export function CredentialsSection({ orgId: liveOrgId, integration }: CredentialsSectionProps) {
  useLocale();
  const ws = useBoundWorkspace(liveOrgId);
  const rotate = useRotateCredentials(ws.orgId, integration.id);
  const canRevoke = useCanRevoke();
  const info = DESTINATIONS[integration.destination];
  const destination = t(info.name);
  const [open, setOpen] = useState(integration.credentials !== 'ok');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [done, setDone] = useState(false);
  const [revokedNow, setRevokedNow] = useState(false);
  // A custom webhook gets a new signing secret with every rotation; shown once, then dropped.
  const [issuedSecret, setIssuedSecret] = useState<string | null>(null);
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
    if (rotate.isPending || ws.stale) return;
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
      const result = await rotate.mutateAsync({
        webhookUrl,
        ...(info.supportsSigningSecret && signingSecret !== '' ? { signingSecret } : {}),
      });
      setIssuedSecret(result.signingSecret);
      setRevokedNow(false);
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
  const state = integration.revoked ? 'revoked' : integration.credentials;
  const onRevoked = () => {
    // The next step is a new URL, so the replace form opens; the announcement says what just happened.
    setDone(false);
    setRevokedNow(true);
    setOpen(true);
  };

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
            <Badge variant={STATE_BADGE[state]}>{t(STATE_LABEL[state])}</Badge>
          </dd>
        </div>
        <div>
          <dt>{t('settings.credentials.fingerprint')}</dt>
          <dd className="mono-wrap">{integration.credentialFingerprint ?? '—'}</dd>
        </div>
        {integration.revoked && (
          <div>
            <dt>{t('settings.credentials.encryptedCopy')}</dt>
            <dd>
              {integration.keyDestroyed
                ? t('settings.credentials.copyDestroyed')
                : t('settings.credentials.copyDestroying')}
            </dd>
          </div>
        )}
      </dl>
      <p className="field-hint">
        {t(
          integration.credentialFingerprint
            ? 'settings.credentials.fingerprintHint'
            : 'settings.credentials.fingerprintNone',
        )}
      </p>
      <p className="field-hint">{t('settings.credentials.destinationFixed')}</p>
      <CredentialsNotice integration={integration} showFix={false} />
      {done && <Notice kind="success">{t('settings.credentials.saved')}</Notice>}
      {revokedNow && !done && <Notice kind="success">{t('revoke.done')}</Notice>}
      {issuedSecret && (
        <IssuedSecret
          name={integration.name}
          secret={issuedSecret}
          kind="rotated"
          doneLabel="integration.secret.saved"
          onDone={() => {
            setIssuedSecret(null);
            requestAnimationFrame(() => openButton.current?.focus());
          }}
        />
      )}
      {open ? (
        <form className="rotate-form" onSubmit={(e) => void onSubmit(e)} noValidate>
          <StaleWorkspaceNotice show={ws.stale} />
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
            <Button type="submit" aria-disabled={rotate.isPending || ws.stale || undefined}>
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
        <div className="form-actions">
          <Button
            ref={openButton}
            type="button"
            variant="outline"
            onClick={() => {
              setDone(false);
              setRevokedNow(false);
              setOpen(true);
            }}
          >
            <IconKey size={18} aria-hidden="true" />
            {t('settings.credentials.replace')}
          </Button>
          {!integration.revoked && canRevoke && (
            <RevokeDialog orgId={ws.orgId} integration={integration} onRevoked={onRevoked} />
          )}
        </div>
      )}
    </>
  );
}
