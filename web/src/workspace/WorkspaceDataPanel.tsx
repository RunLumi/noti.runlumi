import { useQuery } from '@tanstack/react-query';
import { authApi } from '../lib/api';
import '../deliveries/deliveries.css';
import '../integrations/integrations.css';
import { DangerZone } from './DangerZone';
import { ExportPanel } from './ExportPanel';
import { useLocale } from '../i18n/LocaleProvider';

/**
 * Admin-only workspace controls on Settings. Members see the panels, disabled, with the
 * reason — a hidden control would leave them guessing where it went.
 */
export function WorkspaceDataPanel() {
  useLocale();
  const me = useQuery({ queryKey: ['me'], queryFn: authApi.me });
  const user = me.data?.user;
  if (!user?.org_id || !user.org_name) return null;
  const isAdmin = user.role === 'admin';
  return (
    <>
      <ExportPanel orgId={user.org_id} isAdmin={isAdmin} />
      <DangerZone orgId={user.org_id} orgName={user.org_name} isAdmin={isAdmin} />
    </>
  );
}
