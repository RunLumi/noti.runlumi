import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { integrationsApi, type CreateSourceIntegrationBody, type RevokeReason } from '../lib/api';
import { integrationKeys } from '../integrations/hooks';
import { sourcesApi, type Source } from './api';

/** Query keys carry the workspace, so switching workspace can never show another's rows. */
export const sourceKeys = {
  all: (orgId: string) => ['sources', orgId] as const,
  list: (orgId: string) => ['sources', orgId, 'list'] as const,
  detail: (orgId: string, id: string) => ['sources', orgId, 'detail', id] as const,
};

export function useSources(orgId: string | null) {
  return useQuery({
    queryKey: sourceKeys.list(orgId ?? ''),
    queryFn: () => sourcesApi.list(orgId ?? ''),
    enabled: orgId !== null,
  });
}

/**
 * One source, for its own page (ADR 0056). The row from the list is shown at once when it is
 * cached; the request still confirms it, and a 404 (deleted, or another workspace's id) wins.
 * Rotate, toggle and revoke invalidate `sourceKeys.all`, so this refetches with the list.
 */
export function useSource(orgId: string | null, id: string) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: sourceKeys.detail(orgId ?? '', id),
    queryFn: () => sourcesApi.get(orgId ?? '', id),
    enabled: orgId !== null && id !== '',
    initialData: () =>
      qc.getQueryData<readonly Source[]>(sourceKeys.list(orgId ?? ''))?.find((s) => s.id === id),
    initialDataUpdatedAt: () => qc.getQueryState(sourceKeys.list(orgId ?? ''))?.dataUpdatedAt,
  });
}

/**
 * Create and rotate return the signing secret. `gcTime: 0` drops the mutation result as soon
 * as nothing observes it, and the list cache is refreshed from a plain `list` call, so the
 * secret never enters a query cache.
 */
export function useCreateSource(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => sourcesApi.create(orgId, body),
    gcTime: 0,
    onSuccess: () => qc.invalidateQueries({ queryKey: sourceKeys.all(orgId) }),
  });
}

export function useRotateSource(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body?: Record<string, unknown> }) =>
      sourcesApi.rotate(orgId, id, body),
    gcTime: 0,
    onSuccess: () => qc.invalidateQueries({ queryKey: sourceKeys.all(orgId) }),
  });
}

export function useToggleSource(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ source, enabled }: { source: Source; enabled: boolean }) =>
      sourcesApi.update(orgId, source.id, { enabled }),
    onSettled: () => qc.invalidateQueries({ queryKey: sourceKeys.all(orgId) }),
  });
}

/**
 * Revoke a source's credential (F40). The list is refetched before the call resolves (the returned promise is
 * awaited), so the card shows the revoked state as the dialog closes. No secret is involved, but the hooks still
 * never write the cache by hand: the list only ever holds what a plain `list` call returned.
 */
export function useRevokeSource(orgId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason: RevokeReason) => sourcesApi.revokeCredentials(orgId, id, reason),
    onSuccess: () => qc.invalidateQueries({ queryKey: sourceKeys.all(orgId) }),
  });
}

export function useDeleteSource(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    // The dialog states how many chats go with the source; confirming it is the cascade.
    mutationFn: (source: Source) => sourcesApi.remove(orgId, source.id, source.integrationCount > 0),
    onSuccess: (_result, source) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: sourceKeys.list(orgId) }),
        // Marked stale but not refetched now: the source's own page is leaving (it navigates to the list), and a
        // refetch would flash "not found" first. Opening the page again refetches and shows the 404.
        qc.invalidateQueries({ queryKey: sourceKeys.detail(orgId, source.id), refetchType: 'none' }),
        // Deleting a source deletes the integrations bound to it.
        qc.invalidateQueries({ queryKey: integrationKeys.all(orgId) }),
      ]),
  });
}

/** Connect one chat to a source. The variables hold the webhook URL; do not cache them. */
export function useConnectChat(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSourceIntegrationBody) => integrationsApi.createForSource(orgId, input),
    gcTime: 0,
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: sourceKeys.all(orgId) }),
        qc.invalidateQueries({ queryKey: integrationKeys.all(orgId) }),
      ]),
  });
}
