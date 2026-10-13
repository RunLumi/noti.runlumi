import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { IconTrash } from '@tabler/icons-react';
import { Button, Card, Notice } from '../components/ui';
import { t } from '../i18n';
import { describeError } from '../integrations/errors';
import { absoluteTime } from '../deliveries/Time';
import { workspaceApi } from './api';
import { DeleteWorkspaceDialog } from './DeleteWorkspaceDialog';

interface DangerZoneProps {
  readonly orgId: string;
  readonly orgName: string;
  readonly isAdmin: boolean;
}

const deletionKey = (orgId: string) => ['workspace', orgId, 'deletion'] as const;

function Explainer() {
  return (
    <>
      <p className="muted">{t('workspace.danger.intro')}</p>
      <ul>
        <li>{t('workspace.danger.point1')}</li>
        <li>{t('workspace.danger.point2')}</li>
        <li>{t('workspace.danger.point3')}</li>
      </ul>
      <p className="muted">{t('workspace.danger.backup')}</p>
    </>
  );
}

export function DangerZone({ orgId, orgName, isAdmin }: DangerZoneProps) {
  const qc = useQueryClient();
  // Only an admin may ask: the endpoint is admin-only, and a member's 403 is not a status.
  const status = useQuery({
    queryKey: deletionKey(orgId),
    queryFn: () => workspaceApi.deletion(orgId),
    enabled: isAdmin,
  });
  const cancel = useMutation({
    mutationFn: () => workspaceApi.cancelDeletion(orgId),
    onSuccess: () => qc.invalidateQueries({ queryKey: deletionKey(orgId) }),
  });
  const cancelError = cancel.isError ? describeError(cancel.error) : null;

  return (
    <Card className="panel workspace-panel danger-zone" role="region" aria-labelledby="danger-title">
      <h2 id="danger-title">{t('workspace.danger.title')}</h2>
      <Explainer />
      {!isAdmin && <p className="admin-only-note">{t('workspace.adminOnly')}</p>}
      {isAdmin && status.isPending && <p className="muted">{t('workspace.danger.loading')}</p>}
      {isAdmin && status.isError && (
        <Notice kind="error">
          <p>{t('workspace.danger.error')}</p>
          <Button variant="outline" type="button" onClick={() => void status.refetch()}>
            {t('deliveries.retry')}
          </Button>
        </Notice>
      )}
      {isAdmin && status.data?.scheduled && (
        <Notice kind="warning">
          <p className="notice-title">{t('workspace.danger.scheduled.title')}</p>
          <p>{t('workspace.danger.scheduled.body', { date: absoluteTime(status.data.purgeAfter) })}</p>
          {status.data.purgeStarted ? (
            <p>{t('workspace.danger.purgeStarted')}</p>
          ) : (
            <Button
              variant="outline"
              type="button"
              aria-disabled={cancel.isPending || undefined}
              onClick={() => {
                if (!cancel.isPending) cancel.mutate();
              }}
            >
              {cancel.isPending ? t('workspace.danger.cancelling') : t('workspace.danger.cancel')}
            </Button>
          )}
          {cancelError && <p className="error-reference">{cancelError.message}</p>}
        </Notice>
      )}
      {cancel.isSuccess && status.data && !status.data.scheduled && (
        <Notice kind="success">{t('workspace.danger.cancelled')}</Notice>
      )}
      {isAdmin && status.data && !status.data.scheduled && (
        <div className="form-actions">
          <DeleteWorkspaceDialog
            orgId={orgId}
            orgName={orgName}
            onScheduled={() => void qc.invalidateQueries({ queryKey: deletionKey(orgId) })}
          />
          <span className="form-actions-note">{t('workspace.danger.exportFirst')}</span>
        </div>
      )}
      {!isAdmin && (
        <div>
          <Button variant="danger" type="button" aria-disabled="true">
            <IconTrash size={18} aria-hidden="true" />
            {t('workspace.danger.button')}
          </Button>
        </div>
      )}
    </Card>
  );
}
