import { useId } from 'react';
import type { Integration } from '../lib/api';
import { t } from '../i18n';
import { Notice } from '../components/ui';
import { describeError } from './errors';
import { useToggleIntegration } from './hooks';

interface EnabledSwitchProps {
  readonly orgId: string;
  readonly integration: Integration;
}

/**
 * Pause/resume. The switch moves immediately (optimistic); if the server refuses, the cache
 * rolls back, the switch returns to the saved state and the reason is announced beside it.
 */
export function EnabledSwitch({ orgId, integration }: EnabledSwitchProps) {
  const toggle = useToggleIntegration(orgId);
  const stateId = useId();
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
          type="button"
          role="switch"
          className="switch"
          aria-checked={on}
          aria-label={t('integration.toggle.labelFor', { name: integration.name })}
          aria-describedby={stateId}
          // aria-disabled, not disabled: a disabled button drops keyboard focus mid-save.
          aria-disabled={toggle.isPending || undefined}
          onClick={() => {
            if (!toggle.isPending) toggle.mutate({ integration, enabled: !on });
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
    </div>
  );
}
