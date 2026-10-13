import { StaleWorkspaceNotice, useBoundWorkspace } from '../workspace/bound';
import { useId, useRef, useState, type FormEvent } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { IconRefresh, IconTrash } from '@tabler/icons-react';
import { Field, SecretInput } from '../components/form';
import { Button, Input, Notice } from '../components/ui';
import { t, tp } from '../i18n';
import { describeError, fieldErrorsOf } from '../integrations/errors';
import type { Source, SourceWithSecret } from './api';
import { useDeleteSource, useRotateSource } from './hooks';
import { useLocale } from '../i18n/LocaleProvider';
import { KIND_LABEL, isProviderKind, validateSecret, type AuthMode } from './providers';

interface DialogProps {
  readonly orgId: string;
  readonly source: Source;
}

function Failure({ error, title }: { readonly error: unknown; readonly title: string }) {
  useLocale();
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
 * choice. A generic source gets a new secret from Noti, which the parent reveals once. A GitLab
 * or Stripe source asks for the new credential the person created in that provider; it is
 * sealed on write and never shown again.
 */
export function RotateDialog({
  orgId: liveOrgId,
  source,
  onRotated,
}: DialogProps & { readonly onRotated: (result: SourceWithSecret) => void }) {
  useLocale();
  const ws = useBoundWorkspace(liveOrgId);
  const rotate = useRotateSource(ws.orgId);
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState('');
  const [authMode, setAuthMode] = useState<AuthMode | null>(source.authMode);
  const [problem, setProblem] = useState<string | undefined>();
  const [confirmDowngrade, setConfirmDowngrade] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const kind = source.kind;
  const provider = isProviderKind(kind) ? kind : null;
  const providerName = t(KIND_LABEL[kind].name);
  // Moving GitLab from a signing token to a plain secret token weakens it: it must be confirmed.
  const downgrade = source.authMode === 'signing_token' && authMode === 'secret_token';

  const reset = () => {
    setSecret('');
    setAuthMode(source.authMode);
    setProblem(undefined);
    setConfirmDowngrade(false);
    rotate.reset();
  };
  const confirm = async (e?: FormEvent) => {
    e?.preventDefault();
    if (rotate.isPending || ws.stale) return;
    let body: Record<string, unknown> | undefined;
    if (provider) {
      const local = validateSecret(provider, authMode, secret);
      setProblem(local);
      if (local) return;
      if (downgrade && !confirmDowngrade) {
        setProblem(t('sources.validation.downgrade'));
        return;
      }
      body =
        provider === 'gitlab'
          ? { authMode, secret, ...(downgrade ? { confirmDowngrade: true } : {}) }
          : { secret };
    }
    try {
      onRotated(await rotate.mutateAsync({ id: source.id, ...(body ? { body } : {}) }));
      setOpen(false);
      reset();
    } catch (failure) {
      // The dialog stays open and the old credential is unchanged; a field message is shown inline.
      setProblem(fieldErrorsOf(failure).find((f) => f.field === 'secret')?.message);
    }
  };
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (rotate.isPending) return;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <AlertDialog.Trigger render={<Button variant="outline" type="button" />}>
        <IconRefresh size={18} aria-hidden="true" />
        {t(provider ? 'sources.rotate.provider.open' : 'sources.rotate.open')}
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="modal-backdrop" />
        <AlertDialog.Popup className="modal delete-dialog" initialFocus={cancelRef}>
          <AlertDialog.Title className="modal-title">
            {t(provider ? 'sources.rotate.provider.title' : 'sources.rotate.title', { name: source.name })}
          </AlertDialog.Title>
          <AlertDialog.Description>
            {provider
              ? t('sources.rotate.provider.body', { provider: providerName })
              : t('sources.rotate.body')}
          </AlertDialog.Description>
          <form className="form-stack" noValidate onSubmit={(e) => void confirm(e)}>
            <StaleWorkspaceNotice show={ws.stale} />
            {provider === 'gitlab' && (
              <fieldset className="destination-choice">
                <legend className="field-label">{t('sources.gitlab.auth.legend')}</legend>
                {(['signing_token', 'secret_token'] as const).map((mode) => (
                  <label key={mode} className="destination-option">
                    <input
                      type="radio"
                      name={`rotate-auth-${source.id}`}
                      checked={authMode === mode}
                      onChange={() => setAuthMode(mode)}
                    />
                    <span className="destination-option-body">
                      <span className="destination-option-name">
                        {t(
                          mode === 'signing_token'
                            ? 'sources.gitlab.auth.signing'
                            : 'sources.gitlab.auth.secret',
                        )}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            {downgrade && (
              <label className="destination-option">
                <input
                  type="checkbox"
                  checked={confirmDowngrade}
                  onChange={(e) => setConfirmDowngrade(e.target.checked)}
                />
                <span className="destination-option-body">
                  <span className="destination-option-name">{t('sources.rotate.downgrade.label')}</span>
                  <span className="destination-option-where">{t('sources.rotate.downgrade.help')}</span>
                </span>
              </label>
            )}
            {provider && (
              <Field
                label={t(provider === 'gitlab' ? 'sources.paste.gitlab.label' : 'sources.paste.stripe.label')}
                hint={t('sources.paste.stored')}
                error={problem}
              >
                {(ids) => (
                  <SecretInput
                    ids={ids}
                    fieldName={t(
                      provider === 'gitlab' ? 'sources.paste.gitlab.label' : 'sources.paste.stripe.label',
                    )}
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                  />
                )}
              </Field>
            )}
            {rotate.isError && !problem && (
              <Failure
                error={rotate.error}
                title={t(provider ? 'sources.rotate.provider.failed' : 'sources.rotate.failed')}
              />
            )}
            <div className="form-actions dialog-actions">
              <AlertDialog.Close render={<Button ref={cancelRef} type="button" variant="outline" />}>
                {t('sources.rotate.keep')}
              </AlertDialog.Close>
              <Button type="submit" aria-disabled={rotate.isPending || ws.stale || undefined}>
                {rotate.isPending
                  ? t(provider ? 'sources.rotate.provider.replacing' : 'sources.rotate.rotating')
                  : t(provider ? 'sources.rotate.provider.confirm' : 'sources.rotate.confirm')}
              </Button>
            </div>
          </form>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** Delete destroys the secret and the connected chats, so the name is typed to confirm. */
export function DeleteSourceDialog({ orgId: liveOrgId, source }: DialogProps) {
  useLocale();
  const ws = useBoundWorkspace(liveOrgId);
  const remove = useDeleteSource(ws.orgId);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputId = useId();
  const matches = typed.trim() === source.name.trim();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!matches || remove.isPending || ws.stale) return;
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
            <StaleWorkspaceNotice show={ws.stale} />
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
                aria-disabled={!matches || remove.isPending || ws.stale || undefined}
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
