import { useRef, useState, type FormEvent } from 'react';
import { IconAlertCircle } from '@tabler/icons-react';
import { Field, focusFirstInvalid } from '../components/form';
import { Button, Input, Notice } from '../components/ui';
import { t } from '../i18n';
import { DESTINATION_ORDER, DESTINATIONS } from '../integrations/destinations';
import { describeError, fieldErrorsOf } from '../integrations/errors';
import { fromServer } from '../integrations/validation';
import { WebhookFields, WebhookGuide } from '../integrations/WebhookFields';
import type { DestinationKind } from '../lib/api';
import type { Source } from './api';
import { eventCatalog, eventLabelId } from './providers';
import {
  defaultChatName,
  toConnectBody,
  validateConnect,
  type ConnectDraft,
  type ConnectErrors,
} from './connect';
import { useConnectChat } from './hooks';
import { useLocale } from '../i18n/LocaleProvider';

const EMPTY = (): ConnectDraft => ({
  destination: null,
  name: '',
  webhookUrl: '',
  signingSecret: '',
  eventTypes: [],
});

/** Connect one chat to a source: pick the app, paste its webhook URL, name it, done. */
export function ConnectChat({ orgId, source }: { readonly orgId: string; readonly source: Source }) {
  useLocale();
  const connect = useConnectChat(orgId);
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<ConnectDraft>(EMPTY);
  const [errors, setErrors] = useState<ConnectErrors>({});
  const [done, setDone] = useState<DestinationKind | null>(null);
  const catalog = eventCatalog(source.kind);
  const toggleEvent = (type: string) =>
    setDraft((d) => {
      const current = d.eventTypes ?? [];
      return {
        ...d,
        eventTypes: current.includes(type) ? current.filter((x) => x !== type) : [...current, type],
      };
    });

  const pick = (destination: DestinationKind) =>
    setDraft((d) => ({
      ...d,
      destination,
      // Keep a name the person typed; replace only an untouched default.
      name:
        d.name === '' || d.name === defaultChatName(source.name, d.destination ?? destination)
          ? defaultChatName(source.name, destination)
          : d.name,
      signingSecret: DESTINATIONS[destination].supportsSigningSecret ? d.signingSecret : '',
    }));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (connect.isPending) return;
    const found = validateConnect(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      focusFirstInvalid(formRef.current);
      return;
    }
    const body = toConnectBody(source.id, draft);
    if (!body) return;
    try {
      await connect.mutateAsync(body);
      setDone(body.destination);
      // Credentials are write-only: nothing typed is kept once saved.
      setDraft(EMPTY());
    } catch (error) {
      setErrors(fromServer(fieldErrorsOf(error)).fields);
      focusFirstInvalid(formRef.current);
    }
  };

  const failure = connect.isError ? describeError(connect.error) : null;
  return (
    <details className="source-details">
      <summary>{t('sources.chat.summary')}</summary>
      <div className="source-details-body">
        <p>{t('sources.chat.intro')}</p>
        {done && (
          <Notice kind="success">
            {t('sources.chat.done', { name: source.name, destination: t(DESTINATIONS[done].name) })}
          </Notice>
        )}
        <form ref={formRef} className="form-stack" noValidate onSubmit={(e) => void onSubmit(e)}>
          <fieldset className="destination-choice">
            <legend className="field-label">{t('sources.chat.destination')}</legend>
            {errors.destination && (
              <p className="field-error" role="alert">
                <IconAlertCircle size={18} aria-hidden="true" />
                <span>{errors.destination}</span>
              </p>
            )}
            <div className="destination-options">
              {DESTINATION_ORDER.map((kind) => (
                <label key={kind} className="destination-option">
                  <input
                    type="radio"
                    name={`destination-${source.id}`}
                    value={kind}
                    checked={draft.destination === kind}
                    aria-invalid={errors.destination ? true : undefined}
                    data-invalid={errors.destination ? '' : undefined}
                    onChange={() => pick(kind)}
                  />
                  <span className="destination-option-body">
                    <span className="destination-option-name">{t(DESTINATIONS[kind].name)}</span>
                    <span className="destination-option-where">{t(DESTINATIONS[kind].where)}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {catalog.length > 0 && (
            <fieldset className="destination-choice">
              <legend className="field-label">{t('sources.events.legend')}</legend>
              <p className="field-hint">{t('sources.events.hint')}</p>
              <div className="destination-options">
                {catalog.map((type) => (
                  <label key={type} className="destination-option">
                    <input
                      type="checkbox"
                      checked={(draft.eventTypes ?? []).includes(type)}
                      onChange={() => toggleEvent(type)}
                    />
                    <span className="destination-option-body">
                      <span className="destination-option-name">{t(eventLabelId(type))}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {draft.destination && (
            <>
              <WebhookGuide destination={draft.destination} />
              <WebhookFields
                destination={draft.destination}
                webhookUrl={draft.webhookUrl}
                signingSecret={draft.signingSecret}
                errors={errors}
                onChange={(field, value) => setDraft((d) => ({ ...d, [field]: value }))}
              />
              <Field label={t('sources.chat.name')} hint={t('sources.chat.nameHint')} error={errors.name}>
                {(ids) => (
                  <Input
                    id={ids.inputId}
                    aria-describedby={ids.describedBy}
                    aria-invalid={ids.invalid || undefined}
                    value={draft.name}
                    maxLength={80}
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                  />
                )}
              </Field>
            </>
          )}
          {failure && (
            <Notice kind="error">
              <p className="notice-title">{t('sources.chat.failed')}</p>
              <p>{failure.message}</p>
              {failure.reference && <p className="error-reference">{failure.reference}</p>}
            </Notice>
          )}
          <div className="form-actions">
            <Button type="submit" aria-disabled={connect.isPending || undefined}>
              {connect.isPending ? t('sources.chat.submitting') : t('sources.chat.submit')}
            </Button>
          </div>
        </form>
      </div>
    </details>
  );
}
