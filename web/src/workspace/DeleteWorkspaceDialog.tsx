import { StaleWorkspaceNotice, useBoundWorkspace } from './bound';
import { useId, useRef, useState, type FormEvent } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { useMutation } from '@tanstack/react-query';
import { IconTrash } from '@tabler/icons-react';
import { ApiError } from '../lib/api';
import { Button, Input, Notice } from '../components/ui';
import { t } from '../i18n';
import { describeError } from '../integrations/errors';
import { workspaceApi } from './api';
import { useLocale } from '../i18n/LocaleProvider';

interface DeleteWorkspaceDialogProps {
  readonly orgId: string;
  readonly orgName: string;
  readonly onScheduled: () => void;
}

/** Copy for a failed request: the two statuses this route defines get their own sentence. */
function failure(error: unknown): string {
  if (error instanceof ApiError && error.status === 422) return t('workspace.error.wrongName');
  if (error instanceof ApiError && error.status === 409) return t('workspace.error.already');
  return describeError(error).message;
}

/**
 * Typing the workspace name is the confirmation (it matches the server's check). Focus starts
 * on the cancel button, so a stray Enter cannot schedule a deletion (F221).
 */
export function DeleteWorkspaceDialog({
  orgId: liveOrgId,
  orgName,
  onScheduled,
}: DeleteWorkspaceDialogProps) {
  useLocale();
  const ws = useBoundWorkspace(liveOrgId);
  const orgId = ws.orgId;
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputId = useId();
  const schedule = useMutation({
    mutationFn: () => workspaceApi.requestDeletion(orgId, typed),
    gcTime: 0,
    onSuccess: () => {
      setOpen(false);
      setTyped('');
      onScheduled();
    },
  });
  const matches = typed === orgName;

  const onOpenChange = (next: boolean) => {
    if (schedule.isPending) return;
    setOpen(next);
    if (!next) {
      setTyped('');
      schedule.reset();
    }
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (matches && !schedule.isPending && !ws.stale) schedule.mutate();
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Trigger render={<Button variant="danger" type="button" />}>
        <IconTrash size={18} aria-hidden="true" />
        {t('workspace.danger.button')}
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="modal-backdrop" />
        <AlertDialog.Popup className="modal delete-dialog" initialFocus={cancelRef}>
          <AlertDialog.Title className="modal-title">
            {t('workspace.danger.dialog.title', { name: orgName })}
          </AlertDialog.Title>
          <AlertDialog.Description>{t('workspace.danger.dialog.body')}</AlertDialog.Description>
          <form className="form-stack" onSubmit={onSubmit}>
            <StaleWorkspaceNotice show={ws.stale} />
            <div className="field">
              <label className="field-label" htmlFor={inputId}>
                {t('workspace.danger.dialog.label', { name: orgName })}
              </label>
              <Input
                id={inputId}
                value={typed}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>
            {schedule.isError && (
              <Notice kind="error">
                <p>{failure(schedule.error)}</p>
              </Notice>
            )}
            <div className="form-actions dialog-actions">
              <AlertDialog.Close render={<Button ref={cancelRef} type="button" variant="outline" />}>
                {t('workspace.danger.dialog.keep')}
              </AlertDialog.Close>
              <Button
                type="submit"
                variant="danger"
                aria-disabled={!matches || schedule.isPending || ws.stale || undefined}
              >
                {schedule.isPending
                  ? t('workspace.danger.dialog.scheduling')
                  : t('workspace.danger.dialog.confirm')}
              </Button>
            </div>
          </form>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
