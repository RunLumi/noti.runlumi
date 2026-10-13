import { useEffect, useRef, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Notice } from '../components/ui';
import type { Me } from '../lib/api';
import { t } from '../i18n';
import { useLocale } from '../i18n/LocaleProvider';
import { WORKSPACE_CHANNEL, dropOtherWorkspaces, takeOwnSwitch } from './switching';

type User = Me['user'];

/**
 * Detects an active-workspace change this tab did not make, and says so.
 *
 * The active workspace lives on the session, which every tab of the browser shares. If another
 * tab switches it, this tab's next `me` answer names a different workspace than the one it was
 * showing. That is told apart from this tab's own switch by `takeOwnSwitch`. On a foreign change
 * the old workspace's cache is dropped, a page that belonged to it is left, and a persistent
 * alert says what happened; forms bound to the old workspace disable themselves
 * (`useBoundWorkspace`). `me` is refetched when a sibling tab announces a switch
 * (BroadcastChannel) and when this tab regains focus, so the banner does not wait for polling.
 */
export function WorkspaceDriftBanner({ user }: { readonly user: User }) {
  useLocale();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const previous = useRef<string | null>(user.activeOrgId);
  const [changedTo, setChangedTo] = useState<string | null>(null);
  const active = user.activeOrgId;

  useEffect(() => {
    const refresh = () => void qc.invalidateQueries({ queryKey: ['me'] });
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(WORKSPACE_CHANNEL);
      channel.onmessage = refresh;
    } catch {
      // No BroadcastChannel (old browser, privacy mode): focus and visibility still refresh.
    }
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
      channel?.close();
    };
  }, [qc]);

  useEffect(() => {
    const before = previous.current;
    previous.current = active;
    if (before === null || active === null || before === active) return;
    if (takeOwnSwitch(active)) {
      setChangedTo(null);
      return;
    }
    dropOtherWorkspaces(qc, active);
    setChangedTo(user.org_name ?? '');
    // A detail page (`/integrations/<id>`) names a row of the workspace just left.
    if (pathname.startsWith('/integrations/')) void navigate({ to: '/integrations' });
  }, [active, qc, navigate, pathname, user.org_name]);

  if (changedTo === null) return null;
  return (
    <Notice kind="error" className="workspace-drift">
      <p className="notice-title">{t('workspace.drift.title')}</p>
      <p>{t('workspace.drift.body', { name: changedTo || t('shell.workspaceFallback') })}</p>
      <Button variant="outline" type="button" onClick={() => setChangedTo(null)}>
        {t('workspace.drift.dismiss')}
      </Button>
    </Notice>
  );
}
