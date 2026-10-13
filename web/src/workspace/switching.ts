import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { authApi, type ActiveWorkspace, type Me } from '../lib/api';

/**
 * What belongs to the signed-in person, not to a workspace, and so survives a switch.
 * Every other query key is `[area, orgId, ...]` (see `integrationKeys`, `deliveryKeys`,
 * `sourceKeys`, `teamKey`, `auditKeys`), which is what makes the rule below possible.
 */
const SESSION_SCOPED = new Set<unknown>(['me', 'passkeys']);

/**
 * Remove every cached answer that was not fetched for `orgId`. Run on a switch, so a row that
 * belonged to workspace A can never be rendered, even for a frame, while B is on screen. A key
 * with no workspace in it is removed too: the safe reading of an unknown shape is "not B's".
 */
export function dropOtherWorkspaces(qc: QueryClient, orgId: string): void {
  qc.removeQueries({
    predicate: (query) => {
      const [area, org] = query.queryKey;
      return !SESSION_SCOPED.has(area) && org !== orgId;
    },
  });
}

/** Sibling tabs listen here; the message carries nothing but the fact that a switch happened. */
export const WORKSPACE_CHANNEL = 'noti-workspace';

/**
 * The workspace this tab just switched to itself. The drift detector consumes it, so a switch the
 * person made here is not reported as "changed in another tab".
 */
let ownSwitch: string | null = null;

export function takeOwnSwitch(orgId: string): boolean {
  const mine = ownSwitch === orgId;
  if (mine) ownSwitch = null;
  return mine;
}

/** Call right after this tab changes the active workspace (switch, create, accept an invitation). */
export function noteOwnSwitch(orgId: string): void {
  ownSwitch = orgId;
  try {
    const channel = new BroadcastChannel(WORKSPACE_CHANNEL);
    channel.postMessage({ changed: true });
    channel.close();
  } catch {
    // Unsupported: the other tabs notice on focus.
  }
}

function withActive(me: Me | undefined, active: ActiveWorkspace): Me | undefined {
  if (!me) return me;
  return {
    user: {
      ...me.user,
      org_id: active.activeOrgId,
      activeOrgId: active.activeOrgId,
      org_name: active.orgName,
      role: active.role === 'admin' ? 'admin' : 'member',
    },
  };
}

/**
 * Switch the active workspace: persist it on the session, then re-point the dashboard. `me` is
 * updated from the server's answer first, so pages re-render under the new id (whose queries
 * start empty) before the old workspace's cache is dropped, then `me` is refetched to settle.
 */
export function useSwitchWorkspace(onSwitched?: (active: ActiveWorkspace) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (organizationId: string) => authApi.setActiveWorkspace(organizationId),
    onSuccess: (active) => {
      noteOwnSwitch(active.activeOrgId);
      qc.setQueryData<Me>(['me'], (me) => withActive(me, active));
      dropOtherWorkspaces(qc, active.activeOrgId);
      void qc.invalidateQueries({ queryKey: ['me'] });
      onSwitched?.(active);
    },
    // A refusal means the list on screen is stale (membership removed): refresh it.
    onError: () => void qc.invalidateQueries({ queryKey: ['me'] }),
  });
}

/**
 * After this tab created or joined a workspace (Better Auth already made it active), pin it
 * through our own endpoint, which re-checks the membership. That second call is best effort: if
 * it fails the workspace exists and is active anyway, so the caller must carry on (a retry
 * would create a duplicate workspace). Either way the old workspace's cache is dropped and `me`
 * is refreshed.
 */
export async function adoptWorkspace(qc: QueryClient, orgId: string): Promise<void> {
  noteOwnSwitch(orgId);
  try {
    await authApi.setActiveWorkspace(orgId);
  } catch {
    // Created or joined, and already active: nothing to undo and nothing to retry.
  }
  dropOtherWorkspaces(qc, orgId);
  await qc.invalidateQueries({ queryKey: ['me'] });
}
