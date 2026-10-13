import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { IconAlertCircle, IconEye, IconEyeOff } from '@tabler/icons-react';
import { cn } from '../lib/utils';
import { t } from '../i18n';
import { useLocale } from '../i18n/LocaleProvider';

/** The controls a failed submit can move focus to, in document order. */
const INVALID_CONTROL =
  'input[aria-invalid="true"], select[aria-invalid="true"], textarea[aria-invalid="true"], [data-invalid][tabindex]';

/** After a failed submit, focus the first invalid control once it has rendered (F221). */
export function focusFirstInvalid(root: ParentNode | null, framesLeft = 5): void {
  // After an `await`, React may commit a frame or two later; retry briefly until it has.
  requestAnimationFrame(() => {
    const target = root?.querySelector<HTMLElement>(INVALID_CONTROL);
    if (target) target.focus();
    else if (framesLeft > 1) focusFirstInvalid(root, framesLeft - 1);
  });
}

/** Ids that a control needs to reference its hint and its error (WCAG 1.3.1, 3.3.1). */
export interface FieldIds {
  readonly inputId: string;
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
}

interface FieldProps {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly error?: string;
  /** Rendered above the control, e.g. a persistent security warning. */
  readonly before?: ReactNode;
  readonly children: (ids: FieldIds) => ReactNode;
}

/**
 * Label, hint, control and inline error, wired together. The error is linked with
 * `aria-describedby` and announced, so it is reported next to the field it concerns rather
 * than in a page-level banner (F220).
 */
export function Field({ label, hint, error, before, children }: FieldProps) {
  useLocale();
  const base = useId();
  const inputId = base + '-input';
  const hintId = hint ? base + '-hint' : undefined;
  const errorId = error ? base + '-error' : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('field', error && 'field-invalid')}>
      <label className="field-label" htmlFor={inputId}>
        {label}
      </label>
      {before}
      {hint && (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      )}
      {children({ inputId, describedBy, invalid: Boolean(error) })}
      {error && (
        <p className="field-error" id={errorId} role="alert">
          <IconAlertCircle size={18} aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

type SecretInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  readonly ids: FieldIds;
  /** The field's visible name, used to label the show/hide toggle. */
  readonly fieldName: string;
};

/**
 * A credential input (F211): masked by default, never autocompleted, spell-checked or offered
 * to a password manager, and never trimmed on paste — the value is sent exactly as pasted.
 */
export function SecretInput({ ids, fieldName, className, ...props }: SecretInputProps) {
  useLocale();
  const [visible, setVisible] = useState(false);
  return (
    <div className="secret-input">
      <input
        {...props}
        id={ids.inputId}
        aria-describedby={ids.describedBy}
        aria-invalid={ids.invalid || undefined}
        className={cn('input', className)}
        type={visible ? 'text' : 'password'}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        data-1p-ignore=""
        data-lpignore="true"
        data-bwignore=""
      />
      <button
        type="button"
        className="btn btn-outline secret-toggle"
        aria-controls={ids.inputId}
        aria-label={t(visible ? 'field.hideLabel' : 'field.showLabel', { field: fieldName })}
        onClick={() => setVisible((v) => !v)}
      >
        {visible ? <IconEyeOff size={20} aria-hidden="true" /> : <IconEye size={20} aria-hidden="true" />}
        <span className="secret-toggle-text">{t(visible ? 'field.hide' : 'field.show')}</span>
      </button>
    </div>
  );
}
