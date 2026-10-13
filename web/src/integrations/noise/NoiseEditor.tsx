import type { ReactNode } from 'react';
import { Field } from '../../components/form';
import { t, type MessageId } from '../../i18n';
import { useLocale } from '../../i18n/LocaleProvider';
import { DIGEST_MODES } from '../../../../src/routing/noise';
import { GROUP_WINDOW_CHOICES, type NoiseDraft, type NoiseErrors } from './model';

interface NoiseEditorProps {
  readonly draft: NoiseDraft;
  readonly errors: NoiseErrors;
  readonly onChange: <K extends keyof NoiseDraft>(field: K, value: NoiseDraft[K]) => void;
  /** A source integration has no workflow runs, so resolved notices are not offered. */
  readonly isSource: boolean;
  /** Resolved notices cannot work with the selected updates (no failing runs among them). */
  readonly resolutionBlocked: boolean;
  readonly timeZones: readonly string[];
}

function Group({ title, hint, children }: { title: MessageId; hint: MessageId; children: ReactNode }) {
  useLocale();
  return (
    <fieldset className="filter-group noise-group">
      <legend>{t(title)}</legend>
      <p className="field-hint">{t(hint)}</p>
      {children}
    </fieldset>
  );
}

const DIGEST_LABEL: Readonly<Record<(typeof DIGEST_MODES)[number], MessageId>> = {
  off: 'noise.digest.off',
  hourly: 'noise.digest.hourly',
  daily: 'noise.digest.daily',
};

/**
 * The noise controls. Every control is a native input with a visible label, a hint and an inline
 * error that is announced; groups are real fieldsets with legends (F220, F221). Times are
 * `<input type="time">`, which gives phones and keyboards their own accessible pickers and
 * always yields the `HH:MM` the server expects.
 */
export function NoiseEditor({
  draft,
  errors,
  onChange,
  isSource,
  resolutionBlocked,
  timeZones,
}: NoiseEditorProps) {
  useLocale();
  return (
    <div className="filters-editor noise-editor">
      <Group title="noise.quiet.title" hint="noise.quiet.hint">
        <label className="check">
          <input
            type="checkbox"
            checked={draft.quietOn}
            onChange={(e) => onChange('quietOn', e.target.checked)}
          />
          <span>{t('noise.quiet.enable')}</span>
        </label>
        {draft.quietOn && <p className="field-hint">{t('noise.quiet.midnight')}</p>}
        {draft.quietOn && (
          <div className="noise-times">
            <Field label={t('noise.quiet.start')} error={errors.quietStart}>
              {(ids) => (
                <input
                  id={ids.inputId}
                  className="input"
                  type="time"
                  step={60}
                  aria-describedby={ids.describedBy}
                  aria-invalid={ids.invalid || undefined}
                  value={draft.quietStart}
                  onChange={(e) => onChange('quietStart', e.target.value)}
                />
              )}
            </Field>
            <Field label={t('noise.quiet.end')} error={errors.quietEnd}>
              {(ids) => (
                <input
                  id={ids.inputId}
                  className="input"
                  type="time"
                  step={60}
                  aria-describedby={ids.describedBy}
                  aria-invalid={ids.invalid || undefined}
                  value={draft.quietEnd}
                  onChange={(e) => onChange('quietEnd', e.target.value)}
                />
              )}
            </Field>
          </div>
        )}
      </Group>

      <Group title="noise.group.title" hint="noise.group.hint">
        <Field label={t('noise.group.label')}>
          {(ids) => (
            <select
              id={ids.inputId}
              className="input"
              value={draft.groupWindowSec}
              onChange={(e) =>
                onChange(
                  'groupWindowSec',
                  GROUP_WINDOW_CHOICES.find((c) => String(c.value) === e.target.value)?.value ?? 0,
                )
              }
            >
              {GROUP_WINDOW_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {t(choice.label)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </Group>

      <Group title="noise.digest.title" hint="noise.digest.hint">
        <Field label={t('noise.digest.label')}>
          {(ids) => (
            <select
              id={ids.inputId}
              className="input"
              value={draft.digest}
              onChange={(e) => onChange('digest', DIGEST_MODES.find((m) => m === e.target.value) ?? 'off')}
            >
              {DIGEST_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(DIGEST_LABEL[mode])}
                </option>
              ))}
            </select>
          )}
        </Field>
        {draft.digest === 'daily' && (
          <Field label={t('noise.digest.at')} error={errors.digestAt}>
            {(ids) => (
              <input
                id={ids.inputId}
                className="input"
                type="time"
                step={60}
                aria-describedby={ids.describedBy}
                aria-invalid={ids.invalid || undefined}
                value={draft.digestAt}
                onChange={(e) => onChange('digestAt', e.target.value)}
              />
            )}
          </Field>
        )}
      </Group>

      <Field label={t('noise.timezone')} hint={t('noise.timezone.hint')} error={errors.timezone}>
        {(ids) => (
          <select
            id={ids.inputId}
            className="input"
            aria-describedby={ids.describedBy}
            aria-invalid={ids.invalid || undefined}
            value={draft.timezone}
            onChange={(e) => onChange('timezone', e.target.value)}
          >
            {timeZones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        )}
      </Field>

      {!isSource && (
        <Group title="noise.resolution.title" hint="noise.resolution.hint">
          <label className="check">
            <input
              type="checkbox"
              checked={draft.resolution}
              disabled={resolutionBlocked && !draft.resolution}
              aria-invalid={errors.resolution ? true : undefined}
              aria-describedby={errors.resolution || resolutionBlocked ? 'noise-resolution-note' : undefined}
              onChange={(e) => onChange('resolution', e.target.checked)}
            />
            <span>{t('noise.resolution.label')}</span>
          </label>
          {(resolutionBlocked || errors.resolution) && (
            <p
              id="noise-resolution-note"
              className={errors.resolution ? 'field-error' : 'field-hint'}
              role={errors.resolution ? 'alert' : undefined}
            >
              {errors.resolution ?? t('noise.resolution.needsFailures')}
            </p>
          )}
        </Group>
      )}

      {errors.form && (
        <p className="field-error" role="alert">
          {errors.form}
        </p>
      )}
    </div>
  );
}
