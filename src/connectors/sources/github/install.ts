/**
 * GitHub App install flow and tenant binding (F56, F57; ADR 0008).
 *
 *   1. `startInstall`     → a single-use `install` state, redirect to github.com/apps/<slug>
 *   2. setup URL          → `installation_id` is attacker-controllable, so it is only a
 *                            *claim*; we start an OAuth (PKCE) leg with a `verify` state
 *   3. OAuth callback     → exchange the code, then `GET /user/installations` proves the
 *                            signed-in GitHub user can access that installation of OUR App
 *   4. bind               → insert or activate the row for this workspace; an installation
 *                            already bound elsewhere is refused and audited, never rebound
 *
 * GitHub documents step 3 as the way to trust a setup-URL installation id. The user token
 * is used for the check only, then revoked; we never store it.
 */

export const STATE_TTL_MS = 10 * 60 * 1000;
const GITHUB_API = 'https://api.github.com';
const GITHUB_WEB = 'https://github.com';
export const GITHUB_API_VERSION = '2022-11-28';
const MAX_PAGES = 10;

export interface GithubAppConfig {
  readonly appId: string;
  readonly appSlug: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly appOrigin: string;
}

export type InstallError =
  | 'state_invalid'
  | 'state_user_mismatch'
  | 'installation_id_invalid'
  | 'oauth_failed'
  | 'installation_not_accessible'
  | 'installation_bound_elsewhere'
  | 'github_unavailable';

