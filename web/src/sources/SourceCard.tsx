import { useId } from 'react';
import { IconClock, IconLink, IconSend } from '@tabler/icons-react';
import { Notice } from '../components/ui';
import { Time } from '../deliveries/Time';
import { t, tp } from '../i18n';
import { describeError } from '../integrations/errors';
import { isoOf, type Source, type SourceWithSecret } from './api';
import { ConnectChat } from './ConnectChat';
import { CopyButton } from './CopyButton';
import { Guidance } from './Guidance';
import { useToggleSource } from './hooks';
import { DeleteSourceDialog, RotateDialog } from './SourceDialogs';

interface SourceCardProps {
  readonly orgId: string;
  readonly source: Source;
  readonly onRotated: (result: SourceWithSecret) => void;
}

function ReceivingSwitch({ orgId, source }: { readonly orgId: string; readonly source: Source }) {
  const toggle = useToggleSource(orgId);
  const stateId = useId();
  const on = toggle.isPending ? !source.enabled : source.enabled;
  return (
    <div className="switch-field">
      <div className="switch-row">
        <span className="switch-label" aria-hidden="true">
          {t('sources.toggle.label')}
        </span>
        <button
          type="button"
          role="switch"
          className="switch"
          aria-checked={on}
          aria-label={t('sources.toggle.labelFor', { name: source.name })}
          aria-describedby={stateId}
          aria-disabled={toggle.isPending || undefined}
          onClick={() => {
            if (!toggle.isPending) toggle.mutate({ source, enabled: !source.enabled });
          }}
        >
          <span className="switch-thumb" aria-hidden="true" />
        </button>
        <span id={stateId} className={on ? 'switch-state switch-state-on' : 'switch-state'}>
          {toggle.isPending ? t('sources.toggle.saving') : t(on ? 'sources.toggle.on' : 'sources.toggle.off')}
        </span>
      </div>
      {toggle.isError && (
        <Notice kind="error" className="switch-error">
          {t('sources.toggle.error', {
            name: source.name,
            state: t(source.enabled ? 'sources.toggle.state.on' : 'sources.toggle.state.off'),
          })}{' '}
          <span className="error-reference">{describeError(toggle.error).message}</span>
        </Notice>
      )}
    </div>
  );
}

/** One source as an opaque work sheet: where to send events, what happened last, what to do. */
export function SourceCard({ orgId, source, onRotated }: SourceCardProps) {
  const headingId = 'source-' + source.id;
  return (
    <article
      className={source.enabled ? 'integration-card' : 'integration-card integration-card-paused'}
      aria-labelledby={headingId}
    >
      <header className="integration-card-head">
        <h3 id={headingId} className="integration-name" title={source.name}>
          {source.name}
        </h3>
      </header>
      <dl className="integration-facts">
        <div className="integration-facts-wide">
          <dt>
            <IconLink size={18} aria-hidden="true" />
            {t('sources.card.endpoint')}
          </dt>
          <dd>
            <span className="mono-wrap">{source.endpointUrl}</span>
            <CopyButton
              text={source.endpointUrl}
              label="sources.card.copyUrl"
              copied="sources.secret.copied"
              failed="sources.secret.copyFailed"
              ariaLabel={`${t('sources.card.copyUrl')}: ${source.name}`}
            />
            <span className="field-hint">{t('sources.card.endpointHint')}</span>
          </dd>
        </div>
        <div>
          <dt>
            <IconClock size={18} aria-hidden="true" />
            {t('sources.card.lastReceived')}
          </dt>
          <dd>
            {source.lastReceivedAt ? (
              <Time iso={isoOf(source.lastReceivedAt)} />
            ) : (
              t('sources.card.neverReceived')
            )}
          </dd>
        </div>
        <div>
          <dt>
            <IconSend size={18} aria-hidden="true" />
            {t('sources.card.chats')}
          </dt>
          <dd>
            {source.integrationCount > 0
              ? tp('sources.card.chatsCount', source.integrationCount)
              : t('sources.card.chatsNone')}
          </dd>
        </div>
        {source.secretRotatedAt && (
          <div>
            <dt>{t('sources.card.rotated')}</dt>
            <dd>
              <Time iso={isoOf(source.secretRotatedAt)} />
            </dd>
          </div>
        )}
      </dl>
      <Guidance endpointUrl={source.endpointUrl} />
      <ConnectChat orgId={orgId} source={source} />
      <footer className="integration-card-foot source-actions">
        <ReceivingSwitch orgId={orgId} source={source} />
        <RotateDialog orgId={orgId} source={source} onRotated={onRotated} />
        <DeleteSourceDialog orgId={orgId} source={source} />
      </footer>
    </article>
  );
}
