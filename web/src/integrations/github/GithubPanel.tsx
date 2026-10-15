import { useRef, useState, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconAlertTriangle, IconExternalLink, IconPlugConnectedX } from '@tabler/icons-react';
import { Badge, Notice } from '../../components/ui';
import { authApi, type GithubDisconnect, type GithubInstallation } from '../../lib/api';
import { t, tp } from '../../i18n';
import { describeError } from '../errors';
import { ConnectGithubButton } from './ConnectGithubButton';
import { DisconnectDialog } from './DisconnectDialog';
import { useGithubConnection } from './hooks';
import { githubAccessUrl } from './RepoPicker';
import { useLocale } from '../../i18n/LocaleProvider';

const STATUS_BADGE = { active: 'success', suspended: 'warning', uninstalled: 'danger' } as const;
const STATUS_LABEL = {
  active: 'github.status.active',
  suspended: 'github.status.suspended',
  uninstalled: 'github.status.uninstalled',
} as const;

/** Set by the Integrations page for admins; the setup flow shows installations without it. */
interface DisconnectControl {
  readonly onDisconnected: (result: GithubDisconnect) => void;
  readonly focusAfter: RefObject<HTMLElement | null>;
}

export function Installation({
  orgId,
  installation,
  disconnect,
}: {
  orgId: string;
  installation: GithubInstallation;
  disconnect?: DisconnectControl;
}) {
  useLocale();
  const { account, status } = installation;
  const scope =
    installation.repositorySelection === 'all'
      ? t('github.scope.all', { account })
      : tp('github.scope.selected', installation.repositories.length);
  return (
    <li className="installation">
      <div className="installation-head">
        <span className="installation-account mono-wrap">{account}</span>
        <span className="installation-type">
          {t(installation.accountType === 'Organization' ? 'github.type.org' : 'github.type.user')}
        </span>
        <Badge variant={STATUS_BADGE[status]}>{t(STATUS_LABEL[status])}</Badge>
      </div>
      <p className="installation-scope">{scope}</p>
      {status === 'suspended' && (
        <p className="installation-note">{t('github.suspended.body', { account })}</p>
      )}
      {status === 'uninstalled' && (
        <>
          <p className="installation-note">{t('github.uninstalled.body', { account })}</p>
          <p className="installation-note">{t('github.uninstalled.again', { account })}</p>
          <p className="installation-note">
            <a
              href={githubAccessUrl(installation)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-link"
            >
              {t('github.settingsLink', { account })}
              <IconExternalLink size={16} aria-hidden="true" />
            </a>
          </p>
        </>
      )}
      {status === 'active' && installation.needsResync && (
        <div className="cred-notice">
          <IconAlertTriangle size={20} aria-hidden="true" />
          <div>
            <p className="cred-notice-title">{t('github.resync.title')}</p>
            <p className="cred-notice-body">{t('github.resync.body', { account })}</p>
            <div className="cred-notice-action">
              <ConnectGithubButton orgId={orgId} reconnect variant="outline" />
            </div>
          </div>
        </div>
      )}
      {disconnect && status !== 'uninstalled' && (
        <div className="installation-actions">
          <DisconnectDialog
            orgId={orgId}
            installation={installation}
            onDisconnected={disconnect.onDisconnected}
            focusAfter={disconnect.focusAfter}
          />
        </div>
      )}
    </li>
  );
}

/**
 * The GitHub side of every integration (ADR 0008). Integrations can only name repositories a
 * connected installation covers, so this panel comes first on the Integrations page.
 */
export function GithubPanel({ orgId }: { orgId: string }) {
  useLocale();
  const connection = useGithubConnection(orgId);
  const me = useQuery({ queryKey: ['me'], queryFn: authApi.me });
  const isAdmin = me.data?.user.role === 'admin';
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [disconnected, setDisconnected] = useState<GithubDisconnect | null>(null);
  const control: DisconnectControl = { onDisconnected: setDisconnected, focusAfter: headingRef };
  const stoppable = connection.data?.installations.some((i) => i.status !== 'uninstalled') ?? false;
  return (
    <section className="github-panel" aria-labelledby="github-panel-title" aria-busy={connection.isPending}>
      <h2 id="github-panel-title" ref={headingRef} tabIndex={-1}>
        {t('github.title')}
      </h2>
      {disconnected && (
        <Notice kind="success">
          <p>
            {disconnected.pausedIntegrations > 0
              ? tp('github.disconnect.done', disconnected.pausedIntegrations, {
                  account: disconnected.account,
                })
              : t('github.disconnect.doneNone', { account: disconnected.account })}
          </p>
        </Notice>
      )}
      {connection.isPending ? (
        <p className="field-hint">{t('github.loading')}</p>
      ) : connection.isError ? (
        <Notice kind="error">
          <p>{t('github.error')}</p>
          <p>{describeError(connection.error).message}</p>
        </Notice>
      ) : !connection.data.configured ? (
        <div className="github-unconfigured">
          <IconPlugConnectedX size={20} aria-hidden="true" />
          <div>
            <p className="cred-notice-title">{t('github.notConfigured.title')}</p>
            <p className="cred-notice-body">{t('github.notConfigured.body')}</p>
          </div>
        </div>
      ) : (
        <>
          <p className="field-hint">
            {t(connection.data.installations.length ? 'github.intro.connected' : 'github.intro.none')}
          </p>
          {connection.data.installations.length > 0 && (
            <ul className="installations">
              {connection.data.installations.map((i) => (
                <Installation
                  key={i.id}
                  orgId={orgId}
                  installation={i}
                  {...(isAdmin ? { disconnect: control } : {})}
                />
              ))}
            </ul>
          )}
          {!isAdmin && me.data && stoppable && (
            <p className="field-hint">{t('github.disconnect.adminOnly')}</p>
          )}
          <ConnectGithubButton
            orgId={orgId}
            variant={connection.data.installations.length ? 'outline' : 'primary'}
          />
          <p className="field-hint">{t('github.samlHint')}</p>
        </>
      )}
    </section>
  );
}
