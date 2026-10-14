import { useId, useRef, useState, type FormEvent } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { IconTrash } from '@tabler/icons-react';
import { ApiError, authApi } from '../lib/api';
import { Button, Card, Input, Notice } from '../components/ui';
import { t } from '../i18n';
import { useLocale } from '../i18n/LocaleProvider';
import { accountApi, REAUTH_REQUIRED } from './api';

interface DeleteAccountPanelProps {
  readonly email: string;
}

type Step = 'confirm' | 'reauth';

/** Copy for a failed erasure; the statuses the route defines get their own sentence. */
function failure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 422) return t('account.erase.error.wrongEmail');
    if (error.status === 409) return t('account.erase.error.soleAdmin');
    if (error.status === 429) return t('account.erase.error.tooMany');
  }
  return t('account.erase.error.generic');
}

const isReauth = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 403 && error.message === REAUTH_REQUIRED;

/**
 * Account erasure with step-up. Typing the email only guards against a misclick. The security control
 * is the server's: it refuses unless the session is recent (`403 reauth_required`). This dialog then
 * asks the person to sign in again (password or passkey), which creates a fresh session, and retries.
 * Focus starts on "keep", so a stray Enter cannot delete anything.
 */
export function DeleteAccountPanel({ email }: DeleteAccountPanelProps) {
  useLocale();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('confirm');
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const keepRef = useRef<HTMLButtonElement>(null);
  const emailId = useId();
  const passwordId = useId();

  const erase = useMutation({
    mutationFn: () => accountApi.erase(typed),
    gcTime: 0,
    onSuccess: async () => {
      setOpen(false);
      qc.clear();
      await nav({ to: '/signin' });
    },
    onError: (error) => {
      if (isReauth(error)) setStep('reauth');
    },
  });
  const reauth = useMutation({
    mutationFn: async (method: 'password' | 'passkey') => {
      if (method === 'password') await authApi.signin(email, password);
      else await authApi.signinPasskey();
    },
    gcTime: 0,
    onSuccess: () => {
      setPassword('');
      // The new session is fresh: try the erasure again.
      erase.mutate();
    },
  });

  const busy = erase.isPending || reauth.isPending;
  const matches = typed.trim().toLowerCase() === email.toLowerCase();

  const onOpenChange = (next: boolean) => {
    if (busy) return;
    setOpen(next);
    if (!next) {
      setStep('confirm');
      setTyped('');
      setPassword('');
      erase.reset();
      reauth.reset();
    }
  };
  const onConfirm = (e: FormEvent) => {
    e.preventDefault();
    if (matches && !busy) erase.mutate();
  };
  const onReauth = (e: FormEvent) => {
    e.preventDefault();
    if (password !== '' && !busy) reauth.mutate('password');
  };

  return (
    <Card className="panel workspace-panel danger-zone" role="region" aria-labelledby="erase-account-title">
      <h2 id="erase-account-title">{t('account.erase.title')}</h2>
      <p className="muted">{t('account.erase.intro')}</p>
      <ul>
        <li>{t('account.erase.point1')}</li>
        <li>{t('account.erase.point2')}</li>
        <li>{t('account.erase.point3')}</li>
      </ul>
      <p className="muted">{t('account.erase.backup')}</p>
      <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
        <AlertDialog.Trigger render={<Button variant="danger" type="button" />}>
          <IconTrash size={18} aria-hidden="true" />
          {t('account.erase.button')}
        </AlertDialog.Trigger>
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="modal-backdrop" />
          <AlertDialog.Popup className="modal delete-dialog" initialFocus={keepRef}>
            {step === 'confirm' ? (
              <>
                <AlertDialog.Title className="modal-title">
                  {t('account.erase.dialog.title')}
                </AlertDialog.Title>
                <AlertDialog.Description>{t('account.erase.dialog.body')}</AlertDialog.Description>
                <form className="form-stack" onSubmit={onConfirm}>
                  <div className="field">
                    <label className="field-label" htmlFor={emailId}>
                      {t('account.erase.dialog.label', { email })}
                    </label>
                    <Input
                      id={emailId}
                      value={typed}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(e) => setTyped(e.target.value)}
                    />
                  </div>
                  {erase.isError && !isReauth(erase.error) && (
                    <Notice kind="error">
                      <p>{failure(erase.error)}</p>
                    </Notice>
                  )}
                  <div className="form-actions dialog-actions">
                    <AlertDialog.Close render={<Button ref={keepRef} type="button" variant="outline" />}>
                      {t('account.erase.dialog.keep')}
                    </AlertDialog.Close>
                    <Button type="submit" variant="danger" aria-disabled={!matches || busy || undefined}>
                      {erase.isPending
                        ? t('account.erase.dialog.deleting')
                        : t('account.erase.dialog.confirm')}
                    </Button>
                  </div>
                </form>
              </>
            ) : (
              <>
                <AlertDialog.Title className="modal-title">
                  {t('account.erase.reauth.title')}
                </AlertDialog.Title>
                <AlertDialog.Description>{t('account.erase.reauth.body')}</AlertDialog.Description>
                <form className="form-stack" onSubmit={onReauth}>
                  <div className="field">
                    <label className="field-label" htmlFor={passwordId}>
                      {t('account.erase.reauth.password')}
                    </label>
                    <Input
                      id={passwordId}
                      type="password"
                      value={password}
                      autoComplete="current-password"
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </div>
                  {reauth.isError && (
                    <Notice kind="error">
                      <p>{t('account.erase.reauth.failed')}</p>
                    </Notice>
                  )}
                  {erase.isError && !isReauth(erase.error) && (
                    <Notice kind="error">
                      <p>{failure(erase.error)}</p>
                    </Notice>
                  )}
                  <div className="form-actions dialog-actions">
                    <AlertDialog.Close render={<Button ref={keepRef} type="button" variant="outline" />}>
                      {t('account.erase.dialog.keep')}
                    </AlertDialog.Close>
                    <Button
                      type="button"
                      variant="outline"
                      aria-disabled={busy || undefined}
                      onClick={() => !busy && reauth.mutate('passkey')}
                    >
                      {t('account.erase.reauth.passkey')}
                    </Button>
                    <Button
                      type="submit"
                      variant="danger"
                      aria-disabled={password === '' || busy || undefined}
                    >
                      {busy ? t('account.erase.dialog.deleting') : t('account.erase.reauth.submit')}
                    </Button>
                  </div>
                </form>
              </>
            )}
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </Card>
  );
}
