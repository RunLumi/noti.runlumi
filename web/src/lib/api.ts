import { authClient, assertAuthSuccess } from './auth-client';

export type Me = {
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    org_id: string | null;
    org_name: string | null;
    role: 'admin' | 'member' | null;
  };
};
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...init.headers },
    ...init,
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : 'Request failed',
      res.status,
    );
  }
  return body as T;
}

export const authApi = {
  me: () => api<Me>('/api/workspace/me'),
  signin: async (email: string, password: string) => {
    assertAuthSuccess(await authClient.signIn.email({ email, password }));
    return { authenticated: true };
  },
  signinPasskey: async () => {
    assertAuthSuccess(await authClient.signIn.passkey({}));
    return { authenticated: true };
  },
  signup: async (email: string, password: string, name: string) => {
    assertAuthSuccess(
      await authClient.signUp.email({
        name: name.trim() || email.split('@')[0],
        email,
        password,
        callbackURL: window.location.origin + '/signin?verified=1',
      }),
    );
    return {
      message: 'Check your email for a verification link. Then sign in to create or join your workspace.',
    };
  },
  resendVerification: async (email: string) => {
    assertAuthSuccess(
      await authClient.sendVerificationEmail({
        email,
        callbackURL: window.location.origin + '/signin?verified=1',
      }),
    );
    return { message: 'If eligible, a new verification email has been sent.' };
  },
  forgot: async (email: string) => {
    assertAuthSuccess(
      await authClient.requestPasswordReset({
        email,
        redirectTo: window.location.origin + '/reset',
      }),
    );
    return { message: 'If the account exists, a reset link will be sent.' };
  },
  reset: async (token: string, password: string) => {
    assertAuthSuccess(await authClient.resetPassword({ token, newPassword: password }));
    return { reset: true };
  },
  // Native Better Auth verification email links call /api/auth/verify-email directly.
  verify: async (token: string) => {
    assertAuthSuccess(await authClient.verifyEmail({ query: { token } }));
    return { verified: true };
  },
  signout: async () => {
    assertAuthSuccess(await authClient.signOut());
  },
};
