import { api, ApiError } from '../lib/api';

/**
 * Pending invitations of one workspace (ADR 0045, `src/api/invitations.ts`). Admin only: the server answers a
 * member 403 and a workspace the caller is not in 404. Every call names its workspace with `?org=`.
 */
export interface PendingInvitation {
  readonly id: string;
  readonly email: string;
  /** `admin` or `member`; null when the invitation carries no recorded role. */
  readonly role: 'admin' | 'member' | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** Computed by the server: the expiry has passed. The invitation still counts as pending until cancelled. */
  readonly expired: boolean;
}

export interface PendingInvitations {
  readonly invitations: readonly PendingInvitation[];
  /** True when the workspace has more pending invitations than the server returns; the first page is shown. */
  readonly truncated: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isIso = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));

function invitationOf(value: unknown): PendingInvitation {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.email !== 'string' ||
    (value.role !== null && value.role !== 'admin' && value.role !== 'member') ||
    !isIso(value.createdAt) ||
    !isIso(value.expiresAt) ||
    typeof value.expired !== 'boolean'
  )
    // A malformed row is an error, never silently dropped (F225).
    throw new ApiError('invalid_invitation', 500);
  return {
    id: value.id,
    email: value.email,
    role: value.role,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    expired: value.expired,
  };
}

export const PENDING_INVITATIONS_KEY = (orgId: string) => ['team', orgId, 'invitations'] as const;

const withOrg = (path: string, orgId: string): string => `${path}?org=${encodeURIComponent(orgId)}`;

export const invitationsApi = {
  list: async (orgId: string): Promise<PendingInvitations> => {
    const body = await api<unknown>(withOrg('/api/workspace/invitations', orgId));
    if (!isRecord(body) || !Array.isArray(body.invitations) || typeof body.truncated !== 'boolean')
      throw new ApiError('invalid_response', 500);
    return { invitations: body.invitations.map(invitationOf), truncated: body.truncated };
  },
  cancel: async (orgId: string, id: string): Promise<void> => {
    await api<unknown>(withOrg(`/api/workspace/invitations/${encodeURIComponent(id)}/cancel`, orgId), {
      method: 'POST',
      body: '{}',
    });
  },
};
