import { ApiError, api } from '../../lib/api';

/**
 * `POST /api/integrations/:id/test` (docs/API.md "Send a test notification"). The response is
 * the new delivery's id only; the result comes from polling `GET /api/deliveries/:id`.
 */
export const testSendApi = {
  send: async (orgId: string, integrationId: string): Promise<string> => {
    const path = `/api/integrations/${encodeURIComponent(integrationId)}/test?org=${encodeURIComponent(orgId)}`;
    const body = await api<unknown>(path, { method: 'POST', body: '{}' });
    const id =
      typeof body === 'object' && body !== null ? (body as { deliveryId?: unknown }).deliveryId : null;
    if (typeof id !== 'string' || id.length === 0) throw new ApiError('Unexpected response', 500);
    return id;
  },
};
