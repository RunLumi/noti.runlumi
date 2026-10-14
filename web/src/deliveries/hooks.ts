import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deliveriesApi, type BulkPlan, type BulkScope, type DeliveryFilters } from './api';

/** Query keys carry the workspace, so switching workspace can never show another's rows. */
export const deliveryKeys = {
  all: (orgId: string) => ['deliveries', orgId] as const,
  list: (orgId: string, filters: DeliveryFilters) => ['deliveries', orgId, 'list', filters] as const,
  detail: (orgId: string, id: string) => ['deliveries', orgId, 'detail', id] as const,
  summary: (orgId: string) => ['deliveries', orgId, 'summary'] as const,
};

export function useDeliveryList(orgId: string | null, filters: DeliveryFilters) {
  return useInfiniteQuery({
    queryKey: deliveryKeys.list(orgId ?? '', filters),
    queryFn: ({ pageParam }) => deliveriesApi.list(orgId ?? '', filters, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: orgId !== null,
    // A log is read to find out what just happened; do not serve a 30 s old answer.
    staleTime: 5_000,
  });
}

export function useDeliveryDetail(orgId: string | null, id: string | null) {
  return useQuery({
    queryKey: deliveryKeys.detail(orgId ?? '', id ?? ''),
    queryFn: () => deliveriesApi.get(orgId ?? '', id ?? ''),
    enabled: orgId !== null && id !== null,
    staleTime: 5_000,
  });
}

export function useDeliverySummary(orgId: string | null) {
  return useQuery({
    queryKey: deliveryKeys.summary(orgId ?? ''),
    queryFn: () => deliveriesApi.summary(orgId ?? ''),
    enabled: orgId !== null,
    staleTime: 15_000,
  });
}

/**
 * Not optimistic: the result (queued, or already queued) is shown as the server reports it,
 * and the lists are refetched so the new row and the original's replay state are real.
 */
export function useReplay(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deliveriesApi.replay(orgId, id),
    onSettled: () => qc.invalidateQueries({ queryKey: deliveryKeys.all(orgId) }),
  });
}

/** Step 1 of "redeliver all failed": a count, nothing sent. It is a POST, so a mutation, never cached. */
export function useBulkPlan(orgId: string) {
  return useMutation({ mutationFn: (scope: BulkScope) => deliveriesApi.replayPlan(orgId, scope) });
}

/** Step 2. Not optimistic: the counts shown are the server's. */
export function useBulkReplay(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { scope: BulkScope; plan: Pick<BulkPlan, 'token' | 'eligible'> }) =>
      deliveriesApi.replayBulk(orgId, input.scope, input.plan),
    onSettled: () => qc.invalidateQueries({ queryKey: deliveryKeys.all(orgId) }),
  });
}
