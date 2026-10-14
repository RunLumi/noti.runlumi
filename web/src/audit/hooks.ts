import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { auditApi, type AuditFilters } from './api';

/** Query keys carry the workspace, so switching workspace can never show another's events. */
export const auditKeys = {
  all: (orgId: string) => ['audit', orgId] as const,
  list: (orgId: string, filters: AuditFilters) => ['audit', orgId, 'list', filters] as const,
  members: (orgId: string) => ['audit', orgId, 'members'] as const,
};

export interface AuditMember {
  readonly userId: string;
  readonly name: string;
}

/**
 * The people who can be chosen in the "Who" filter: the workspace's current members, asked for by
 * name of workspace so a switch can never show the other one's. Names only (no email is kept). A
 * failure leaves the list empty and the rest of the page working: the filter is a convenience.
 */
export function useAuditMembers(orgId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: auditKeys.members(orgId ?? ''),
    queryFn: async (): Promise<AuditMember[]> => {
      const body = await api<{ members?: { userId?: unknown; name?: unknown }[] }>(
        `/api/workspace/team?org=${encodeURIComponent(orgId ?? '')}`,
      );
      return (body.members ?? []).flatMap((m) =>
        typeof m.userId === 'string' && typeof m.name === 'string'
          ? [{ userId: m.userId, name: m.name }]
          : [],
      );
    },
    enabled: orgId !== null && enabled,
    staleTime: 60_000,
  });
}

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
