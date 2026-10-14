import { api } from '../lib/api';

/**
 * Erasing the signed-in person's own account (docs/API.md "Your own data and account").
 * The server answers `403 reauth_required` unless the session was created in the last ten minutes.
 */
export const REAUTH_REQUIRED = 'reauth_required';

export const accountApi = {
  erase: async (confirm: string): Promise<void> => {
    // A DELETE with a body must say it is JSON: the server refuses anything else (415).
    await api<unknown>('/api/workspace/me', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm }),
    });
  },
};
