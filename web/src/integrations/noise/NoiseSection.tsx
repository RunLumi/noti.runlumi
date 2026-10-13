import { useMemo, useState, type FormEvent } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { focusFirstInvalid } from '../../components/form';
import { Button, Notice } from '../../components/ui';
import type { Integration } from '../../lib/api';
import { t, tp } from '../../i18n';
import { formatDateTime } from '../../i18n/format';
import { fieldErrorsOf, formLevelError } from '../errors';
import { useUpdateIntegration } from '../hooks';
import { useLocale } from '../../i18n/LocaleProvider';
import { noiseStatusKey, useNoiseStatus } from './hooks';
import { NoiseEditor } from './NoiseEditor';
import {
  describeNoise,
  draftFromSettings,
  emptyNoiseDraft,
  errorsFromIssues,
  resolutionBlocked,
  timeZoneChoices,
  validateNoiseDraft,
  type NoiseDraft,
  type NoiseErrors,
} from './model';
import './noise.css';

/** How many updates are waiting and when the next send is due; never a black hole. */
function HeldStatus({ orgId, integrationId }: { orgId: string; integrationId: string }) {
  useLocale();
  const status = useNoiseStatus(orgId, integrationId);
  return (
    <section className="noise-status" aria-labelledby="noise-status-title">
      <h3 id="noise-status-title">{t('noise.status.title')}</h3>
      {status.isPending ? (
        <p role="status">{t('noise.status.loading')}</p>
      ) : status.isError ? (
        <p>{t('noise.status.error')}</p>
      ) : status.data.count === 0 ? (
        <p>{t('noise.status.none')}</p>
      ) : (
        <p>
          {tp('noise.status.waiting', status.data.count, {
            when: status.data.nextReleaseAt ? formatDateTime(status.data.nextReleaseAt) : '–',
          })}
        </p>
      )}
    </section>
  );
}

/**
 * Quiet hours, combining, summaries and resolved notices for one integration (ADR 0016). Saved on
 * its own like the other sections and replaced as a whole. The sentences under the controls come
 * from the server's own decision function, so the preview is what ingress will do.
 *
 * When the stored settings cannot be read, updates are being sent normally (the safe direction),
 * and saving simply replaces them.
 */
export function NoiseSection({ orgId, integration }: { orgId: string; integration: Integration }) {
  useLocale();
  const save = useUpdateIntegration(orgId, integration.id);
  const queryClient = useQueryClient();
  const isSource = integration.sourceId !== null;
  const saved = useMemo(() => draftFromSettings(integration.noise), [integration.noise]);
  // `null` until the person edits; the form then shows what is saved, and follows it when the
  // integration is refetched, instead of holding a stale copy.
  const [edits, setEdits] = useState<NoiseDraft | null>(null);
  const draft = edits ?? saved;
  const [errors, setErrors] = useState<NoiseErrors>({});
  const [done, setDone] = useState(false);
  const dirty = edits !== null && JSON.stringify(edits) !== JSON.stringify(saved);
  const unreadable = integration.noiseInvalid || integration.noiseNewer;
  const canSave = dirty || unreadable;
  const checked = validateNoiseDraft(draft, integration.eventTypes, isSource);
  const timeZones = useMemo(() => timeZoneChoices(draft.timezone), [draft.timezone]);
  const blocked = !isSource && resolutionBlocked(integration.eventTypes);

  useBlocker({
    shouldBlockFn: () => dirty && !window.confirm(t('settings.leaveConfirm')),
    enableBeforeUnload: () => dirty,
  });

  const change: NoiseEditorChange = (field, value) => {
    setEdits({ ...draft, [field]: value });
    setErrors({});
    setDone(false);
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (save.isPending || !canSave) return;
    if (!checked.ok) {
      setErrors(checked.errors);
      focusFirstInvalid(form);
      return;
    }
    try {
      await save.mutateAsync({ noise: checked.settings });
      setEdits(null);
      setDone(true);
      void queryClient.invalidateQueries({ queryKey: noiseStatusKey(orgId, integration.id) });
    } catch (error) {
      setErrors(errorsFromIssues(fieldErrorsOf(error), draft));
      focusFirstInvalid(form);
    }
  };

  const requestError = save.isError ? formLevelError(save.error) : null;
  const serverShown = save.isError && Object.keys(errors).length > 0;
  const preview = describeNoise(checked.ok ? checked.settings : null, isSource);

  return (
    <>
      <p>{t('noise.intro')}</p>
      <p className="field-hint">{t('noise.honest')}</p>
      {integration.noiseInvalid && (
        <Notice kind="warning">
          <p>
            <strong>{t('noise.invalid.title')}</strong>
          </p>
          <p>{t('noise.invalid.body')}</p>
        </Notice>
      )}
      {integration.noiseNewer && (
        <Notice kind="warning">
          <p>
            <strong>{t('noise.newer.title')}</strong>
          </p>
          <p>{t('noise.newer.body')}</p>
        </Notice>
      )}
      <form className="form-stack" onSubmit={(e) => void onSubmit(e)} noValidate>
        <NoiseEditor
          draft={draft}
          errors={errors}
          onChange={change}
          isSource={isSource}
          resolutionBlocked={blocked}
          timeZones={timeZones}
        />
        <section className="noise-preview" aria-labelledby="noise-preview-title">
          <h3 id="noise-preview-title">{t('noise.preview.title')}</h3>
          <ul>
            {preview.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
        {requestError && !serverShown && (
          <Notice kind="error">
            <p>{requestError.message}</p>
            {requestError.reference && <p className="error-reference">{requestError.reference}</p>}
          </Notice>
        )}
        {done && <Notice kind="success">{t('noise.saved')}</Notice>}
        <div className="form-actions">
          <Button type="submit" aria-disabled={save.isPending || !canSave || undefined}>
            {save.isPending ? t('noise.saving') : t('noise.save')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setEdits(emptyNoiseDraft(draft.timezone));
              setErrors({});
              setDone(false);
            }}
          >
            {t('noise.clear')}
          </Button>
          <span className="form-actions-note" role="status">
            {dirty ? t('noise.unsaved') : ''}
          </span>
        </div>
      </form>
      <HeldStatus orgId={orgId} integrationId={integration.id} />
    </>
  );
}

type NoiseEditorChange = Parameters<typeof NoiseEditor>[0]['onChange'];
