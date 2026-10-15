import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { IconMailForward, IconMailOpened } from '@tabler/icons-react';
import { ErrorPanel } from '../components/ErrorPanel';
import { EmptyState, Skeleton } from '../components/state';
import { Badge, Button, Card } from '../components/ui';
import { ApiError } from '../lib/api';
import { t } from '../i18n';
import { formatDateTime } from '../i18n/format';
import { useLocale } from '../i18n/LocaleProvider';
import { roleLabel } from '../lib/role-label';
import { invitationsApi, PENDING_INVITATIONS_KEY, type PendingInvitation } from './invitations-api';
import './invitations.css';

const HEADING_ID = 'pending-invitations-title';

/**
 * "Pending invitations" on the Team page (docs/specs/02 F21, ADR 0045). Admins only: the Team page renders it
 * for them alone, and the server refuses anyone else. It lists what the server returns and nothing more: the
 * address, the recorded role, when it was sent and when it expires. Cancelling asks first, in the same
 * alert-dialog pattern as revoking a credential, with focus starting on "Keep invitation".
 */
export function PendingInvitations({ orgId }: { readonly orgId: string }) {
  useLocale();
  const qc = useQueryClient();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [notice, setNotice] = useState('');
  // Keyed by workspace, so a switch can never show the other one's invitations.
  const key = PENDING_INVITATIONS_KEY(orgId);
  const list = useQuery({ queryKey: key, queryFn: () => invitationsApi.list(orgId) });

  const cancel = useMutation({
    mutationFn: (invitation: PendingInvitation) => invitationsApi.cancel(orgId, invitation.id),
    gcTime: 0,
    onMutate: () => setNotice(''),
    onSuccess: async (_result, invitation) => {
      setNotice(t('team.invitations.cancelled', { email: invitation.email }));
      await qc.invalidateQueries({ queryKey: key });
      // The row that had focus is gone; the heading takes focus so a keyboard user is not dropped at the top.
      headingRef.current?.focus();
    },
    onError: async (error) => {
      // 404: already finished, or not in this workspace. Show the list as it is now, not as it was.
      if (error instanceof ApiError && error.status === 404) await qc.invalidateQueries({ queryKey: key });
    },
  });

  const busy = cancel.isPending;

  return (
    <Card className="panel" style={{ marginTop: 20 }} role="region" aria-labelledby={HEADING_ID}>
      <h2 id={HEADING_ID} ref={headingRef} tabIndex={-1}>
        <IconMailForward size={19} aria-hidden="true" /> {t('team.invitations.title')}
      </h2>
      <p className="muted">{t('team.invitations.body')}</p>
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {cancel.isError && <ErrorPanel error={cancel.error} what="team.invitations.cancelWhat" />}
      {list.isPending ? (
        <Skeleton label={t('team.invitations.loading')} rows={2} />
      ) : list.isError ? (
        <ErrorPanel error={list.error} what="team.invitations.loadWhat" onRetry={() => void list.refetch()} />
      ) : list.data.invitations.length === 0 ? (
        <EmptyState
          level={3}
          icon={<IconMailOpened size={24} aria-hidden="true" />}
          title={t('team.invitations.emptyTitle')}
        >
          {t('team.invitations.emptyBody')}
        </EmptyState>
      ) : (
        <>
          <ul className="invitation-list" aria-labelledby={HEADING_ID}>
            {list.data.invitations.map((invitation) => (
              <InvitationEntry
                key={invitation.id}
                invitation={invitation}
                busy={busy}
                onCancel={() => cancel.mutate(invitation)}
              />
            ))}
          </ul>
          {list.data.truncated && <p className="muted">{t('team.invitations.truncated')}</p>}
        </>
      )}
    </Card>
  );
}

interface EntryProps {
  readonly invitation: PendingInvitation;
  readonly busy: boolean;
  readonly onCancel: () => void;
}

function InvitationEntry({ invitation, busy, onCancel }: EntryProps) {
  useLocale();
  const [open, setOpen] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const sent = formatDateTime(invitation.createdAt);
  const until = formatDateTime(invitation.expiresAt);

  return (
    <li className="invitation-entry">
      <div className="invitation-main">
        <p className="invitation-email">{invitation.email}</p>
        <p className="invitation-meta">
          {invitation.role ? roleLabel(invitation.role) : t('team.invitations.roleUnknown')}
          <span aria-hidden="true"> · </span>
          {t('team.invitations.sent', { date: sent })}
          <span aria-hidden="true"> · </span>
          {invitation.expired
            ? t('team.invitations.expiredOn', { date: until })
            : t('team.invitations.expires', { date: until })}
        </p>
        {invitation.expired && <Badge variant="warning">{t('team.invitations.expired')}</Badge>}
      </div>
      <AlertDialog.Root open={open} onOpenChange={setOpen}>
        <AlertDialog.Trigger
          render={
            <Button
              variant="outline"
              type="button"
              disabled={busy}
              aria-label={t('team.invitations.cancelFor', { email: invitation.email })}
            />
          }
        >
          {t('team.invitations.cancel')}
        </AlertDialog.Trigger>
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="modal-backdrop" />
          <AlertDialog.Popup className="modal delete-dialog" initialFocus={keepRef}>
            <AlertDialog.Title className="modal-title">
              {t('team.invitations.confirmTitle', { email: invitation.email })}
            </AlertDialog.Title>
            <AlertDialog.Description>{t('team.invitations.confirmBody')}</AlertDialog.Description>
            <div className="form-actions dialog-actions">
              <AlertDialog.Close render={<Button ref={keepRef} type="button" variant="outline" />}>
                {t('team.invitations.keep')}
              </AlertDialog.Close>
              <Button
                type="button"
                variant="danger"
                aria-disabled={busy || undefined}
                onClick={() => {
                  setOpen(false);
                  onCancel();
                }}
              >
                {busy ? t('team.invitations.cancelling') : t('team.invitations.confirm')}
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </li>
  );
}
