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
export type FieldError = { readonly field: string; readonly message: string };

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    /** Per-field validation errors from a 422 response, if any. */
    public fields: readonly FieldError[] = [],
    /** Seconds from a 429 `Retry-After` header, if the server sent one. */
    public retryAfter: number | null = null,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fieldErrorsOf(body: unknown): FieldError[] {
  if (!isRecord(body) || !Array.isArray(body.fields)) return [];
  return body.fields.flatMap((f: unknown) =>
    isRecord(f) && typeof f.field === 'string' && typeof f.message === 'string'
      ? [{ field: f.field, message: f.message }]
      : [],
  );
}

function retryAfterOf(res: Response): number | null {
  const value = Number(res.headers.get('retry-after'));
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : null;
}

/**
 * Same-origin JSON request. Calls send `Content-Type: application/json`: the API refuses a
 * cookie-authenticated mutation with a body without it (CSRF, see docs/API.md), and the
 * browser adds the matching `Origin` header itself. A network failure surfaces as `ApiError`
 * with status 0.
 */
async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      // GETs keep the header for parity with the existing auth calls; a body-less DELETE needs
      // only the Origin check, so it is sent without one.
      headers:
        init.method === 'DELETE' ? init.headers : { ...init.headers, 'Content-Type': 'application/json' },
    });
  } catch {
    throw new ApiError('Network request failed', 0);
  }
  if (res.status === 204) return null;
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      isRecord(body) && typeof body.error === 'string' ? body.error : 'Request failed',
      res.status,
      fieldErrorsOf(body),
      res.status === 429 ? retryAfterOf(res) : null,
    );
  }
  return body;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  return (await request(path, init)) as T;
}

// --- Integrations (docs/API.md) -------------------------------------------------------------

export type DestinationKind = 'lark' | 'slack';
export type CredentialsState = 'ok' | 'legacy' | 'quarantined';

