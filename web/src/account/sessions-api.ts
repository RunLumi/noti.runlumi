import { api } from '../lib/api';

/**
 * These routes act on the caller's own sessions, not on a workspace, so they carry no `?org=` (the
 * `/api/workspace/me` exemption in `web/src/workspace/org-param.test.ts`).
 *
 * The signed-in person's own sessions (`src/api/sessions.ts`, ADR 0030). The server never sends a token:
 * `id` is an opaque handle that only names a session of this person, and `ip` is already shortened.
 */
export interface DeviceSession {
  readonly id: string;
  /** The session making this request. It cannot be revoked here (that is signing out). */
  readonly current: boolean;
  readonly createdAt: string;
  readonly lastActiveAt: string;
  readonly expiresAt: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export const SESSIONS_KEY = ['account', 'sessions'] as const;

export const sessionsApi = {
  list: async (): Promise<readonly DeviceSession[]> =>
    (await api<{ sessions: readonly DeviceSession[] }>('/api/workspace/me/sessions')).sessions,
  revoke: async (id: string): Promise<void> => {
    await api<unknown>(`/api/workspace/me/sessions/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
  },
  revokeOthers: async (): Promise<number> =>
    (await api<{ revoked: number }>('/api/workspace/me/sessions/revoke-others', { method: 'POST' })).revoked,
};
