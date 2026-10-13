import { forwardRef, useId } from 'react';
import { IconAlertCircle } from '@tabler/icons-react';
import { t, tp } from '../i18n';
import { EVENT_GROUPS, EVENT_LABEL, sortEvents, type EventGroup, type GithubEventType } from './events';

interface EventPickerProps {
  readonly value: readonly GithubEventType[];
  readonly onChange: (next: GithubEventType[]) => void;
  readonly error?: string;
}

function GroupFieldset({
  group,
  selected,
  onChange,
}: {
  group: EventGroup;
  selected: ReadonlySet<GithubEventType>;
  onChange: (next: GithubEventType[]) => void;
}) {
  const hintId = useId();
  const allOn = group.events.every((e) => selected.has(e));
  const groupName = t(group.label);
  const toggle = (event: GithubEventType, on: boolean) =>
    onChange(sortEvents(on ? [...selected, event] : [...selected].filter((e) => e !== event)));
  const setAll = (on: boolean) =>
    onChange(
      sortEvents(
        on
          ? [...new Set([...selected, ...group.events])]
          : [...selected].filter((e) => !group.events.includes(e)),
      ),
    );
  return (
    <fieldset className="event-group" aria-describedby={group.hint ? hintId : undefined}>
      <div className="event-group-head">
        <legend>{groupName}</legend>
        {group.events.length > 1 && (
          <button
            type="button"
            className="btn btn-ghost event-group-all"
            aria-label={t(allOn ? 'field.events.clearAllLabel' : 'field.events.selectAllLabel', {
              group: groupName,
            })}
            onClick={() => setAll(!allOn)}
          >
            {t(allOn ? 'field.events.clearAll' : 'field.events.selectAll')}
          </button>
        )}
      </div>
      {group.hint && (
        <p className="field-hint" id={hintId}>
          {t(group.hint)}
        </p>
      )}
      <ul className="event-options">
        {group.events.map((event) => (
          <li key={event}>
            <label className="check">
              <input
                type="checkbox"
                checked={selected.has(event)}
                onChange={(e) => toggle(event, e.target.checked)}
              />
              <span>{t(EVENT_LABEL[event])}</span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

/**
 * The closed GitHub catalog, grouped and labelled in plain language. The outer fieldset is the
 * focus target when the selection is invalid, and its error is announced (F220, F221).
 */
export const EventPicker = forwardRef<HTMLFieldSetElement, EventPickerProps>(function EventPicker(
  { value, onChange, error },
  ref,
) {
  const base = useId();
  const selected = new Set(value);
  const describedBy = [error ? base + '-error' : '', base + '-hint', base + '-count']
    .filter(Boolean)
    .join(' ');
  return (
    <fieldset
      ref={ref}
      tabIndex={-1}
      className="event-picker"
      aria-describedby={describedBy}
      data-invalid={error ? '' : undefined}
    >
      <legend className="field-label">{t('field.events')}</legend>
      <p className="field-hint" id={base + '-hint'}>
        {t('field.events.hint')}
      </p>
      {error && (
        <p className="field-error" id={base + '-error'} role="alert">
          <IconAlertCircle size={18} aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
      <div className="event-groups">
        {EVENT_GROUPS.map((group) => (
          <GroupFieldset key={group.id} group={group} selected={selected} onChange={onChange} />
        ))}
      </div>
      <p className="event-count" id={base + '-count'} role="status">
        {tp('field.events.selected', value.length)}
      </p>
    </fieldset>
  );
});
