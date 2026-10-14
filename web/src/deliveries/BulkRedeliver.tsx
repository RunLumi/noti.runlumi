import { useEffect, useId, useRef, useState } from 'react';
import { IconRepeat } from '@tabler/icons-react';
import { Button, Input, Notice } from '../components/ui';
import { t, tp } from '../i18n';
import { useLocale } from '../i18n/LocaleProvider';
import { ApiError } from '../lib/api';
import type { BulkPlan, BulkScope } from './api';
import { describeDeliveryError } from './copy';
import { useBulkPlan, useBulkReplay } from './hooks';

interface BulkRedeliverProps {
  readonly orgId: string;
  /** What the log is filtered to; the replay uses exactly this scope. */
  readonly scope: BulkScope;
  /** Name of the filtered integration, when there is one. */
  readonly integrationName: string | null;
}

/**
 * "Redeliver all failed" (F182): count first, then ask, then send. The count comes from the server
 * and binds the exact set shown; if the backlog changed meanwhile the server refuses and nothing is
 * sent. Above the threshold the person types the number. Not optimistic.
 */
export function BulkRedeliver({ orgId, scope, integrationName }: BulkRedeliverProps) {
  useLocale();
  const plan = useBulkPlan(orgId);
  const run = useBulkReplay(orgId);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const startRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const counted: BulkPlan | undefined = plan.data;
  const needsTyping = counted !== undefined && counted.eligible > counted.typedConfirmationAbove;
  const typedOk = !needsTyping || typed.trim() === String(counted?.eligible);
  const stale = run.error instanceof ApiError && run.error.reason === 'plan_stale';
  const error = run.isError && !stale ? describeDeliveryError(run.error) : null;

  useEffect(() => {
    if (open && counted) cancelRef.current?.focus();
  }, [open, counted]);

  const begin = () => {
    setOpen(true);
    setTyped('');
    run.reset();
    plan.mutate(scope);
  };
  const close = () => {
    setOpen(false);
    plan.reset();
    run.reset();
    startRef.current?.focus();
  };
  const submit = () => {
    if (!counted || run.isPending || !typedOk) return;
    run.mutate({ scope, plan: counted });
  };

  const label = integrationName ? t('bulk.buttonFor', { name: integrationName }) : t('bulk.button');
  const result = run.data;

  return (
    <section className="bulk-redeliver card" aria-labelledby={`${inputId}-title`}>
      <h2 id={`${inputId}-title`} className="card-title">
        {t('bulk.title')}
      </h2>
      {!open && (
        <div>
          <Button ref={startRef} type="button" variant="outline" onClick={begin}>
            <IconRepeat size={18} aria-hidden="true" />
            {label}
          </Button>
        </div>
      )}
      {open && plan.isPending && <p className="muted">{t('bulk.loading')}</p>}
      {open && plan.isError && (
        <Notice kind="error">
          <p>{describeDeliveryError(plan.error).message}</p>
        </Notice>
      )}
      {open && counted && !result && (
        <div className="confirm-box" role="group" aria-labelledby={`${inputId}-count`}>
          {counted.eligible === 0 ? (
            <p id={`${inputId}-count`}>{t('bulk.none')}</p>
          ) : (
            <>
              <p id={`${inputId}-count`} className="confirm-title">
                {tp('bulk.preview', counted.eligible)}
              </p>
              <p>
                {integrationName
                  ? t('bulk.scope.integration', { name: integrationName })
                  : t('bulk.scope.all')}
              </p>
              {counted.remaining > 0 && (
                <p>
                  {counted.totalCapped
                    ? t('bulk.moreMany', { bound: counted.bound })
                    : tp('bulk.more', counted.remaining, { bound: counted.bound })}
                </p>
              )}
              <p>{t('bulk.warning')}</p>
              {needsTyping && (
                <div className="bulk-typed">
                  <label className="field-label" htmlFor={inputId}>
                    {t('bulk.typed.label', { count: counted.eligible })}
                  </label>
                  <Input
                    id={inputId}
                    inputMode="numeric"
                    autoComplete="off"
                    value={typed}
                    aria-describedby={`${inputId}-hint`}
                    onChange={(e) => setTyped(e.target.value)}
                  />
                  <p id={`${inputId}-hint`} className="muted small">
                    {t('bulk.typed.hint')}
                  </p>
                </div>
              )}
            </>
          )}
          {stale && (
            <Notice kind="warning">
              <p>{t('bulk.stale')}</p>
            </Notice>
          )}
          {error && (
            <Notice kind="error">
              <p>{error.message}</p>
              {error.reference && <p className="error-reference">{error.reference}</p>}
            </Notice>
          )}
          <div className="form-actions">
            <Button ref={cancelRef} type="button" variant="outline" onClick={close}>
              {t('bulk.cancel')}
            </Button>
            {(stale || counted.eligible === 0) && (
              <Button type="button" variant="outline" onClick={begin}>
                {t('bulk.recount')}
              </Button>
            )}
            {counted.eligible > 0 && !stale && (
              <Button type="button" onClick={submit} aria-disabled={run.isPending || !typedOk || undefined}>
                {run.isPending ? t('bulk.sending') : t('bulk.confirm')}
              </Button>
            )}
          </div>
        </div>
      )}
      {result && (
        <Notice kind="success">
          <p>{tp('bulk.done', result.replayed)}</p>
          {result.alreadyInFlight > 0 && <p>{tp('bulk.done.already', result.alreadyInFlight)}</p>}
          {result.refused > 0 && <p>{tp('bulk.done.refused', result.refused)}</p>}
          {result.remaining > 0 && <p>{tp('bulk.done.more', result.remaining)}</p>}
          <Button type="button" variant="outline" onClick={close}>
            {t('bulk.cancel')}
          </Button>
        </Notice>
      )}
    </section>
  );
}
