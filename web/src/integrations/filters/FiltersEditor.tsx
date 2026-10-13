import type { ReactNode } from 'react';
import { Field } from '../../components/form';
import { t } from '../../i18n';
import type { MessageId } from '../../i18n';
import { BOT_MODES } from '../../../../src/routing/filters';
import type { FilterControl, FilterDraft, FilterErrors } from './model';

interface FiltersEditorProps {
  readonly draft: FilterDraft;
  readonly errors: FilterErrors;
  readonly onChange: <K extends keyof FilterDraft>(field: K, value: FilterDraft[K]) => void;
}

type ListField = Exclude<keyof FilterDraft, 'bots' | 'skipDrafts'>;

/** One entry per line. A textarea, because the lists are short, unordered and pasted from elsewhere. */
function LinesField({
  field,
  label,
  hint,
  draft,
  errors,
  onChange,
}: FiltersEditorProps & { field: ListField; label: MessageId; hint: MessageId }) {
  return (
    <Field label={t(label)} hint={t(hint)} error={errors[field as FilterControl]}>
      {(ids) => (
        <textarea
          id={ids.inputId}
          className="input filter-lines"
          aria-describedby={ids.describedBy}
          aria-invalid={ids.invalid || undefined}
          rows={3}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={draft[field]}
          onChange={(e) => onChange(field, e.target.value)}
        />
      )}
    </Field>
  );
}

function Group({ title, hint, children }: { title: MessageId; hint: MessageId; children: ReactNode }) {
  return (
    <fieldset className="filter-group">
      <legend>{t(title)}</legend>
      <p className="field-hint">{t(hint)}</p>
      {children}
    </fieldset>
  );
}

const BOT_LABEL: Readonly<Record<(typeof BOT_MODES)[number], MessageId>> = {
  any: 'filters.bots.any',
  exclude: 'filters.bots.exclude',
  only: 'filters.bots.only',
};

/**
 * The filter controls, shared by the create wizard and the settings page. Every control is a
 * native input with a visible label, a hint and an inline error that is announced, and groups
 * are real fieldsets with legends (F220, F221).
 */
export function FiltersEditor(props: FiltersEditorProps) {
  const { draft, errors, onChange } = props;
  return (
    <div className="filters-editor">
      <Group title="filters.branches.title" hint="filters.branches.hint">
        <LinesField
          {...props}
          field="branchAllow"
          label="filters.branchAllow"
          hint="filters.branchAllow.hint"
        />
        <LinesField {...props} field="branchDeny" label="filters.branchDeny" hint="filters.branchDeny.hint" />
        <p className="field-hint">{t('filters.patternHelp')}</p>
      </Group>

      <Group title="filters.base.title" hint="filters.base.hint">
        <LinesField {...props} field="baseAllow" label="filters.baseAllow" hint="filters.baseAllow.hint" />
        <LinesField {...props} field="baseDeny" label="filters.baseDeny" hint="filters.baseDeny.hint" />
      </Group>

      <Group title="filters.people.title" hint="filters.people.hint">
        <fieldset className="filter-bots" aria-describedby={errors.bots ? 'filter-bots-error' : undefined}>
          <legend className="field-label">{t('filters.bots')}</legend>
          {errors.bots && (
            <p className="field-error" id="filter-bots-error" role="alert">
              {errors.bots}
            </p>
          )}
          <div className="filter-bot-options">
            {BOT_MODES.map((mode) => (
              <label key={mode} className="check">
                <input
                  type="radio"
                  name="filter-bots"
                  value={mode}
                  checked={draft.bots === mode}
                  onChange={() => onChange('bots', mode)}
                />
                <span>{t(BOT_LABEL[mode])}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <LinesField
          {...props}
          field="peopleAllow"
          label="filters.peopleAllow"
          hint="filters.peopleAllow.hint"
        />
        <LinesField {...props} field="peopleDeny" label="filters.peopleDeny" hint="filters.peopleDeny.hint" />
      </Group>

      <Group title="filters.drafts.title" hint="filters.drafts.hint">
        <label className="check">
          <input
            type="checkbox"
            checked={draft.skipDrafts}
            onChange={(e) => onChange('skipDrafts', e.target.checked)}
          />
          <span>{t('filters.drafts.label')}</span>
        </label>
      </Group>

      <Group title="filters.labels.title" hint="filters.labels.hint">
        <LinesField
          {...props}
          field="labelsInclude"
          label="filters.labelsInclude"
          hint="filters.labelsInclude.hint"
        />
        <LinesField
          {...props}
          field="labelsExclude"
          label="filters.labelsExclude"
          hint="filters.labelsExclude.hint"
        />
      </Group>
      {errors.form && (
        <p className="field-error" role="alert">
          {errors.form}
        </p>
      )}
    </div>
  );
}
