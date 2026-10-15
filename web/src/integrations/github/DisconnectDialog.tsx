import { useRef, useState, type RefObject } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { IconExternalLink, IconPlugConnectedX } from '@tabler/icons-react';
import { Button, Notice } from '../../components/ui';
import type { GithubDisconnect, GithubInstallation } from '../../lib/api';
import { t } from '../../i18n';
import { useLocale } from '../../i18n/LocaleProvider';
import { useDisconnectInstallation } from './hooks';
import { githubAccessUrl } from './RepoPicker';

interface DisconnectDialogProps {
  readonly orgId: string;
  readonly installation: GithubInstallation;
  /** Called once the server confirmed it: announce the result. */
  readonly onDisconnected: (result: GithubDisconnect) => void;
  /** Where focus goes afterwards: the trigger disappears with the installation's active state. */
  readonly focusAfter: RefObject<HTMLElement | null>;
}

/**
 * "Disconnect" for one GitHub installation (F70, ADR 0058), in the alert-dialog pattern of removing a
 * member and revoking a credential: nothing happens until the explicit confirm button, focus starts on
 * "Keep connected", Escape closes, focus returns to the trigger (or, after a disconnect, to `focusAfter`).
 *
 * The message says what stops (updates, at once; integrations paused, reason in the audit log), what is
 * kept (destinations and their webhook settings), what this does NOT do (uninstall the App on GitHub,
 * with a link to GitHub's own settings page for the account), and how to connect again.
 */
export function DisconnectDialog({ orgId, installation, onDisconnected, focusAfter }: DisconnectDialogProps) {
  useLocale();
  const { account } = installation;
  const disconnect = useDisconnectInstallation(orgId);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const keepRef = useRef<HTMLButtonElement>(null);
  const done = useRef(false);
  const busy = disconnect.isPending;

  const onOpenChange = (next: boolean) => {
    if (busy) return;
    setOpen(next);
    if (!next) setError('');
  };

  const confirm = async () => {
    if (busy) return;
    setError('');
    let result: GithubDisconnect;
    try {
      result = await disconnect.mutateAsync(installation.id);
    } catch {
      setError(t('github.disconnect.error', { account }));
      return;
    }
    done.current = true;
    setOpen(false);
    onDisconnected(result);
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Trigger
        render={
          <Button
            variant="outline"
            type="button"
            className="installation-disconnect"
            aria-label={t('github.disconnect.openFor', { account })}
          />
        }
      >
        <IconPlugConnectedX size={18} aria-hidden="true" />
        {t('github.disconnect.open')}
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="modal-backdrop" />
        <AlertDialog.Popup
          className="modal delete-dialog"
          initialFocus={keepRef}
          finalFocus={() => (done.current ? (focusAfter.current ?? true) : true)}
        >
          <AlertDialog.Title className="modal-title">
            {t('github.disconnect.title', { account })}
          </AlertDialog.Title>
          <AlertDialog.Description render={<div className="disconnect-body" />}>
            <p>{t('github.disconnect.stops', { account })}</p>
            <p>{t('github.disconnect.keeps')}</p>
            <p>{t('github.disconnect.github', { account })}</p>
            <p>{t('github.disconnect.again', { account })}</p>
          </AlertDialog.Description>
          <p className="disconnect-link">
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
          {error && (
            <Notice kind="error">
              <p>{error}</p>
            </Notice>
          )}
          <div className="form-actions dialog-actions">
            <AlertDialog.Close render={<Button ref={keepRef} type="button" variant="outline" />}>
              {t('github.disconnect.keep')}
            </AlertDialog.Close>
            <Button
              type="button"
              variant="danger"
              aria-disabled={busy || undefined}
              onClick={() => void confirm()}
            >
              {busy ? t('github.disconnect.working') : t('github.disconnect.confirm')}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
