import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { integrationsApi, type CreateSourceIntegrationBody } from '../lib/api';
import { integrationKeys } from '../integrations/hooks';
import { sourcesApi, type Source } from './api';

/** Query keys carry the workspace, so switching workspace can never show another's rows. */
export const sourceKeys = {
  all: (orgId: string) => ['sources', orgId] as const,
  list: (orgId: string) => ['sources', orgId, 'list'] as const,
};

export function useSources(orgId: string | null) {
  return useQuery({
    queryKey: sourceKeys.list(orgId ?? ''),
    queryFn: () => sourcesApi.list(orgId ?? ''),
    enabled: orgId !== null,
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
    mutationFn: (name: string) => sourcesApi.create(orgId, name),
    gcTime: 0,
    onSuccess: () => qc.invalidateQueries({ queryKey: sourceKeys.all(orgId) }),
  });
}

export function useRotateSource(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => sourcesApi.rotate(orgId, id),
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

export function useDeleteSource(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    // The dialog states how many chats go with the source; confirming it is the cascade.
    mutationFn: (source: Source) => sourcesApi.remove(orgId, source.id, source.integrationCount > 0),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: sourceKeys.all(orgId) }),
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
