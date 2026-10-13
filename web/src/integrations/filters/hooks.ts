import { useInfiniteQuery } from '@tanstack/react-query';
import { integrationsApi } from '../../lib/api';

/** Keyed by workspace and integration, so switching either can never show another's decisions. */
export const routingLogKey = (orgId: string, id: string) =>
  ['integrations', orgId, 'routing-log', id] as const;

export function useRoutingLog(orgId: string, id: string) {
  return useInfiniteQuery({
    queryKey: routingLogKey(orgId, id),
    queryFn: ({ pageParam }) => integrationsApi.routingLog(orgId, id, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}
