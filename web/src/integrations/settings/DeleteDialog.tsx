import { useId, useRef, useState, type FormEvent } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { useNavigate } from '@tanstack/react-router';
import { IconTrash } from '@tabler/icons-react';
import { Button, Input, Notice } from '../../components/ui';
import type { Integration } from '../../lib/api';
import { t } from '../../i18n';
import { DESTINATIONS } from '../destinations';
import { describeError } from '../errors';
import { useDeleteIntegration } from '../hooks';

interface DeleteDialogProps {
  readonly orgId: string;
  readonly integration: Integration;
}

/**
 * Delete is the one place a typed confirmation is warranted (F217): it destroys the sealed
 * credentials. Focus starts on the cancel button so a stray Enter cannot delete (F221).
 */
export function DeleteDialog({ orgId, integration }: DeleteDialogProps) {
  const remove = useDeleteIntegration(orgId, integration.id);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputId = useId();
  const matches = typed.trim() === integration.name.trim();
  const destination = t(DESTINATIONS[integration.destination].name);

  const onOpenChange = (next: boolean) => {
    if (remove.isPending) return;
    setOpen(next);
    if (!next) {
      setTyped('');
      remove.reset();
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!matches || remove.isPending) return;
    try {
      await remove.mutateAsync();
      await navigate({ to: '/integrations' });
    } catch {
      // The error is rendered from `remove.error` below; the dialog stays open.
    }
  };

  const error = remove.isError ? describeError(remove.error) : null;

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Trigger render={<Button variant="danger" type="button" />}>
        <IconTrash size={18} aria-hidden="true" />
        {t('settings.delete')}
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="modal-backdrop" />
        <AlertDialog.Popup className="modal delete-dialog" initialFocus={cancelRef}>
          <AlertDialog.Title className="modal-title">
            {t('delete.title', { name: integration.name })}
          </AlertDialog.Title>
          <AlertDialog.Description>
            {t('delete.body', { repo: integration.repo, destination })}
          </AlertDialog.Description>
          <form className="form-stack" onSubmit={(e) => void onSubmit(e)}>
            <div className="field">
              <label className="field-label" htmlFor={inputId}>
                {t('delete.confirmLabel', { name: integration.name })}
              </label>
              <Input
                id={inputId}
                value={typed}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>
            {error && (
              <Notice kind="error">
                <p>{error.message}</p>
                {error.reference && <p className="error-reference">{error.reference}</p>}
              </Notice>
            )}
            <div className="form-actions dialog-actions">
              <AlertDialog.Close render={<Button ref={cancelRef} type="button" variant="outline" />}>
                {t('delete.cancel')}
              </AlertDialog.Close>
              <Button
                type="submit"
                variant="danger"
                aria-disabled={!matches || remove.isPending || undefined}
              >
                {remove.isPending ? t('delete.deleting') : t('delete.confirm')}
              </Button>
            </div>
          </form>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
