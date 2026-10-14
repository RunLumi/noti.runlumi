import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { setupKeys } from '../setup/hooks';
import { DESTINATION_ORDER, DESTINATIONS } from './destinations';
import {
  authApi,
  integrationsApi,
  type CreateIntegrationBody,
  type DestinationKind,
  type Integration,
  type IntegrationList,
  type RotateCredentialsBody,
  type UpdateIntegrationBody,
} from '../lib/api';

/** Query keys carry the workspace, so switching workspace can never show another's rows. */
export const integrationKeys = {
  all: (orgId: string) => ['integrations', orgId] as const,
  list: (orgId: string) => ['integrations', orgId, 'list'] as const,
  detail: (orgId: string, id: string) => ['integrations', orgId, 'detail', id] as const,
};

/** The shell has already loaded `me`; this reads the same cache entry. */
export function useOrgId(): string | null {
  const me = useQuery({ queryKey: ['me'], queryFn: authApi.me });
  return me.data?.user.org_id ?? null;
}

export function useIntegrations(orgId: string | null) {
  return useQuery({
    queryKey: integrationKeys.list(orgId ?? ''),
    queryFn: () => integrationsApi.list(orgId ?? ''),
    enabled: orgId !== null,
  });
}

/**
 * Destination kinds this deployment offers. A gated kind is hidden until the server says it is
 * available (the list response carries it), including while that response is still loading.
 */
export function useAvailableDestinations(orgId: string | null): readonly DestinationKind[] {
  const list = useIntegrations(orgId);
  return DESTINATION_ORDER.filter((kind) => !DESTINATIONS[kind].gated || list.data?.genericWebhook === true);
}

export function useIntegration(orgId: string | null, id: string) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: integrationKeys.detail(orgId ?? '', id),
    queryFn: () => integrationsApi.get(orgId ?? '', id),
    enabled: orgId !== null,
    // Show the row from the list immediately; the detail request still confirms it.
    initialData: () =>
      qc
        .getQueryData<IntegrationList>(integrationKeys.list(orgId ?? ''))
        ?.integrations.find((i) => i.id === id),
    initialDataUpdatedAt: () => qc.getQueryState(integrationKeys.list(orgId ?? ''))?.dataUpdatedAt,
  });
}

/**
 * Write one row into the list and, if it is cached, the detail entry — without mutating
 * either, and without creating a detail entry that nothing has fetched.
 */
function putIntegration(qc: QueryClient, orgId: string, next: Integration) {
  qc.setQueryData<IntegrationList>(
    integrationKeys.list(orgId),
    (list) => list && { ...list, integrations: list.integrations.map((i) => (i.id === next.id ? next : i)) },
  );
  qc.setQueryData<Integration>(integrationKeys.detail(orgId, next.id), (current) => current && next);
}

/**
 * Pause or resume with an optimistic update: the switch moves at once. On failure only that
 * row is restored (a concurrent toggle of another row is left alone) and the caller shows the
 * error next to the switch.
 */
export function useToggleIntegration(orgId: string) {
  const qc = useQueryClient();
  return useMutation<Integration, unknown, { integration: Integration; enabled: boolean }>({
    mutationFn: ({ integration, enabled }) => integrationsApi.update(orgId, integration.id, { enabled }),
    onMutate: async ({ integration, enabled }) => {
      await qc.cancelQueries({ queryKey: integrationKeys.all(orgId) });
      putIntegration(qc, orgId, { ...integration, enabled });
    },
    onError: (_error, { integration }) => putIntegration(qc, orgId, integration),
    onSuccess: (saved) => putIntegration(qc, orgId, saved),
    onSettled: async () => {
      // Pausing or resuming changes what setup reports (a paused integration blocks the test).
      void qc.invalidateQueries({ queryKey: setupKeys.all(orgId) });
      await qc.invalidateQueries({ queryKey: integrationKeys.all(orgId) });
    },
  });
}

export function useCreateIntegration(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateIntegrationBody) => integrationsApi.create(orgId, input),
    // The variables hold the webhook URL and secret; do not keep them in the mutation cache.
    gcTime: 0,
    // `signingSecret` (custom webhook) stays in the mutation result only; the cache gets the row.
    onSuccess: ({ integration: created }) => {
      qc.setQueryData<IntegrationList>(
        integrationKeys.list(orgId),
        (list) => list && { ...list, integrations: [created, ...list.integrations] },
      );
      qc.setQueryData(integrationKeys.detail(orgId, created.id), created);
      void qc.invalidateQueries({ queryKey: setupKeys.all(orgId) });
      return qc.invalidateQueries({ queryKey: integrationKeys.list(orgId) });
    },
  });
}

export function useUpdateIntegration(orgId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateIntegrationBody) => integrationsApi.update(orgId, id, patch),
    onSuccess: (saved) => {
      putIntegration(qc, orgId, saved);
      void qc.invalidateQueries({ queryKey: setupKeys.all(orgId) });
    },
  });
}

export function useRotateCredentials(orgId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RotateCredentialsBody) => integrationsApi.rotateCredentials(orgId, id, input),
    gcTime: 0,
    onSuccess: ({ integration: saved }) => {
      putIntegration(qc, orgId, saved);
      void qc.invalidateQueries({ queryKey: setupKeys.all(orgId) });
    },
  });
}

export function useDeleteIntegration(orgId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => integrationsApi.remove(orgId, id),
    onSuccess: () => {
      qc.setQueryData<IntegrationList>(
        integrationKeys.list(orgId),
        (list) => list && { ...list, integrations: list.integrations.filter((i) => i.id !== id) },
      );
      qc.removeQueries({ queryKey: integrationKeys.detail(orgId, id) });
      void qc.invalidateQueries({ queryKey: setupKeys.all(orgId) });
    },
  });
}
