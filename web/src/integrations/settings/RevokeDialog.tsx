import { useRef, useState, type FormEvent } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { IconShieldOff } from '@tabler/icons-react';
import { Button, Notice } from '../../components/ui';
import { REVOKE_REASONS, type Integration, type RevokeReason } from '../../lib/api';
import { t } from '../../i18n';
import { DESTINATIONS } from '../destinations';
import { describeError } from '../errors';
import { useRevokeCredentials } from '../hooks';
import { useLocale } from '../../i18n/LocaleProvider';

interface RevokeDialogProps {
  readonly orgId: string;
  readonly integration: Integration;
  /** Called after the server accepted the revoke, so the section can move focus and announce it. */
  readonly onRevoked: () => void;
}

const REASON_LABEL = {
  compromised: 'revoke.reason.compromised',
  no_longer_used: 'revoke.reason.no_longer_used',
  other: 'revoke.reason.other',
} as const satisfies Record<RevokeReason, string>;

/**
 * Revoking says the stored webhook URL is burned (F40): Noti stops using it at once and destroys its
 * encrypted copy, which cannot be recovered. It is a confirmation, not a typed phrase: nothing is lost that a
 * new URL does not restore. Focus starts on Cancel so a stray Enter cannot revoke (F221). The reason is one
 * of three fixed choices, never free text, because it goes into the audit log.
 */
export function RevokeDialog({ orgId, integration, onRevoked }: RevokeDialogProps) {
  useLocale();
  const revoke = useRevokeCredentials(orgId, integration.id);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<RevokeReason>('compromised');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const destination = t(DESTINATIONS[integration.destination].name);

  const onOpenChange = (next: boolean) => {
    if (revoke.isPending) return;
    setOpen(next);
    if (!next) revoke.reset();
  };

  // Revoking is destructive: it happens on an explicit click of the confirm button, never because Enter was
  // pressed on a reason radio (implicit form submission), so the form itself never submits.
  const onSubmit = (e: FormEvent) => e.preventDefault();

  const confirm = async () => {
    if (revoke.isPending) return;
    try {
      await revoke.mutateAsync(reason);
      setOpen(false);
      onRevoked();
    } catch {
      // Rendered from `revoke.error` below; the dialog stays open so the person can retry.
    }
  };

  const error = revoke.isError ? describeError(revoke.error) : null;

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Trigger render={<Button variant="danger" type="button" />}>
        <IconShieldOff size={18} aria-hidden="true" />
        {t('revoke.open')}
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="modal-backdrop" />
        <AlertDialog.Popup className="modal delete-dialog" initialFocus={cancelRef}>
          <AlertDialog.Title className="modal-title">
            {t('revoke.title', { name: integration.name })}
          </AlertDialog.Title>
          <AlertDialog.Description>{t('revoke.body', { destination })}</AlertDialog.Description>
          <form className="form-stack" onSubmit={onSubmit}>
            <fieldset className="revoke-reasons">
              <legend className="field-label">{t('revoke.reason.label')}</legend>
              {REVOKE_REASONS.map((value) => (
                <label key={value} className="destination-option">
                  <input
                    type="radio"
                    name="revoke-reason"
                    value={value}
                    checked={reason === value}
                    onChange={() => setReason(value)}
                  />
                  <span className="destination-option-body">
                    <span className="destination-option-name">{t(REASON_LABEL[value])}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {error && (
              <Notice kind="error">
                <p>{error.message}</p>
                {error.reference && <p className="error-reference">{error.reference}</p>}
              </Notice>
            )}
            <div className="form-actions dialog-actions">
              <AlertDialog.Close render={<Button ref={cancelRef} type="button" variant="outline" />}>
                {t('revoke.cancel')}
              </AlertDialog.Close>
              <Button
                type="button"
                variant="danger"
                aria-disabled={revoke.isPending || undefined}
                onClick={() => void confirm()}
              >
                {revoke.isPending ? t('revoke.revoking') : t('revoke.confirm')}
              </Button>
            </div>
          </form>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
