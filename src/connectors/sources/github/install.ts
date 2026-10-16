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

import { insertRepositories } from './repos';
import { log } from '../../../platform/log';
import { readBodyCapped } from '../../../lib/body';

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
  | 'installation_too_large'
  | 'installation_list_too_large'
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

/** Start with OAuth so an existing installation does not get stranded on GitHub settings. */
export async function startConnect(
  db: D1Database,
  config: GithubAppConfig,
  who: { organizationId: string; userId: string },
  now: number,
  claimedInstallationId?: string,
): Promise<string> {
  const verifier = randomToken(48);
  const state = await createState(
    db,
    {
      purpose: 'verify',
      ...who,
      pkceVerifier: verifier,
      ...(claimedInstallationId ? { claimedInstallationId } : {}),
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

export interface InstallationChoice {
  readonly account: string;
  readonly state: string;
}
export type ConnectResult =
  | BindResult
  | { readonly organizationId: string; readonly next: string }
  | {
      readonly organizationId: string;
      readonly choices: readonly InstallationChoice[];
      readonly install: string;
    };

/** Choice tickets reuse verify states with NO PKCE verifier; they cannot be exchanged as OAuth states. */
export async function chooseInstallation(
  db: D1Database,
  config: GithubAppConfig,
  state: string | undefined,
  userId: string,
  now: number,
  mayConnect: WorkspaceCheck,
): Promise<string> {
  const choice = await consumeState(db, state, 'verify', userId, now);
  if (choice.pkce_verifier !== null || !choice.claimed_installation_id)
    throw new InstallFlowError('state_invalid');
  if (!(await mayConnect(choice.organization_id, userId)))
    throw new InstallFlowError('workspace_access_lost');
  return startConnect(
    db,
    config,
    { organizationId: choice.organization_id, userId },
    now,
    choice.claimed_installation_id,
  );
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

export type GithubStage = 'oauth_exchange' | 'installation_list' | 'repository_list' | 'authority' | 'revoke';

/** Workerd rejects redirect:error despite the DOM typings. Never follow redirects with credentials. */
async function githubRequest(
  f: Fetch,
  stage: GithubStage,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  const headers = new Headers(init.headers);
  headers.set('user-agent', 'lumi-noti');
  try {
    response = await f(url, {
      ...init,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(stage === 'revoke' ? 2000 : 10000),
    });
  } catch (error) {
    const timedOut = error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name);
    log('warn', 'github_install_request_failed', {
      stage,
      reason: timedOut ? 'timeout' : 'network_or_runtime',
    });
    throw new InstallFlowError('github_unavailable');
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    log('warn', 'github_install_request_failed', { stage, reason: 'redirect', status: response.status });
    throw new InstallFlowError('github_unavailable');
  }
  if (!response.ok)
    log('warn', 'github_install_request_failed', { stage, reason: 'http', status: response.status });
  return response;
}

async function githubJson(response: Response, stage: GithubStage): Promise<unknown> {
  try {
    const body = await readBodyCapped(response, stage === 'oauth_exchange' ? 16384 : 2 * 1024 * 1024);
    if (!body.ok) throw new Error('oversized');
    return JSON.parse(new TextDecoder().decode(body.bytes)) as unknown;
  } catch {
    log('warn', 'github_install_request_failed', {
      stage,
      reason: 'invalid_response',
      status: response.status,
    });
    throw new InstallFlowError('github_unavailable');
  }
}

async function exchangeCode(
  f: Fetch,
  config: GithubAppConfig,
  code: string,
  verifier: string,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: callbackUrl(config),
    code_verifier: verifier,
  });
  const response = await githubRequest(f, 'oauth_exchange', `${GITHUB_WEB}/login/oauth/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new InstallFlowError(
      response.status >= 500 || response.status === 429 ? 'github_unavailable' : 'oauth_failed',
    );
  }
  const reply = record(await githubJson(response, 'oauth_exchange'));
  const token = reply?.access_token;
  if (typeof token !== 'string' || token.length === 0 || token.length > 1024)
    throw new InstallFlowError('oauth_failed');
  return token;
}

async function getJson(f: Fetch, path: string, token: string): Promise<unknown> {
  const stage: GithubStage = path.startsWith('/user/installations/')
    ? 'repository_list'
    : path.startsWith('/user/installations?')
      ? 'installation_list'
      : 'authority';
  const response = await githubRequest(f, stage, `${GITHUB_API}${path}`, { headers: githubHeaders(token) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if ([401, 403, 404].includes(response.status)) throw new InstallFlowError('installation_not_accessible');
    throw new InstallFlowError('github_unavailable');
  }
  return githubJson(response, stage);
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
    if (
      typeof login !== 'string' ||
      !login ||
      login.length > 100 ||
      (type !== 'User' && type !== 'Organization')
    )
      throw new InstallFlowError('github_unavailable');
    if (typeof accountId !== 'number' || !Number.isSafeInteger(accountId) || accountId < 1)
      throw new InstallFlowError('github_unavailable');
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
  if (!Array.isArray(list)) throw new InstallFlowError('github_unavailable');
  return list.map((item) => {
    const r = record(item);
    if (
      !r ||
      typeof r.id !== 'number' ||
      !Number.isSafeInteger(r.id) ||
      r.id < 1 ||
      typeof r.full_name !== 'string' ||
      r.full_name.length > 300 ||
      !/^[^/]+\/[^/]+$/.test(r.full_name)
    )
      throw new InstallFlowError('github_unavailable');
    return { id: String(r.id), fullName: r.full_name };
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
    const entries = record(body)?.installations;
    if (!Array.isArray(entries)) throw new InstallFlowError('github_unavailable');
    found = pickInstallation(body, installationId, config.appId);
    const count = entries.length;
    if (count < 100) break;
  }
  if (!found) throw new InstallFlowError('installation_not_accessible');
  await verifyAuthority(f, token, found);

  // An 'all' installation's scope is its account; the repository list is never consulted
  // (tenant.ts), so it is not fetched or stored.
  if (found.repositorySelection === 'all') return { ...found, repositories: [] };

  const repositories: { id: string; fullName: string }[] = [];
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) {
      const extra = pickRepositories(
        await getJson(
          f,
          `/user/installations/${installationId}/repositories?per_page=1&page=${MAX_PAGES * 100 + 1}`,
          token,
        ),
      );
      if (extra.length) throw new InstallFlowError('installation_too_large');
      break;
    }
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
    const response = await githubRequest(
      f,
      'revoke',
      `${GITHUB_API}/applications/${encodeURIComponent(config.clientId)}/token`,
      {
        method: 'DELETE',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
          'x-github-api-version': GITHUB_API_VERSION,
          'user-agent': 'lumi-noti',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ access_token: token }),
      },
    );
    await response.body?.cancel().catch(() => undefined);
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
  params: { state: string | undefined; code: string | undefined },
  userId: string,
  now: number,
  mayConnect: WorkspaceCheck,
  // EGRESS-ALLOWED: GitHub App install verification (OAuth exchange, user installation check,
  // token revoke). Every URL is built from the GITHUB_API and GITHUB_WEB constants in this file;
  // nothing a tenant supplies selects the host (F228).
  f: Fetch = fetch,
): Promise<ConnectResult> {
  const verify = await consumeState(db, params.state, 'verify', userId, now);
  // The PKCE verifier has done its job once read; do not leave it at rest.
  await db
    .prepare('UPDATE github_auth_states SET pkce_verifier=NULL WHERE state_hash=?')
    .bind(await sha256Base64url(params.state ?? ''))
    .run();
  if (!params.code || params.code.length > 256 || !verify.pkce_verifier)
    throw new InstallFlowError('oauth_failed');
  // Membership or role may have changed since the flow started (10-minute window).
  if (!(await mayConnect(verify.organization_id, userId)))
    throw new InstallFlowError('workspace_access_lost');

  let claimed = verify.claimed_installation_id;
  const token = await exchangeCode(f, config, params.code, verify.pkce_verifier);
  try {
    let installation: VerifiedInstallation;
    try {
      if (!claimed) {
        const candidates: Omit<VerifiedInstallation, 'repositories'>[] = [];
        for (let page = 1; page <= MAX_PAGES; page++) {
          const body = await getJson(f, `/user/installations?per_page=100&page=${page}`, token);
          const entries = record(body)?.installations;
          if (!Array.isArray(entries)) throw new InstallFlowError('github_unavailable');
          for (const entry of entries) {
            const id = record(entry)?.id;
            if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) continue;
            const candidate = pickInstallation({ installations: [entry] }, String(id), config.appId);
            if (candidate && !candidates.some((c) => c.installationId === candidate.installationId))
              candidates.push(candidate);
          }
          if (candidates.length > 20) throw new InstallFlowError('installation_list_too_large');
          if (entries.length < 100) break;
          if (page === MAX_PAGES) throw new InstallFlowError('installation_list_too_large');
        }
        const who = { organizationId: verify.organization_id, userId };
        if (candidates.length === 0)
          return { organizationId: who.organizationId, next: await startInstall(db, config, who, now) };
        if (candidates.length > 1) {
          const choices: InstallationChoice[] = [];
          for (const candidate of candidates)
            choices.push({
              account: candidate.accountLogin,
              state: await createState(
                db,
                { purpose: 'verify', ...who, claimedInstallationId: candidate.installationId },
                now,
              ),
            });
          return {
            organizationId: who.organizationId,
            choices,
            install: await startInstall(db, config, who, now),
          };
        }
        claimed = candidates[0]?.installationId ?? null;
      }
      if (!claimed) throw new InstallFlowError('installation_not_accessible');
      installation = await verifyAccess(f, config, token, claimed);
    } finally {
      await revokeToken(f, config, token);
    }
    if (!(await mayConnect(verify.organization_id, userId)))
      throw new InstallFlowError('workspace_access_lost');
    const installationRowId = await bindInstallation(
      db,
      config.appId,
      verify.organization_id,
      userId,
      installation,
    );
    return { organizationId: verify.organization_id, installation, installationRowId };
  } catch (e) {
    // Attach the claimed id to refusals so the audit row can correlate repeated attempts.
    if (e instanceof InstallFlowError && !e.claimedInstallationId && claimed)
      throw new InstallFlowError(e.code, claimed);
    throw e;
  }
}

/**
 * Insert or refresh the installation for this workspace. A row bound to another workspace
 * is refused (the trigger in 0010 would also refuse it), as is an installation GitHub has
 * already told us was deleted. The repository set is replaced in the same batch.
 */
export async function bindInstallation(
  db: D1Database,
  appId: string,
  organizationId: string,
  userId: string,
  installation: VerifiedInstallation,
): Promise<string> {
  const tombstone = await db
    .prepare('SELECT 1 AS x FROM github_installation_tombstones WHERE installation_id=? AND app_id=?')
    .bind(installation.installationId, appId)
    .first();
  if (tombstone) throw new InstallFlowError('installation_deleted');

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
    db.prepare('DELETE FROM github_installation_repositories WHERE installation_row_id=?').bind(rowId),
    ...insertRepositories(db, rowId, installation.repositories),
  ]);
  // An uninstalled installation is never revived by a late bind; GitHub issues a new id on
  // reinstall.
  if (results[0]?.meta.changes !== 1) throw new InstallFlowError('installation_deleted');
  return rowId;
}