export class InstallFlowError extends Error {
  constructor(readonly code: InstallError) {
    super(code);
    this.name = 'InstallFlowError';
  }
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Base64url(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

interface StateRow {
  purpose: 'install' | 'verify';
  organization_id: string;
  user_id: string;
  claimed_installation_id: string | null;
  pkce_verifier: string | null;
  expires_at: number;
}

async function createState(
  db: D1Database,
  fields: {
    purpose: 'install' | 'verify';
    organizationId: string;
    userId: string;
    claimedInstallationId?: string;
    pkceVerifier?: string;
  },
  now: number,
): Promise<string> {
  const state = randomToken();
  await db
    .prepare(
      `INSERT INTO github_auth_states(state_hash,purpose,organization_id,user_id,claimed_installation_id,pkce_verifier,expires_at)
       VALUES(?,?,?,?,?,?,?)`,
    )
    .bind(
      await sha256Base64url(state),
      fields.purpose,
      fields.organizationId,
      fields.userId,
      fields.claimedInstallationId ?? null,
      fields.pkceVerifier ?? null,
      now + STATE_TTL_MS,
    )
    .run();
  return state;
}

/**
 * Consume a state exactly once. The UPDATE ... WHERE used_at IS NULL is the single-use
 * guarantee: of two concurrent callbacks, only one changes a row. The state must also have
 * been issued to the user whose session is presenting it.
 */
export async function consumeState(
  db: D1Database,
  state: string | undefined,
  purpose: 'install' | 'verify',
  userId: string,
  now: number,
): Promise<StateRow> {
  if (!state || state.length > 128) throw new InstallFlowError('state_invalid');
  const hash = await sha256Base64url(state);
  const claimed = await db
    .prepare(
      'UPDATE github_auth_states SET used_at=? WHERE state_hash=? AND purpose=? AND used_at IS NULL AND expires_at>?',
    )
    .bind(now, hash, purpose, now)
    .run();
  if (claimed.meta.changes !== 1) throw new InstallFlowError('state_invalid');
  const row = await db
    .prepare(
      'SELECT purpose,organization_id,user_id,claimed_installation_id,pkce_verifier,expires_at FROM github_auth_states WHERE state_hash=?',
    )
    .bind(hash)
    .first<StateRow>();
  if (!row) throw new InstallFlowError('state_invalid');
  if (row.user_id !== userId) throw new InstallFlowError('state_user_mismatch');
  return row;
}

// ---------------------------------------------------------------------------
// Flow steps
// ---------------------------------------------------------------------------

export async function startInstall(
  db: D1Database,
  config: GithubAppConfig,
  who: { organizationId: string; userId: string },
  now: number,
): Promise<string> {
  const state = await createState(db, { purpose: 'install', ...who }, now);
  const url = new URL(`${GITHUB_WEB}/apps/${encodeURIComponent(config.appSlug)}/installations/new`);
  url.searchParams.set('state', state);
  return url.toString();
}

export function callbackUrl(config: GithubAppConfig): string {
  return new URL('/github/callback', config.appOrigin).toString();
}

/** Setup-URL handler: turn an untrusted installation id claim into an OAuth verify leg. */
export async function continueFromSetup(
  db: D1Database,
  config: GithubAppConfig,
  params: { state: string | undefined; installationId: string | undefined },
  userId: string,
  now: number,
): Promise<string> {
  const install = await consumeState(db, params.state, 'install', userId, now);
  if (!params.installationId || !/^[1-9][0-9]{0,15}$/.test(params.installationId))
    throw new InstallFlowError('installation_id_invalid');

  const verifier = randomToken(48);
  const state = await createState(
    db,
    {
      purpose: 'verify',
      organizationId: install.organization_id,
      userId,
      claimedInstallationId: params.installationId,
      pkceVerifier: verifier,
    },
    now,
  );
  const url = new URL(`${GITHUB_WEB}/login/oauth/authorize`);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', callbackUrl(config));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', await sha256Base64url(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('allow_signup', 'false');
  return url.toString();
}

export interface VerifiedInstallation {
  readonly installationId: string;
  readonly accountLogin: string;
  readonly accountType: 'User' | 'Organization';
  readonly repositorySelection: 'all' | 'selected';
  readonly suspended: boolean;
  readonly repositories: readonly { id: string; fullName: string }[];
}

type Fetch = typeof fetch;

function githubHeaders(token: string): HeadersInit {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': GITHUB_API_VERSION,
    'user-agent': 'lumi-noti',
  };
}

async function exchangeCode(
  f: Fetch,
  config: GithubAppConfig,
  code: string,
  verifier: string,
): Promise<string> {
  const url = new URL(`${GITHUB_WEB}/login/oauth/access_token`);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('client_secret', config.clientSecret);
  url.searchParams.set('code', code);
  url.searchParams.set('redirect_uri', callbackUrl(config));
  url.searchParams.set('code_verifier', verifier);
  let res: Response;
  try {
    res = await f(url, { method: 'POST', headers: { accept: 'application/json' }, redirect: 'error' });
  } catch {
    throw new InstallFlowError('github_unavailable');
  }
  if (!res.ok) throw new InstallFlowError(res.status >= 500 ? 'github_unavailable' : 'oauth_failed');
  const body: unknown = await res.json().catch(() => null);
  const token = (body as { access_token?: unknown } | null)?.access_token;
  if (typeof token !== 'string' || token.length === 0) throw new InstallFlowError('oauth_failed');
  return token;
}

async function getJson(f: Fetch, path: string, token: string): Promise<unknown> {
  let res: Response;
  try {
    res = await f(`${GITHUB_API}${path}`, { headers: githubHeaders(token), redirect: 'error' });
  } catch {
    throw new InstallFlowError('github_unavailable');
  }
  if (res.status === 401 || res.status === 403 || res.status === 404)
    throw new InstallFlowError('installation_not_accessible');
  if (!res.ok) throw new InstallFlowError('github_unavailable');
  return res.json();
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Find our App's installation with this id among those the user can access. */
export function pickInstallation(
  body: unknown,
  installationId: string,
  appId: string,
): Omit<VerifiedInstallation, 'repositories'> | null {
  const list = record(body)?.installations;
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    const r = record(item);
    if (!r || String(r.id) !== installationId || String(r.app_id) !== appId) continue;
    const account = record(r.account);
    const login = account?.login;
    const type = account?.type;
    const selection = r.repository_selection;
    if (typeof login !== 'string' || (type !== 'User' && type !== 'Organization')) return null;
    if (selection !== 'all' && selection !== 'selected') return null;
    return {
      installationId,
      accountLogin: login,
      accountType: type,
      repositorySelection: selection,
      suspended: r.suspended_at !== null && r.suspended_at !== undefined,
    };
  }
  return null;
}

export function pickRepositories(body: unknown): { id: string; fullName: string }[] {
  const list = record(body)?.repositories;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    const r = record(item);
    return r && typeof r.id === 'number' && typeof r.full_name === 'string'
      ? [{ id: String(r.id), fullName: r.full_name }]
      : [];
  });
}

