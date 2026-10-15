import { useId, useRef, useState } from 'react';
import { IconClock, IconFingerprint, IconLink, IconSend, IconShieldOff } from '@tabler/icons-react';
import { Badge, Notice } from '../components/ui';
import { Time } from '../deliveries/Time';
import { t, tp } from '../i18n';
import { describeError } from '../integrations/errors';
import { isoOf, type Source, type SourceWithSecret } from './api';
import { ConnectChat } from './ConnectChat';
import { CopyButton } from './CopyButton';
import { Guidance } from './Guidance';
import { ProviderGuidance } from './ProviderGuidance';
import { KIND_LABEL, isProviderKind } from './providers';
import { useRevokeSource, useToggleSource } from './hooks';
import { DeleteSourceDialog, RotateDialog } from './SourceDialogs';
import { RevokeDialog } from '../integrations/settings/RevokeDialog';
import { useBoundWorkspace } from '../workspace/bound';
import { useLocale } from '../i18n/LocaleProvider';

interface SourceCardProps {
  readonly orgId: string;
  readonly source: Source;
  readonly onRotated: (result: SourceWithSecret) => void;
  /** Rotating and deleting are admin-only (the server enforces it; the buttons are hidden). */
  readonly isAdmin: boolean;
}

function ReceivingSwitch({ orgId, source }: { readonly orgId: string; readonly source: Source }) {
  useLocale();
  const toggle = useToggleSource(orgId);
  const stateId = useId();
  const on = toggle.isPending ? !source.enabled : source.enabled;
  // A revoked source stays off until a new secret is entered (the server refuses to turn it on), so the switch
  // says why and does nothing; the fix is the rotate action.
  const locked = source.revoked;
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
          aria-disabled={toggle.isPending || locked || undefined}
          onClick={() => {
            if (!toggle.isPending && !locked) toggle.mutate({ source, enabled: !source.enabled });
          }}
        >
          <span className="switch-thumb" aria-hidden="true" />
        </button>
        <span id={stateId} className={on ? 'switch-state switch-state-on' : 'switch-state'}>
          {locked
            ? t('sources.toggle.revoked')
            : toggle.isPending
              ? t('sources.toggle.saving')
              : t(on ? 'sources.toggle.on' : 'sources.toggle.off')}
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

const COPY_STATE = {
  destroyed: 'sources.card.copyDestroyed',
  destroying: 'sources.card.copyDestroying',
  kept: 'sources.card.copyKept',
} as const;

/**
 * What happened to a revoked source's encrypted copy. The destroy waits for a fingerprint (ADR 0036): a revoked
 * secret with none is kept, unused, until an operator destroys it, and saying "being destroyed" would be false.
 */
function copyState(source: Source): keyof typeof COPY_STATE {
  if (source.keyDestroyed) return 'destroyed';
  return source.credentialFingerprint ? 'destroying' : 'kept';
}

/** Revoke a source's credential (F40, ADR 0049): the shared dialog, worded for a secret or a pasted credential. */
function SourceRevokeDialog({
  orgId: liveOrgId,
  source,
  onRevoked,
}: {
  readonly orgId: string;
  readonly source: Source;
  readonly onRevoked: () => void;
}) {
  useLocale();
  // Bound at mount like the other source dialogs: the revoke goes to the workspace the card was shown for.
  const ws = useBoundWorkspace(liveOrgId);
  const revoke = useRevokeSource(ws.orgId, source.id);
  const provider = isProviderKind(source.kind) ? t(KIND_LABEL[source.kind].name) : null;
  return (
    <RevokeDialog
      revoke={revoke}
      onRevoked={onRevoked}
      copy={
        provider
          ? {
              open: t('sources.revoke.provider.open'),
              title: t('sources.revoke.provider.title', { name: source.name }),
              body: t('sources.revoke.provider.body', { provider }),
              confirm: t('sources.revoke.provider.confirm'),
            }
          : {
              open: t('sources.revoke.open'),
              title: t('sources.revoke.title', { name: source.name }),
              body: t('sources.revoke.body'),
              confirm: t('sources.revoke.confirm'),
            }
      }
    />
  );
}

/** One source as an opaque work sheet: where to send events, what happened last, what to do. */
export function SourceCard({ orgId, source, onRotated, isAdmin }: SourceCardProps) {
  useLocale();
  const headingId = 'source-' + source.id;
  const provider = isProviderKind(source.kind) ? t(KIND_LABEL[source.kind].name) : null;
  // Set by a revoke in this card; shown only while the source is still revoked (a rotate lifts it).
  const [revokedNow, setRevokedNow] = useState(false);
  const rotateButton = useRef<HTMLButtonElement>(null);
  const onRevoked = () => {
    setRevokedNow(true);
    // The revoke control is gone with the revoke; the next step is a new secret, so focus goes there.
    requestAnimationFrame(() => rotateButton.current?.focus());
  };
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
        <div>
          <dt>{t('sources.card.type')}</dt>
          <dd>{t(KIND_LABEL[source.kind].name)}</dd>
        </div>
        {source.kind === 'gitlab' && source.authMode && (
          <div>
            <dt>{t('sources.card.auth')}</dt>
            <dd>
              {t(
                source.authMode === 'signing_token'
                  ? 'sources.card.auth.signing'
                  : 'sources.card.auth.secret',
              )}
            </dd>
          </div>
        )}
        {source.kind === 'stripe' && source.livemode !== null && (
          <div>
            <dt>{t('sources.card.mode')}</dt>
            <dd>{t(source.livemode ? 'sources.card.mode.live' : 'sources.card.mode.test')}</dd>
          </div>
        )}
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
        {source.revoked && (
          <>
            <div>
              <dt>{t('sources.card.credential')}</dt>
              <dd>
                <Badge variant="danger">{t('sources.card.credentialRevoked')}</Badge>
              </dd>
            </div>
            <div>
              <dt>{t('sources.card.encryptedCopy')}</dt>
              <dd>{t(COPY_STATE[copyState(source)])}</dd>
            </div>
          </>
        )}
        <div className="integration-facts-wide">
          <dt>
            <IconFingerprint size={18} aria-hidden="true" />
            {t('sources.card.fingerprint')}
          </dt>
          <dd>
            <span className="mono-wrap">{source.credentialFingerprint ?? '—'}</span>
            <span className="field-hint">
              {t(
                source.credentialFingerprint
                  ? 'sources.card.fingerprintHint'
                  : 'sources.card.fingerprintNone',
              )}
            </span>
          </dd>
        </div>
      </dl>
      {source.revoked && (
        <div className="cred-notice cred-notice-stop">
          <IconShieldOff size={20} aria-hidden="true" />
          <div>
            <p className="cred-notice-title">
              {t(provider ? 'sources.revoked.providerTitle' : 'sources.revoked.title')}
            </p>
            <p className="source-revoked-body">
              {provider ? t('sources.revoked.providerBody', { provider }) : t('sources.revoked.body')}
            </p>
          </div>
        </div>
      )}
      {revokedNow && source.revoked && (
        <Notice kind="success">
          <p>{t(provider ? 'sources.revoke.provider.done' : 'sources.revoke.done', { name: source.name })}</p>
        </Notice>
      )}
      {source.droppedEvents > 0 && (
        <Notice kind="warning">
          <p className="notice-title">{tp('sources.card.dropped', source.droppedEvents)}</p>
          <p>
            {t('sources.card.droppedHelp')}
            {source.lastDroppedAt && (
              <>
                {' '}
                <Time iso={isoOf(source.lastDroppedAt)} />
              </>
            )}
          </p>
        </Notice>
      )}
      {source.reusedIdRejections > 0 && (
        <Notice kind="warning">
          <p className="notice-title">{tp('sources.card.reused', source.reusedIdRejections)}</p>
          <p>{t('sources.card.reusedHelp')}</p>
        </Notice>
      )}
      {isProviderKind(source.kind) ? (
        <ProviderGuidance
          kind={source.kind}
          endpointUrl={source.endpointUrl}
          weakAuth={source.authMode === 'secret_token'}
        />
      ) : (
        <Guidance endpointUrl={source.endpointUrl} />
      )}
      <ConnectChat orgId={orgId} source={source} />
      <footer className="integration-card-foot source-actions">
        <ReceivingSwitch orgId={orgId} source={source} />
        {isAdmin ? (
          <>
            <RotateDialog
              orgId={orgId}
              source={source}
              triggerRef={rotateButton}
              onRotated={(result) => {
                setRevokedNow(false);
                onRotated(result);
              }}
            />
            {!source.revoked && <SourceRevokeDialog orgId={orgId} source={source} onRevoked={onRevoked} />}
            <DeleteSourceDialog orgId={orgId} source={source} />
          </>
        ) : (
          <p className="field-hint">{t('sources.adminOnly')}</p>
        )}
      </footer>
    </article>
  );
}
