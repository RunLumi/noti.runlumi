import { IconBrandGithub, IconRefresh } from '@tabler/icons-react';
import { Button, Notice } from '../../components/ui';
import { t } from '../../i18n';
import { describeError } from '../errors';
import { useStartInstall } from './hooks';
import { useLocale } from '../../i18n/LocaleProvider';

interface ConnectGithubButtonProps {
  readonly orgId: string;
  /** "Reconnect" wording for refreshing an existing installation's repository access. */
  readonly reconnect?: boolean;
  readonly variant?: 'primary' | 'outline';
  /** "Connect another account": the person is already connected and wants a different account. */
  readonly another?: boolean;
  /** The trip started from the setup flow, so GitHub's return brings them back to it. */
  readonly fromSetup?: boolean;
}

/** Set before leaving for GitHub; read once on return. A hint about where to resume, never state. */
export const SETUP_RETURN_KEY = 'noti:setup-github-return';

/**
 * Leaves for GitHub to install or reconfigure the Noti App. GitHub returns to
 * `/integrations?github=<status>`, where the outcome is explained.
 */
export function ConnectGithubButton({
  orgId,
  reconnect = false,
  variant = 'primary',
  another = false,
  fromSetup = false,
}: ConnectGithubButtonProps) {
  useLocale();
  const start = useStartInstall(orgId);
  // While the browser is navigating away the mutation has succeeded; keep the busy label.
  const busy = start.isPending || start.isSuccess;
  const error = start.isError ? describeError(start.error) : null;
  return (
    <div className="connect-github">
      <Button
        type="button"
        variant={variant}
        aria-disabled={busy || undefined}
        onClick={() => {
          if (busy) return;
          if (fromSetup) {
            try {
              window.sessionStorage.setItem(SETUP_RETURN_KEY, '1');
            } catch {
              // Storage can be blocked; GitHub's return then lands on Integrations, which links back.
            }
          }
          start.mutate();
        }}
      >
        {reconnect ? (
          <IconRefresh size={18} aria-hidden="true" />
        ) : (
          <IconBrandGithub size={18} aria-hidden="true" />
        )}
        {busy
          ? t('github.connecting')
          : t(reconnect ? 'github.reconnect' : another ? 'github.connectAnother' : 'github.connect')}
      </Button>
      {error && (
        <Notice kind="error">
          <p>{error.message}</p>
          {error.reference && <p className="error-reference">{error.reference}</p>}
        </Notice>
      )}
    </div>
  );
}
