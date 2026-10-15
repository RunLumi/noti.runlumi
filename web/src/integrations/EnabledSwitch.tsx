import { useId, useRef, useState } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import type { Integration } from '../lib/api';
import { t } from '../i18n';
import { Button, Notice } from '../components/ui';
import { describeError } from './errors';
import { useIntegrationImpact, useToggleIntegration } from './hooks';
import { ImpactSummary } from './ImpactSummary';
import { useLocale } from '../i18n/LocaleProvider';

interface EnabledSwitchProps {
  readonly orgId: string;
  readonly integration: Integration;
}

/**
 * Pause/resume. Pausing first states its consequence (F217, ADR 0050): what is not sent yet and
 * what happens to it, what stays saved, and that history is kept, in counts the server took when the
 * confirmation opened. A slow or failed count never blocks the pause: it is the first thing to reach
 * for when an integration is too noisy. Resuming has no consequence to state and applies at once.
 *
 * Both moves are optimistic: if the server refuses, the cache rolls back, the switch returns to the
 * saved state and the reason is announced beside it.
 */
export function EnabledSwitch({ orgId, integration }: EnabledSwitchProps) {
  useLocale();
  const toggle = useToggleIntegration(orgId);
  const stateId = useId();
  const [confirming, setConfirming] = useState(false);
  const impact = useIntegrationImpact(orgId, integration.id, confirming);
  const switchRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const on = integration.enabled;
  const failed = toggle.isError && toggle.variables?.integration.id === integration.id;
  const attempted = toggle.variables?.enabled;
  return (
    <div className="switch-field">
      <div className="switch-row">
        <span className="switch-label" aria-hidden="true">
          {t('integration.toggle.label')}
        </span>
        <button
          ref={switchRef}
          type="button"
          role="switch"
          className="switch"
          aria-checked={on}
          aria-label={t('integration.toggle.labelFor', { name: integration.name })}
          aria-describedby={stateId}
          // aria-disabled, not disabled: a disabled button drops keyboard focus mid-save.
          aria-disabled={toggle.isPending || undefined}
          onClick={() => {
            if (toggle.isPending) return;
            if (on) setConfirming(true);
            else toggle.mutate({ integration, enabled: true });
          }}
        >
          <span className="switch-thumb" aria-hidden="true" />
        </button>
        <span id={stateId} className={on ? 'switch-state switch-state-on' : 'switch-state'}>
          {toggle.isPending
            ? t('integration.toggle.saving')
            : t(on ? 'integration.toggle.on' : 'integration.toggle.off')}
        </span>
      </div>
      {failed && (
        <Notice kind="error" className="switch-error">
          {t(attempted ? 'integration.toggle.errorOn' : 'integration.toggle.errorOff', {
            name: integration.name,
          })}{' '}
          <span className="error-reference">{describeError(toggle.error).message}</span>
        </Notice>
      )}
      <AlertDialog.Root open={confirming} onOpenChange={setConfirming}>
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="modal-backdrop" />
          <AlertDialog.Popup className="modal delete-dialog" initialFocus={cancelRef} finalFocus={switchRef}>
            <AlertDialog.Title className="modal-title">
              {t('pause.title', { name: integration.name })}
            </AlertDialog.Title>
            <AlertDialog.Description>{t('pause.body')}</AlertDialog.Description>
            <ImpactSummary
              action="pause"
              impact={impact.data}
              isPending={impact.isPending}
              isError={impact.isError}
            />
            <div className="form-actions dialog-actions">
              <AlertDialog.Close render={<Button ref={cancelRef} type="button" variant="outline" />}>
                {t('pause.cancel')}
              </AlertDialog.Close>
              <Button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  toggle.mutate({ integration, enabled: false });
                }}
              >
                {t('pause.confirm')}
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}
