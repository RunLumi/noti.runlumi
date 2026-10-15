import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { githubApi } from '../../lib/api';
import { setupKeys } from '../../setup/hooks';
import { integrationKeys } from '../hooks';

export const githubKeys = {
  connection: (orgId: string) => ['github', orgId, 'connection'] as const,
};

export function useGithubConnection(orgId: string | null) {
  return useQuery({
    queryKey: githubKeys.connection(orgId ?? ''),
    queryFn: () => githubApi.connection(orgId ?? ''),
    enabled: orgId !== null,
  });
}

/** Starts the verified install flow and leaves the app for GitHub (a full-page navigation). */
export function useStartInstall(orgId: string) {
  return useMutation({
    mutationFn: () => githubApi.startInstall(orgId),
    onSuccess: (url) => window.location.assign(url),
  });
}

/**
 * Disconnects an installation (ADR 0058). Afterwards the connection, the integrations (some are now
 * paused) and the setup progress (which counts active installations) are read again.
 */
export function useDisconnectInstallation(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (installationId: string) => githubApi.disconnect(orgId, installationId),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: githubKeys.connection(orgId) }),
        qc.invalidateQueries({ queryKey: integrationKeys.all(orgId) }),
        qc.invalidateQueries({ queryKey: setupKeys.all(orgId) }),
      ]),
  });
}
