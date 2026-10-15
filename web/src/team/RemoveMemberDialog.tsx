import { useRef, useState, type RefObject } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Button, Notice } from '../components/ui';
import { t } from '../i18n';
import { useLocale } from '../i18n/LocaleProvider';
import './invitations.css';

interface RemoveMemberDialogProps {
  /** The address shown in the trigger's accessible name and in the message. */
  readonly email: string;
  /** The display name, when there is one; the address otherwise. */
  readonly name: string;
  /** The workspace the person is being removed from, as `me` names it. */
  readonly workspace: string;
  /** Performs the removal. Throws with a user-facing message when the server refuses it. */
  readonly onConfirm: () => Promise<void>;
  /** Called once the removal succeeded and the dialog is closing: announce it and refresh the list. */
  readonly onRemoved: () => void;
  /** Where focus goes after a successful removal, since the row holding the trigger is about to disappear. */
  readonly focusAfterRemove: RefObject<HTMLElement | null>;
}

/**
 * "Remove member" on the Team page (ADR 0048), in the same alert-dialog pattern as revoking a credential and
 * cancelling an invitation: nothing happens until the explicit confirm button, focus starts on "Keep member" so a
 * stray Enter removes nobody, Escape closes, and focus returns to the trigger. The message has four parts: who
 * is removed from which workspace (the title), what they lose, what is kept, and how to undo it.
 *
 * A refusal keeps the dialog open with the server's message, so the admin can retry or keep the member. On
 * success the dialog closes with focus on `focusAfterRemove` (the row and its trigger are gone), and the page
 * announces the result.
 */
export function RemoveMemberDialog({
  email,
  name,
  workspace,
  onConfirm,
  onRemoved,
  focusAfterRemove,
}: RemoveMemberDialogProps) {
  useLocale();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const keepRef = useRef<HTMLButtonElement>(null);
  // Read when the dialog closes or unmounts: after a removal the trigger no longer exists to take focus back.
  const removed = useRef(false);

  const onOpenChange = (next: boolean) => {
    if (busy) return;
    setOpen(next);
    if (!next) setError('');
  };

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onConfirm();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('team.members.removeError'));
      setBusy(false);
      return;
    }
    removed.current = true;
    setBusy(false);
    setOpen(false);
    onRemoved();
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Trigger
        render={<Button variant="ghost" type="button" aria-label={t('team.members.removeFor', { email })} />}
      >
        {t('team.members.remove')}
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="modal-backdrop" />
        <AlertDialog.Popup
          className="modal delete-dialog"
          initialFocus={keepRef}
          finalFocus={() => (removed.current ? (focusAfterRemove.current ?? true) : true)}
        >
          <AlertDialog.Title className="modal-title">
            {t('team.members.confirmTitle', { name, workspace })}
          </AlertDialog.Title>
          <AlertDialog.Description render={<div className="remove-member-body" />}>
            <p>{t('team.members.confirmLoses', { email })}</p>
            <p>{t('team.members.confirmKeeps')}</p>
            <p>{t('team.members.confirmUndo')}</p>
          </AlertDialog.Description>
          {error && (
            <Notice kind="error">
              <p>{error}</p>
            </Notice>
          )}
          <div className="form-actions dialog-actions">
            <AlertDialog.Close render={<Button ref={keepRef} type="button" variant="outline" />}>
              {t('team.members.keep')}
            </AlertDialog.Close>
            <Button
              type="button"
              variant="danger"
              aria-disabled={busy || undefined}
              onClick={() => void confirm()}
            >
              {busy ? t('team.members.removing') : t('team.members.confirm')}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
