import { useState } from 'react';
import { Input } from './ui';
import { useLocale } from '../i18n/LocaleProvider';

export interface TextFilterProps {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly invalidMessage: string;
  readonly value: string;
  readonly isValid: (value: string) => boolean;
  readonly onCommit: (value: string) => void;
}

/**
 * A free-text filter that asks the server once a value is settled (Enter or leaving the field), not on
 * every keystroke. An id that cannot be valid is flagged and never sent. It is remounted (keyed) when
 * the URL changes the value, so a "show events about this" click is reflected in the field.
 */
export function TextFilter({ id, label, hint, invalidMessage, value, isValid, onCommit }: TextFilterProps) {
  useLocale();
  const [draft, setDraft] = useState(value);
  const trimmed = draft.trim();
  const invalid = trimmed !== '' && !isValid(trimmed);
  const commit = () => {
    if (trimmed === value) return;
    if (trimmed === '' || isValid(trimmed)) onCommit(trimmed);
  };
  return (
    <div className="filter">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        type="text"
        value={draft}
        autoComplete="off"
        spellCheck={false}
        maxLength={200}
        aria-invalid={invalid || undefined}
        aria-describedby={`${id}-hint`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      <p id={`${id}-hint`} className={invalid ? 'field-error' : 'field-hint'}>
        {invalid ? invalidMessage : hint}
      </p>
    </div>
  );
}
