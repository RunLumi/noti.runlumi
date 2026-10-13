import { useEffect, useRef } from 'react';
import { IconKey } from '@tabler/icons-react';
import { Button, Notice } from '../components/ui';
import { t } from '../i18n';
import { CopyButton } from '../sources/CopyButton';
import '../sources/sources.css';

interface IssuedSecretProps {
  readonly name: string;
  readonly secret: string;
  readonly kind: 'created' | 'rotated';
  /** Label of the button that dismisses the secret and moves on. */
  readonly doneLabel: 'integration.secret.saved' | 'integration.secret.continue';
  readonly onDone: () => void;
}

/**
 * A custom webhook's signing secret, shown once. It lives only in the parent's state:
 * dismissing (or leaving the page) discards it, and Noti cannot show it again. Same behaviour
 * and styling as a source's secret (`sources/SecretReveal.tsx`), with this destination's copy.
 * Focus moves here when it appears so keyboard and screen-reader users land on it.
 */
export function IssuedSecret({ name, secret, kind, doneLabel, onDone }: IssuedSecretProps) {
  const region = useRef<HTMLElement>(null);
  useEffect(() => region.current?.focus(), []);
  return (
    <section ref={region} tabIndex={-1} className="secret-reveal" aria-labelledby="issued-secret-title">
      <h2 id="issued-secret-title" className="secret-reveal-title">
        <IconKey size={20} aria-hidden="true" />
        {t(kind === 'created' ? 'integration.secret.created.title' : 'integration.secret.rotated.title', {
          name,
        })}
      </h2>
      <Notice kind="warning">
        <p>{t('integration.secret.warning')}</p>
        {kind === 'rotated' && <p>{t('integration.secret.rotatedNote')}</p>}
      </Notice>
      <label className="field-label" htmlFor="issued-secret-value">
        {t('integration.secret.label')}
      </label>
      <input
        id="issued-secret-value"
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
        <Button type="button" onClick={onDone}>
          {t(doneLabel)}
        </Button>
      </div>
    </section>
  );
}
