import { useId, useRef, useState, type FormEvent } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { useNavigate } from '@tanstack/react-router';
import { IconTrash } from '@tabler/icons-react';
import { Button, Input, Notice } from '../../components/ui';
import type { Integration } from '../../lib/api';
import { t } from '../../i18n';
import { DESTINATIONS } from '../destinations';
import { describeError } from '../errors';
import { useDeleteIntegration, useIntegrationImpact } from '../hooks';
import { ImpactSummary } from '../ImpactSummary';
import { useLocale } from '../../i18n/LocaleProvider';

interface DeleteDialogProps {
  readonly orgId: string;
  readonly integration: Integration;
}

/**
 * Delete is the one place a typed confirmation is warranted (F217): it destroys the sealed
 * credentials. Focus starts on the cancel button so a stray Enter cannot delete (F221). Before the
 * confirm button works, the dialog states what the delete removes and what it keeps, in counts the
 * server took when the dialog opened (ADR 0050); while they are still being counted the button is inert.
 */
export function DeleteDialog({ orgId, integration }: DeleteDialogProps) {
  useLocale();
  const remove = useDeleteIntegration(orgId, integration.id);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const impact = useIntegrationImpact(orgId, integration.id, open);
  const counting = impact.isPending && !impact.isError;
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
    if (!matches || counting || remove.isPending) return;
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
            {t('delete.body', {
              repo: integration.repo || t('integration.source.value'),
              destination,
            })}
          </AlertDialog.Description>
          <ImpactSummary
            action="delete"
            impact={impact.data}
            isPending={impact.isPending}
            isError={impact.isError}
          />
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
                aria-disabled={!matches || counting || remove.isPending || undefined}
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