async function verifyAccess(
  f: Fetch,
  config: GithubAppConfig,
  token: string,
  installationId: string,
): Promise<VerifiedInstallation> {
  let found: Omit<VerifiedInstallation, 'repositories'> | null = null;
  for (let page = 1; page <= MAX_PAGES && !found; page++) {
    const body = await getJson(f, `/user/installations?per_page=100&page=${page}`, token);
    found = pickInstallation(body, installationId, config.appId);
    const count = (record(body)?.installations as unknown[] | undefined)?.length ?? 0;
    if (count < 100) break;
  }
  if (!found) throw new InstallFlowError('installation_not_accessible');

  const repositories: { id: string; fullName: string }[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = pickRepositories(
      await getJson(f, `/user/installations/${installationId}/repositories?per_page=100&page=${page}`, token),
    );
    repositories.push(...batch);
    if (batch.length < 100) break;
  }
  return { ...found, repositories };
}

/** Best effort: the token has done its one job. A failure here is not a binding failure. */
async function revokeToken(f: Fetch, config: GithubAppConfig, token: string): Promise<void> {
  try {
    await f(`${GITHUB_API}/applications/${encodeURIComponent(config.clientId)}/token`, {
      method: 'DELETE',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
        'x-github-api-version': GITHUB_API_VERSION,
        'user-agent': 'lumi-noti',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ access_token: token }),
      redirect: 'error',
    });
  } catch {
    // The token expires on its own (8 h); nothing was stored.
  }
}

export interface BindResult {
  readonly organizationId: string;
  readonly installation: VerifiedInstallation;
  readonly installationRowId: string;
}

/** OAuth callback: verify the claim, then bind. */
export async function completeVerification(
  db: D1Database,
  config: GithubAppConfig,
  params: { state: string | undefined; code: string | undefined },
  userId: string,
  now: number,
  f: Fetch = fetch,
): Promise<BindResult> {
  const verify = await consumeState(db, params.state, 'verify', userId, now);
  if (!params.code || params.code.length > 256 || !verify.claimed_installation_id || !verify.pkce_verifier)
    throw new InstallFlowError('oauth_failed');

  const token = await exchangeCode(f, config, params.code, verify.pkce_verifier);
  let installation: VerifiedInstallation;
  try {
    installation = await verifyAccess(f, config, token, verify.claimed_installation_id);
  } finally {
    await revokeToken(f, config, token);
  }
  const installationRowId = await bindInstallation(
    db,
    config.appId,
    verify.organization_id,
    userId,
    installation,
  );
  return { organizationId: verify.organization_id, installation, installationRowId };
}

/**
 * Insert or refresh the installation for this workspace. A row bound to another workspace
 * is refused (the trigger in 0010 would also refuse it). Repositories are replaced in the
 * same batch.
 */
export async function bindInstallation(
  db: D1Database,
  appId: string,
  organizationId: string,
  userId: string,
  installation: VerifiedInstallation,
): Promise<string> {
  const existing = await db
    .prepare('SELECT id,organization_id FROM github_installations WHERE installation_id=? AND app_id=?')
    .bind(installation.installationId, appId)
    .first<{ id: string; organization_id: string }>();
  if (existing && existing.organization_id !== organizationId)
    throw new InstallFlowError('installation_bound_elsewhere');

  const rowId = existing?.id ?? crypto.randomUUID();
  const status = installation.suspended ? 'suspended' : 'active';
  const upsert = existing
    ? db
        .prepare(
          `UPDATE github_installations SET account_login=?,account_type=?,repository_selection=?,status=?,
             updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`,
        )
        .bind(
          installation.accountLogin,
          installation.accountType,
          installation.repositorySelection,
          status,
          rowId,
          organizationId,
        )
    : db
        .prepare(
          `INSERT INTO github_installations(id,organization_id,installation_id,app_id,account_login,account_type,
             repository_selection,status,bound_by,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
        )
        .bind(
          rowId,
          organizationId,
          installation.installationId,
          appId,
          installation.accountLogin,
          installation.accountType,
          installation.repositorySelection,
          status,
          userId,
        );

  await db.batch([
    upsert,
    db.prepare('DELETE FROM github_installation_repositories WHERE installation_row_id=?').bind(rowId),
    ...installation.repositories.map((r) =>
      db
        .prepare(
          'INSERT INTO github_installation_repositories(installation_row_id,repository_id,full_name) VALUES(?,?,?)',
        )
        .bind(rowId, r.id, r.fullName),
    ),
  ]);
  return rowId;
}
