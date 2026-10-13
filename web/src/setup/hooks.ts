import { useQuery } from '@tanstack/react-query';
import { setupApi } from './api';

/** Keys carry the workspace, so switching workspace can never show another's progress. */
export const setupKeys = {
  all: (orgId: string) => ['setup', orgId] as const,
  progress: (orgId: string) => ['setup', orgId, 'progress'] as const,
};

export function useSetupProgress(orgId: string | null) {
  return useQuery({
    queryKey: setupKeys.progress(orgId ?? ''),
    queryFn: () => setupApi.progress(orgId ?? ''),
    enabled: orgId !== null,
    // Setup state changes when the person acts elsewhere; do not serve a minute-old answer.
    staleTime: 10_000,
  });
}
