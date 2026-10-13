import { useState, type FormEvent } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { focusFirstInvalid } from '../../components/form';
import { Button, Notice } from '../../components/ui';
import type { Integration } from '../../lib/api';
import { t } from '../../i18n';
import { fieldErrorsOf, formLevelError } from '../errors';
import { useUpdateIntegration } from '../hooks';
import { FilterTester } from '../filters/FilterTester';
import { FiltersEditor } from '../filters/FiltersEditor';
import { RoutingLog } from '../filters/RoutingLog';
import {
  coverageNotes,
  draftFromConfig,
  EMPTY_FILTER_DRAFT,
  errorsFromServer,
  validateFilterDraft,
  type FilterDraft,
  type FilterErrors,
} from '../filters/model';

/**
 * Routing filters for one integration (ADR 0010). Saved on their own, like the other sections,
 * and replaced as a whole: what is on screen is what is stored. The "Try it" check and the
 * recent-decisions list sit beside the controls so a change can be tested and then watched.
 *
 * When the stored filters cannot be read, updates are being held back. Nothing can be saved
 * until the person has chosen "Replace invalid filters", so the old (unreadable) rules are never
 * silently overwritten by an empty form.
 */
export function FiltersSection({ orgId, integration }: { orgId: string; integration: Integration }) {
  const save = useUpdateIntegration(orgId, integration.id);
  const saved = draftFromConfig(integration.filters);
  const [draft, setDraft] = useState<FilterDraft>(saved);
  const [errors, setErrors] = useState<FilterErrors>({});
  const [done, setDone] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const blocked = integration.filtersInvalid && !replacing;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  // An invalid stored document is replaced even by an empty form, once the person has opted in.
  const canSave = dirty || (integration.filtersInvalid && replacing);
  const checked = validateFilterDraft(draft, integration.eventTypes);
  const notes = coverageNotes(checked.ok ? checked.config : {}, integration.eventTypes);

  useBlocker({
    shouldBlockFn: () => dirty && !window.confirm(t('settings.leaveConfirm')),
    enableBeforeUnload: () => dirty,
  });

  const change: Parameters<typeof FiltersEditor>[0]['onChange'] = (field, value) => {
    setDraft((d) => ({ ...d, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined, form: undefined }));
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
      const next = await save.mutateAsync({ filters: checked.config });
      setDraft(draftFromConfig(next.filters));
      setReplacing(false);
      setDone(true);
    } catch (error) {
      setErrors(errorsFromServer(fieldErrorsOf(error), draft));
      focusFirstInvalid(form);
    }
  };

  const requestError = save.isError ? formLevelError(save.error) : null;
  const serverShown = save.isError && Object.keys(errors).length > 0;

  return (
    <>
      <p>{t('filters.intro')}</p>
      <p className="field-hint">{t('filters.honest')}</p>
      {integration.filtersNewer && (
        <Notice kind="warning">
          <p>
            <strong>{t('filters.newer.title')}</strong>
          </p>
          <p>{t('filters.newer.body')}</p>
        </Notice>
      )}
      {integration.filtersInvalid && (
        <Notice kind="error">
          <p>
            <strong>{t('filters.invalidStored.title')}</strong>
          </p>
          <p>{t('filters.invalidStored.body')}</p>
          {!replacing && (
            <Button
              variant="outline"
              onClick={() => {
                setDraft(EMPTY_FILTER_DRAFT);
                setReplacing(true);
              }}
            >
              {t('filters.replaceInvalid')}
            </Button>
          )}
        </Notice>
      )}
      {!blocked && (
        <>
          <form className="form-stack" onSubmit={(e) => void onSubmit(e)} noValidate>
            <FiltersEditor draft={draft} errors={errors} onChange={change} notes={notes} />
            {requestError && !serverShown && (
              <Notice kind="error">
                <p>{requestError.message}</p>
                {requestError.reference && <p className="error-reference">{requestError.reference}</p>}
              </Notice>
            )}
            {done && <Notice kind="success">{t('filters.saved')}</Notice>}
            <div className="form-actions">
              <Button type="submit" aria-disabled={save.isPending || !canSave || undefined}>
                {save.isPending ? t('filters.saving') : t('filters.save')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setDraft(EMPTY_FILTER_DRAFT);
                  setErrors({});
                  setDone(false);
                }}
              >
                {t('filters.clear')}
              </Button>
              <span className="form-actions-note" role="status">
                {dirty ? t('filters.unsaved') : ''}
              </span>
            </div>
          </form>
          <FilterTester config={checked.ok ? checked.config : null} />
        </>
      )}
      <RoutingLog orgId={orgId} integrationId={integration.id} />
    </>
  );
}
