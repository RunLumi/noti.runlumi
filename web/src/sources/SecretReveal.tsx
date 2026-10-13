import { useEffect, useRef } from 'react';
import { IconKey } from '@tabler/icons-react';
import { Button, Notice } from '../components/ui';
import { t } from '../i18n';
import { CopyButton } from './CopyButton';
import { useLocale } from '../i18n/LocaleProvider';

interface SecretRevealProps {
  readonly sourceName: string;
  readonly secret: string;
  readonly kind: 'created' | 'rotated';
  readonly onDismiss: () => void;
}

/**
 * The one-time secret. It lives only in the parent's state: dismissing (or leaving the page)
 * discards it, and Noti cannot show it again. The warning is persistent text, not a toast.
 * Focus moves here when it appears so keyboard and screen-reader users land on it.
 */
export function SecretReveal({ sourceName, secret, kind, onDismiss }: SecretRevealProps) {
  useLocale();
  const region = useRef<HTMLElement>(null);
  useEffect(() => region.current?.focus(), []);
  return (
    <section ref={region} tabIndex={-1} className="secret-reveal" aria-labelledby="secret-reveal-title">
      <h2 id="secret-reveal-title" className="secret-reveal-title">
        <IconKey size={20} aria-hidden="true" />
        {t(kind === 'created' ? 'sources.secret.created.title' : 'sources.secret.rotated.title', {
          name: sourceName,
        })}
      </h2>
      <Notice kind="warning">
        <p>{t('sources.secret.warning')}</p>
        {kind === 'rotated' && <p>{t('sources.secret.rotatedNote')}</p>}
      </Notice>
      <label className="field-label" htmlFor="secret-reveal-value">
        {t('sources.secret.label')}
      </label>
      <input
        id="secret-reveal-value"
        className="input secret-reveal-value"
        readOnly
        value={secret}
        spellCheck={false}
        autoComplete="off"
        data-1p-ignore=""
        data-lpignore="true"
        onFocus={(e) => e.currentTarget.select()}
      />
      <div className="form-actions">
        <CopyButton
          text={secret}
          label="sources.secret.copy"
          copied="sources.secret.copied"
          failed="sources.secret.copyFailed"
        />
        <Button type="button" onClick={onDismiss}>
          {t('sources.secret.saved')}
        </Button>
      </div>
    </section>
  );
}
