import { Hono, type Context } from 'hono';
import { recordAudit, requestOrigin } from '../audit/audit';
import { can } from '../auth/permissions';
import { authorize, currentSession, isFailure } from '../auth/workspace';
import { githubAppConfig } from '../connectors/sources/github/app-config';
import {
  completeVerification,
  continueFromSetup,
  InstallFlowError,
  startInstall,
  type InstallError,
} from '../connectors/sources/github/install';
import type { Bindings } from '../env';
import { log } from '../platform/log';
import { isDeletionPending } from './workspace-lifecycle';

/**
 * GitHub connection endpoints (F56, F57, F67; ADR 0008).
 *
 * `/api/github/*` is the JSON API used by the dashboard. `/github/setup` and
 * `/github/callback` are browser redirects from GitHub: they need the user's session, and
 * every outcome ends in a redirect back to the dashboard with a short status code, never
 * an error page that echoes a parameter.
 */
type Ctx = Context<{ Bindings: Bindings }>;

export const api = new Hono<{ Bindings: Bindings }>();
export const browser = new Hono<{ Bindings: Bindings }>();

/** Membership and role are re-read at each browser step; they may change mid-flow. */
function mayConnect(db: D1Database) {
  return async (organizationId: string, userId: string): Promise<boolean> => {
    const row = await db
      .prepare('SELECT role FROM member WHERE organization_id=? AND user_id=?')
      .bind(organizationId, userId)
      .first<{ role: string }>();
    return (
      row !== null && can(row.role, 'integration.create') && !(await isDeletionPending(db, organizationId))
    );
  };
}

function backToDashboard(
  c: Ctx,
  status: 'connected' | InstallError | 'not_configured' | 'signin_required',
): Response {
  const url = new URL('/integrations', c.env.APP_ORIGIN);
  url.searchParams.set('github', status);
  return c.redirect(url.toString(), 302);
}

api.post('/install', async (c) => {
  const origin = c.req.header('origin');
  if (!origin || origin !== new URL(c.env.APP_ORIGIN).origin) return c.json({ error: 'Forbidden' }, 403);
  const config = githubAppConfig(c.env);
  if (!config) return c.json({ error: 'GitHub App is not configured on this server' }, 503);
  const who = await authorize(c, 'integration.create');
  if (isFailure(who)) return c.json({ error: who.error }, who.status);
  if (await isDeletionPending(c.env.DB, who.orgId))
    return c.json({ error: 'This workspace is scheduled for deletion.' }, 409);
  const url = await startInstall(
    c.env.DB,
    config,
    { organizationId: who.orgId, userId: who.userId },
    Date.now(),
  );
  return c.json({ url });
});

interface InstallationRow {
  id: string;
  installation_id: string;
  account_login: string;
  account_type: string;
  repository_selection: string;
  status: string;
  updated_at: string | null;
  repositories_complete: number;
}

api.get('/installations', async (c) => {
  const who = await authorize(c, 'integration.read');
  if (isFailure(who)) return c.json({ error: who.error }, who.status);
  const installations = await c.env.DB.prepare(
    `SELECT id,installation_id,account_login,account_type,repository_selection,status,updated_at,repositories_complete
     FROM github_installations WHERE organization_id=? ORDER BY account_login`,
  )
    .bind(who.orgId)
    .all<InstallationRow>();
  const repos = await c.env.DB.prepare(
    `SELECT r.installation_row_id AS installation_row_id, r.full_name AS full_name
     FROM github_installation_repositories r JOIN github_installations i ON i.id=r.installation_row_id
     WHERE i.organization_id=? ORDER BY r.full_name LIMIT 2000`,
  )
    .bind(who.orgId)
    .all<{ installation_row_id: string; full_name: string }>();
  return c.json({
    configured: githubAppConfig(c.env) !== null,
    installations: installations.results.map((i) => ({
      id: i.id,
      account: i.account_login,
      accountType: i.account_type,
      repositorySelection: i.repository_selection,
      status: i.status,
      updatedAt: i.updated_at,
      // The stored repository set may be incomplete; reconnecting resyncs it.
      needsResync: i.repositories_complete === 0,
      repositories: repos.results.filter((r) => r.installation_row_id === i.id).map((r) => r.full_name),
    })),
  });
});

browser.get('/setup', async (c) => {
  const config = githubAppConfig(c.env);
  if (!config) return backToDashboard(c, 'not_configured');
  const session = await currentSession(c);
  if (!session) return backToDashboard(c, 'signin_required');
  try {
    const next = await continueFromSetup(
      c.env.DB,
      config,
      { state: c.req.query('state'), installationId: c.req.query('installation_id') },
      session.user.id,
      Date.now(),
      mayConnect(c.env.DB),
    );
    return c.redirect(next, 302);
  } catch (e) {
    if (e instanceof InstallFlowError) return backToDashboard(c, e.code);
    log('error', 'github_setup_failed');
    return backToDashboard(c, 'unexpected_error');
  }
});

browser.get('/callback', async (c) => {
  const config = githubAppConfig(c.env);
  if (!config) return backToDashboard(c, 'not_configured');
  const session = await currentSession(c);
  if (!session) return backToDashboard(c, 'signin_required');
  const origin = requestOrigin(c.req.raw.headers);
  try {
    // The `github.installation.bind` row is written in the bind's own batch: if it cannot be written,
    // nothing is bound and the person lands on the generic error below (F236).
    await completeVerification(
      c.env.DB,
      config,
      { state: c.req.query('state'), code: c.req.query('code'), origin },
      session.user.id,
      Date.now(),
      mayConnect(c.env.DB),
    );
    return backToDashboard(c, 'connected');
  } catch (e) {
    if (!(e instanceof InstallFlowError)) {
      // Never a blank 500 from a browser redirect: the user lands back on the dashboard.
      log('error', 'github_callback_failed');
      return backToDashboard(c, 'unexpected_error');
    }
    if (
      e.code === 'installation_bound_elsewhere' ||
      e.code === 'installation_not_accessible' ||
      e.code === 'installation_admin_required'
    ) {
      // The attempt is recorded against no workspace's data: the claimed installation may
      // belong to someone else, and we do not reveal which workspace holds it.
      await recordAudit(c.env.DB, {
        organizationId: null,
        actorId: session.user.id,
        action: 'github.installation.bind_refused',
        subjectType: 'github_installation',
        subjectId: null,
        outcome: 'denied',
        ...origin,
        // The claimed id is GitHub's public identifier, not a secret; it lets an operator
        // correlate repeated attempts against the same installation.
        metadata: { reason: e.code, claimedInstallationId: e.claimedInstallationId ?? null },
      });
    }
    return backToDashboard(c, e.code);
  }
});
