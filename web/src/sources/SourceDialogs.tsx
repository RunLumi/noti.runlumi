import { useId, useRef, useState, type FormEvent } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { IconRefresh, IconTrash } from '@tabler/icons-react';
import { Button, Input, Notice } from '../components/ui';
import { t, tp } from '../i18n';
import { describeError } from '../integrations/errors';
import type { Source, SourceWithSecret } from './api';
import { useDeleteSource, useRotateSource } from './hooks';

interface DialogProps {
  readonly orgId: string;
  readonly source: Source;
}

function Failure({ error, title }: { readonly error: unknown; readonly title: string }) {
  const described = describeError(error);
  return (
    <Notice kind="error">
      <p className="notice-title">{title}</p>
      <p>{described.message}</p>
      {described.reference && <p className="error-reference">{described.reference}</p>}
    </Notice>
  );
}

/**
 * Rotation is immediate and has no overlap, so it is confirmed. Focus starts on the safe
 * choice. The new secret is handed to the parent, which owns the one-time reveal.
 */
export function RotateDialog({
  orgId,
  source,
  onRotated,
}: DialogProps & { readonly onRotated: (result: SourceWithSecret) => void }) {
  const rotate = useRotateSource(orgId);
  const [open, setOpen] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirm = async () => {
    if (rotate.isPending) return;
    try {
      onRotated(await rotate.mutateAsync(source.id));
      setOpen(false);
    } catch {
      // Rendered from `rotate.error`; the dialog stays open and the old secret is unchanged.
    }
  };
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (rotate.isPending) return;
        setOpen(next);
        if (!next) rotate.reset();
      }}
    >
      <AlertDialog.Trigger render={<Button variant="outline" type="button" />}>
        <IconRefresh size={18} aria-hidden="true" />
        {t('sources.rotate.open')}
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="modal-backdrop" />
        <AlertDialog.Popup className="modal delete-dialog" initialFocus={cancelRef}>
          <AlertDialog.Title className="modal-title">
            {t('sources.rotate.title', { name: source.name })}
          </AlertDialog.Title>
          <AlertDialog.Description>{t('sources.rotate.body')}</AlertDialog.Description>
          {rotate.isError && <Failure error={rotate.error} title={t('sources.rotate.failed')} />}
          <div className="form-actions dialog-actions">
            <AlertDialog.Close render={<Button ref={cancelRef} type="button" variant="outline" />}>
              {t('sources.rotate.keep')}
            </AlertDialog.Close>
            <Button
              type="button"
              aria-disabled={rotate.isPending || undefined}
              onClick={() => void confirm()}
            >
              {rotate.isPending ? t('sources.rotate.rotating') : t('sources.rotate.confirm')}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** Delete destroys the secret and the connected chats, so the name is typed to confirm. */
export function DeleteSourceDialog({ orgId, source }: DialogProps) {
  const remove = useDeleteSource(orgId);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputId = useId();
  const matches = typed.trim() === source.name.trim();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!matches || remove.isPending) return;
    try {
      await remove.mutateAsync(source);
    } catch {
      // Rendered from `remove.error`; the dialog stays open.
    }
  };

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (remove.isPending) return;
        setOpen(next);
        if (!next) {
          setTyped('');
          remove.reset();
        }
      }}
    >
      <AlertDialog.Trigger render={<Button variant="danger" type="button" />}>
        <IconTrash size={18} aria-hidden="true" />
        {t('sources.delete.open')}
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="modal-backdrop" />
        <AlertDialog.Popup className="modal delete-dialog" initialFocus={cancelRef}>
          <AlertDialog.Title className="modal-title">
            {t('sources.delete.title', { name: source.name })}
          </AlertDialog.Title>
          <AlertDialog.Description>
            {source.integrationCount > 0
              ? tp('sources.delete.body', source.integrationCount)
              : t('sources.delete.bodyNoChats')}
          </AlertDialog.Description>
          <form className="form-stack" onSubmit={(e) => void onSubmit(e)}>
            <div className="field">
              <label className="field-label" htmlFor={inputId}>
                {t('sources.delete.confirmLabel', { name: source.name })}
              </label>
              <Input
                id={inputId}
                value={typed}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>
            {remove.isError && <Failure error={remove.error} title={t('sources.delete.failed')} />}
            <div className="form-actions dialog-actions">
              <AlertDialog.Close render={<Button ref={cancelRef} type="button" variant="outline" />}>
                {t('sources.delete.keep')}
              </AlertDialog.Close>
              <Button
                type="submit"
                variant="danger"
                aria-disabled={!matches || remove.isPending || undefined}
              >
                {remove.isPending ? t('sources.delete.deleting') : t('sources.delete.confirm')}
              </Button>
            </div>
          </form>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
