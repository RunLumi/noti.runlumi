import { useQuery } from '@tanstack/react-query';
import { integrationsApi } from '../../lib/api';

/** Keyed by workspace and integration, so switching either can never show another's count. */
export const noiseStatusKey = (orgId: string, id: string) =>
  ['integrations', orgId, 'noise-status', id] as const;

export function useNoiseStatus(orgId: string, id: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: noiseStatusKey(orgId, id),
    queryFn: () => integrationsApi.noiseStatus(orgId, id),
  });
}
