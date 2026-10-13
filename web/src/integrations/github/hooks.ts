import { useMutation, useQuery } from '@tanstack/react-query';
import { githubApi } from '../../lib/api';

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