/** The server never returns a webhook URL or a signing secret; only the host. */
export interface Integration {
  readonly id: string;
  readonly name: string;
  readonly repo: string;
  /** Usually catalog event types; an old row may hold a value the catalog no longer has. */
  readonly eventTypes: readonly string[];
  readonly destination: DestinationKind;
  readonly destinationHost: string | null;
  readonly enabled: boolean;
  readonly credentials: CredentialsState;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/** `truncated` is true when the workspace has more rows than one response returns (200). */
export interface IntegrationList {
  readonly integrations: readonly Integration[];
  readonly truncated: boolean;
}

export interface CreateIntegrationBody {
  readonly name: string;
  readonly repo: string;
  readonly eventTypes: readonly string[];
  readonly destination: DestinationKind;
  readonly webhookUrl: string;
  readonly signingSecret?: string;
}

export interface UpdateIntegrationBody {
  readonly name?: string;
  readonly repo?: string;
  readonly eventTypes?: readonly string[];
  readonly enabled?: boolean;
}

export interface RotateCredentialsBody {
  readonly webhookUrl: string;
  readonly signingSecret?: string;
}

const nullableString = (v: unknown): v is string | null => v === null || typeof v === 'string';

/** Narrow one API row. A malformed row is an error, never silently dropped (F225). */
export function parseIntegration(value: unknown): Integration {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.repo !== 'string' ||
    !Array.isArray(value.eventTypes) ||
    (value.destination !== 'lark' && value.destination !== 'slack') ||
    !nullableString(value.destinationHost) ||
    typeof value.enabled !== 'boolean' ||
    (value.credentials !== 'ok' && value.credentials !== 'legacy' && value.credentials !== 'quarantined') ||
    !nullableString(value.createdAt) ||
    !nullableString(value.updatedAt)
  )
    throw new ApiError('Unexpected integration shape', 500);
  return {
    id: value.id,
    name: value.name,
    repo: value.repo,
    eventTypes: value.eventTypes.filter((e): e is string => typeof e === 'string'),
    destination: value.destination,
    destinationHost: value.destinationHost,
    enabled: value.enabled,
    credentials: value.credentials,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function one(body: unknown): Integration {
  if (!isRecord(body)) throw new ApiError('Unexpected response', 500);
  return parseIntegration(body.integration);
}

function withOrg(path: string, orgId: string): string {
  return `${path}?org=${encodeURIComponent(orgId)}`;
}

const base = '/api/integrations';
const item = (id: string) => `${base}/${encodeURIComponent(id)}`;

/** Every call names the workspace explicitly, so a multi-workspace user is never ambiguous. */
export const integrationsApi = {
  list: async (orgId: string): Promise<IntegrationList> => {
    const body = await request(withOrg(base, orgId));
    if (!isRecord(body) || !Array.isArray(body.integrations)) throw new ApiError('Unexpected response', 500);
    return { integrations: body.integrations.map(parseIntegration), truncated: body.truncated === true };
  },
  get: async (orgId: string, id: string): Promise<Integration> =>
    one(await request(withOrg(item(id), orgId))),
  create: async (orgId: string, input: CreateIntegrationBody): Promise<Integration> =>
    one(await request(withOrg(base, orgId), { method: 'POST', body: JSON.stringify(input) })),
  update: async (orgId: string, id: string, patch: UpdateIntegrationBody): Promise<Integration> =>
    one(await request(withOrg(item(id), orgId), { method: 'PATCH', body: JSON.stringify(patch) })),
  rotateCredentials: async (orgId: string, id: string, input: RotateCredentialsBody): Promise<Integration> =>
    one(await request(withOrg(item(id), orgId), { method: 'PATCH', body: JSON.stringify(input) })),
  remove: async (orgId: string, id: string): Promise<void> => {
    await request(withOrg(item(id), orgId), { method: 'DELETE' });
  },
};

// --- GitHub connection (docs/API.md "GitHub connection", ADR 0008) ------------------------

export type InstallationStatus = 'active' | 'suspended' | 'uninstalled';

export interface GithubInstallation {
  readonly id: string;
  readonly account: string;
  readonly accountType: 'User' | 'Organization';
  readonly repositorySelection: 'all' | 'selected';
  readonly status: InstallationStatus;
  readonly updatedAt: string | null;
  /** The stored repository list may be incomplete; reconnecting refreshes it. */
  readonly needsResync: boolean;
  /** Listed for `selected` installations only; `all` covers every repository of `account`. */
  readonly repositories: readonly string[];
}

export interface GithubConnection {
  /** False while the server has no GitHub App credentials: connecting is impossible. */
  readonly configured: boolean;
  readonly installations: readonly GithubInstallation[];
}

export function parseInstallation(value: unknown): GithubInstallation {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.account !== 'string' ||
    (value.accountType !== 'User' && value.accountType !== 'Organization') ||
    (value.repositorySelection !== 'all' && value.repositorySelection !== 'selected') ||
    (value.status !== 'active' && value.status !== 'suspended' && value.status !== 'uninstalled') ||
    !nullableString(value.updatedAt) ||
    typeof value.needsResync !== 'boolean' ||
    !Array.isArray(value.repositories)
  )
    throw new ApiError('Unexpected installation shape', 500);
  return {
    id: value.id,
    account: value.account,
    accountType: value.accountType,
    repositorySelection: value.repositorySelection,
    status: value.status,
    updatedAt: value.updatedAt,
    needsResync: value.needsResync,
    repositories: value.repositories.filter((r): r is string => typeof r === 'string'),
  };
}

export const githubApi = {
  connection: async (orgId: string): Promise<GithubConnection> => {
    const body = await request(withOrg('/api/github/installations', orgId));
    if (!isRecord(body) || typeof body.configured !== 'boolean' || !Array.isArray(body.installations))
      throw new ApiError('Unexpected response', 500);
    return { configured: body.configured, installations: body.installations.map(parseInstallation) };
  },
  /** Starts the verified install flow; the caller navigates the browser to the returned URL. */
  startInstall: async (orgId: string): Promise<string> => {
    const body = await request(withOrg('/api/github/install', orgId), { method: 'POST', body: '{}' });
    if (!isRecord(body) || typeof body.url !== 'string') throw new ApiError('Unexpected response', 500);
    // Only ever leave the app for GitHub over https, whatever the response claims.
    let url: URL;
    try {
      url = new URL(body.url);
    } catch {
      throw new ApiError('Unexpected install URL', 500);
    }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com')
      throw new ApiError('Unexpected install URL', 500);
    return url.toString();
  },
};

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
