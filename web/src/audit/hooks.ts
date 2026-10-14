import { useInfiniteQuery } from '@tanstack/react-query';
import { auditApi, type AuditFilters } from './api';

/** Query keys carry the workspace, so switching workspace can never show another's events. */
export const auditKeys = {
  all: (orgId: string) => ['audit', orgId] as const,
  list: (orgId: string, filters: AuditFilters) => ['audit', orgId, 'list', filters] as const,
};

/**
 * `enabled` is false for a member: the endpoint is admin-only, and a 403 the page already
 * knows it will get is not a request worth making.
 */
export function useAuditList(orgId: string | null, filters: AuditFilters, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: auditKeys.list(orgId ?? '', filters),
    queryFn: ({ pageParam }) => auditApi.list(orgId ?? '', filters, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: orgId !== null && enabled,
    // A log is read to find out what just happened.
    staleTime: 5_000,
  });
}
