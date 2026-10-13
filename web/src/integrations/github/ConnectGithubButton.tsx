import { IconBrandGithub, IconRefresh } from '@tabler/icons-react';
import { Button, Notice } from '../../components/ui';
import { t } from '../../i18n';
import { describeError } from '../errors';
import { useStartInstall } from './hooks';

interface ConnectGithubButtonProps {
  readonly orgId: string;
  /** "Reconnect" wording for refreshing an existing installation's repository access. */
  readonly reconnect?: boolean;
  readonly variant?: 'primary' | 'outline';
}

/**
 * Leaves for GitHub to install or reconfigure the Noti App. GitHub returns to
 * `/integrations?github=<status>`, where the outcome is explained.
 */
export function ConnectGithubButton({
  orgId,
  reconnect = false,
  variant = 'primary',
}: ConnectGithubButtonProps) {
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
          if (!busy) start.mutate();
        }}
      >
        {reconnect ? (
          <IconRefresh size={18} aria-hidden="true" />
        ) : (
          <IconBrandGithub size={18} aria-hidden="true" />
        )}
        {busy ? t('github.connecting') : t(reconnect ? 'github.reconnect' : 'github.connect')}
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
