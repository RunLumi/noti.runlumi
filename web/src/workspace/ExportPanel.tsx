import { useMutation } from '@tanstack/react-query';
import { IconDownload } from '@tabler/icons-react';
import { Button, Card, Notice } from '../components/ui';
import { t } from '../i18n';
import { downloadExport } from './api';

interface ExportPanelProps {
  readonly orgId: string;
  readonly isAdmin: boolean;
}

export function ExportPanel({ orgId, isAdmin }: ExportPanelProps) {
  const exporter = useMutation({ mutationFn: () => downloadExport(orgId), gcTime: 0 });
  return (
    <Card className="panel workspace-panel" aria-labelledby="export-title" role="region">
      <h2 id="export-title">{t('workspace.export.title')}</h2>
      <p className="muted">{t('workspace.export.body')}</p>
      {!isAdmin && <p className="admin-only-note">{t('workspace.adminOnly')}</p>}
      <div>
        <Button
          variant="outline"
          type="button"
          // aria-disabled keeps the control reachable by keyboard so the reason above is found.
          aria-disabled={!isAdmin || exporter.isPending || undefined}
          onClick={() => {
            if (isAdmin && !exporter.isPending) exporter.mutate();
          }}
        >
          <IconDownload size={18} aria-hidden="true" />
          {exporter.isPending ? t('workspace.export.exporting') : t('workspace.export.button')}
        </Button>
      </div>
      {exporter.isSuccess && (
        <Notice kind="success">
          <p>{t('workspace.export.done', { file: exporter.data.file })}</p>
          {exporter.data.truncated && <p>{t('workspace.export.truncated')}</p>}
        </Notice>
      )}
      {exporter.isError && <Notice kind="error">{t('workspace.export.error')}</Notice>}
    </Card>
  );
}
