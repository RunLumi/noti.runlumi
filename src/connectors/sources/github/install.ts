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

import { auditStatement } from '../../../audit/audit';
import { insertRepositories } from './repos';

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
  | 'installation_admin_required'
  | 'installation_deleted'
  | 'installation_disconnected'
  | 'installation_too_large'
  | 'workspace_access_lost'
  | 'unexpected_error'
  | 'installation_bound_elsewhere'
  | 'github_unavailable';

export class InstallFlowError extends Error {
  constructor(
    readonly code: InstallError,
    /** Set on refusals after the claim is known, for audit correlation only. */
    readonly claimedInstallationId?: string,
  ) {
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
  mayConnect: WorkspaceCheck,
): Promise<string> {
  const install = await consumeState(db, params.state, 'install', userId, now);
  if (!(await mayConnect(install.organization_id, userId)))
    throw new InstallFlowError('workspace_access_lost');
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
  /** GitHub's numeric account id; stable across renames. */
  readonly accountId: string;
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
  // Credentials in a form body, not the query string, so they never land in access logs.
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: callbackUrl(config),
    code_verifier: verifier,
  });
  let res: Response;
  try {
    res = await f(`${GITHUB_WEB}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'error',
    });
  } catch {
    throw new InstallFlowError('github_unavailable');
  }
  if (!res.ok) throw new InstallFlowError(res.status >= 500 ? 'github_unavailable' : 'oauth_failed');
  const reply: unknown = await res.json().catch(() => null);
  const token = (reply as { access_token?: unknown } | null)?.access_token;
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
    const accountId = account?.id;
    const selection = r.repository_selection;
    if (typeof login !== 'string' || (type !== 'User' && type !== 'Organization')) return null;
    if (typeof accountId !== 'number' || !Number.isSafeInteger(accountId)) return null;
    if (selection !== 'all' && selection !== 'selected') return null;
    return {
      installationId,
      accountId: String(accountId),
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

/**
 * Seeing an installation is not the same as owning it: `/user/installations` also lists an
 * organization's installation to ordinary members who can access any covered repository.
 * Binding routes the WHOLE installation's events into a workspace, so we require the
 * authority GitHub itself requires to install: an active admin of the organization, or the
 * account holder for a personal account.
 */
async function verifyAuthority(
  f: Fetch,
  token: string,
  installation: Omit<VerifiedInstallation, 'repositories'>,
): Promise<void> {
  if (installation.accountType === 'User') {
    // Compare numeric ids, not logins: a login can be renamed and then re-registered.
    const me = record(await getJson(f, '/user', token));
    if (typeof me?.id !== 'number' || String(me.id) !== installation.accountId)
      throw new InstallFlowError('installation_admin_required');
    return;
  }
  let membership: Record<string, unknown> | null;
  try {
    membership = record(
      await getJson(f, `/user/memberships/orgs/${encodeURIComponent(installation.accountLogin)}`, token),
    );
  } catch (e) {
    if (e instanceof InstallFlowError && e.code === 'installation_not_accessible')
      throw new InstallFlowError('installation_admin_required');
    throw e;
  }
  if (membership?.state !== 'active' || membership.role !== 'admin')
    throw new InstallFlowError('installation_admin_required');
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
  await verifyAuthority(f, token, found);

  // An 'all' installation's scope is its account; the repository list is never consulted
  // (tenant.ts), so it is not fetched or stored.
  if (found.repositorySelection === 'all') return { ...found, repositories: [] };

  const repositories: { id: string; fullName: string }[] = [];
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) throw new InstallFlowError('installation_too_large');
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

/** May this user still connect GitHub for this workspace? Re-checked at every step. */
export type WorkspaceCheck = (organizationId: string, userId: string) => Promise<boolean>;

/** OAuth callback: verify the claim, then bind. */
export async function completeVerification(
  db: D1Database,
  config: GithubAppConfig,
  params: {
    state: string | undefined;
    code: string | undefined;
    /** Request attribution for the `github.installation.bind` row, written in the bind's own batch. */
    origin?: { ip: string | null; userAgent: string | null };
  },
  userId: string,
  now: number,
  mayConnect: WorkspaceCheck,
  // EGRESS-ALLOWED: GitHub App install verification (OAuth exchange, user installation check,
  // token revoke). Every URL is built from the GITHUB_API and GITHUB_WEB constants in this file;
  // nothing a tenant supplies selects the host (F228).
  f: Fetch = fetch,
): Promise<BindResult> {
  const verify = await consumeState(db, params.state, 'verify', userId, now);
  // The PKCE verifier has done its job once read; do not leave it at rest.
  await db
    .prepare('UPDATE github_auth_states SET pkce_verifier=NULL WHERE state_hash=?')
    .bind(await sha256Base64url(params.state ?? ''))
    .run();
  if (!params.code || params.code.length > 256 || !verify.claimed_installation_id || !verify.pkce_verifier)
    throw new InstallFlowError('oauth_failed');
  // Membership or role may have changed since the flow started (10-minute window).
  if (!(await mayConnect(verify.organization_id, userId)))
    throw new InstallFlowError('workspace_access_lost');

  const claimed = verify.claimed_installation_id;
  const token = await exchangeCode(f, config, params.code, verify.pkce_verifier);
  try {
    let installation: VerifiedInstallation;
    try {
      installation = await verifyAccess(f, config, token, claimed);
    } finally {
      await revokeToken(f, config, token);
    }
    const installationRowId = await bindInstallation(
      db,
      config.appId,
      verify.organization_id,
      userId,
      installation,
      params.origin ?? { ip: null, userAgent: null },
    );
    return { organizationId: verify.organization_id, installation, installationRowId };
  } catch (e) {
    // Attach the claimed id to refusals so the audit row can correlate repeated attempts.
    if (e instanceof InstallFlowError && !e.claimedInstallationId)
      throw new InstallFlowError(e.code, claimed);
    throw e;
  }
}

/**
 * Insert or refresh the installation for this workspace. A row bound to another workspace
 * is refused (the trigger in 0010 would also refuse it), as is an installation GitHub has
 * already told us was deleted. The repository set is replaced in the same batch, and the
 * `github.installation.bind` audit row is written in it too (F236: if the row cannot be written,
 * nothing is bound).
 */
export async function bindInstallation(
  db: D1Database,
  appId: string,
  organizationId: string,
  userId: string,
  installation: VerifiedInstallation,
  origin: { ip: string | null; userAgent: string | null },
): Promise<string> {
  const tombstone = await db
    .prepare('SELECT 1 AS x FROM github_installation_tombstones WHERE installation_id=? AND app_id=?')
    .bind(installation.installationId, appId)
    .first();
  if (tombstone) throw new InstallFlowError('installation_deleted');

  const existing = await db
    .prepare(
      'SELECT id,organization_id,status FROM github_installations WHERE installation_id=? AND app_id=?',
    )
    .bind(installation.installationId, appId)
    .first<{ id: string; organization_id: string; status: string }>();
  if (existing && existing.organization_id !== organizationId)
    throw new InstallFlowError('installation_bound_elsewhere');
  // This workspace stopped this installation (an admin disconnected it, or GitHub reported it
  // uninstalled). `uninstalled` is terminal (ADR 0008, ADR 0058); GitHub issues a new id on reinstall.
  if (existing?.status === 'uninstalled') throw new InstallFlowError('installation_disconnected');

  const rowId = existing?.id ?? crypto.randomUUID();
  const status = installation.suspended ? 'suspended' : 'active';
  const upsert = existing
    ? db
        .prepare(
          `UPDATE github_installations SET account_login=?,account_id=?,account_type=?,repository_selection=?,status=?,
             repositories_complete=1,updated_at=CURRENT_TIMESTAMP
           WHERE id=? AND organization_id=? AND status<>'uninstalled'`,
        )
        .bind(
          installation.accountLogin,
          installation.accountId,
          installation.accountType,
          installation.repositorySelection,
          status,
          rowId,
          organizationId,
        )
    : db
        .prepare(
          `INSERT INTO github_installations(id,organization_id,installation_id,app_id,account_login,account_id,account_type,
             repository_selection,status,bound_by,repositories_complete,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
        )
        .bind(
          rowId,
          organizationId,
          installation.installationId,
          appId,
          installation.accountLogin,
          installation.accountId,
          installation.accountType,
          installation.repositorySelection,
          status,
          userId,
        );

  const results = await db.batch([
    upsert,
    // Directly after the upsert, so it exists only if the upsert changed the row.
    auditStatement(
      db,
      {
        organizationId,
        actorId: userId,
        action: 'github.installation.bind',
        subjectType: 'github_installation',
        subjectId: rowId,
        outcome: 'success',
        ...origin,
        metadata: {
          account: installation.accountLogin,
          selection: installation.repositorySelection,
          repositories: installation.repositories.length,
        },
      },
      undefined,
      { onlyIfPreviousStatementChangedRows: true },
    ),
    db.prepare('DELETE FROM github_installation_repositories WHERE installation_row_id=?').bind(rowId),
    ...insertRepositories(db, rowId, installation.repositories),
  ]);
  // An uninstalled installation is never revived by a late bind; GitHub issues a new id on
  // reinstall.
  if (results[0]?.meta.changes !== 1) throw new InstallFlowError('installation_deleted');
  return rowId;
}
