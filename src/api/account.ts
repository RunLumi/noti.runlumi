import { Hono, type Context } from 'hono';
import { auditStatement, recordAudit, requestOrigin } from '../audit/audit';
import { currentSession } from '../auth/workspace';
import type { Bindings } from '../env';
import { sendNoticeEmail } from '../auth/email';
import { asRecord } from '../lib/json';
import { log } from '../platform/log';
import { hit } from '../security/rate-limit';

/**
 * Data-subject access and erasure for the signed-in person (docs/specs/15 F238, docs/DSAR.md).
 *
 *  - `GET    /api/workspace/me/data-export`  the person's own data, as JSON.
 *  - `DELETE /api/workspace/me`              erase the person's account.
 *
 * Both act on the caller's own identity and nothing else: the user id comes from the verified
 * session, never from the request. They are mounted under `/api/workspace/me`, so the central
 * Origin check (`requireSameOrigin`) covers the DELETE.
 *
 * What the export deliberately leaves out, and why:
 *  - credentials of any kind: session tokens and row ids, the password hash, OAuth tokens, the
 *    passkey public key, credential id and counter;
 *  - other people's data: the invitee address on an invitation the person sent, other members of a
 *    workspace, and the subject and metadata of audit rows (they describe workspace objects, which
 *    the workspace admins already receive through the workspace export).
 * Audit rows where the person is the actor ARE included, with the IP address and user agent that
 * were recorded, because that is personal data about them.
 */
export const EXPORT_ROW_LIMIT = 2000;
export const EXPORTS_PER_HOUR = 5;
export const ERASURES_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;
/** Erasure needs a session created this recently: a stolen cookie is rarely fresh (H1). */
export const FRESH_SESSION_MS = 10 * 60 * 1000;
/** Raised by the last-admin trigger (migration 0005, 0011). The only error that means "refused". */
const LAST_ADMIN_TRIGGER = 'organization requires an admin';
const SECURITY_REPORT_URL = 'https://github.com/RunLumi/noti.runlumi/security/advisories/new';

/** True when the session was created (signed in) within the freshness window. */
export function isFreshSession(createdAt: unknown, now: number = Date.now()): boolean {
  const created = createdAt instanceof Date ? createdAt.getTime() : Date.parse(String(createdAt));
  return Number.isFinite(created) && created <= now + 60_000 && now - created <= FRESH_SESSION_MS;
}

type Ctx = Context<{ Bindings: Bindings }>;

const account = new Hono<{ Bindings: Bindings }>();

function tooMany(c: Ctx, retryAfterSeconds: number): Response {
  return c.json({ error: 'Too many requests; try again later' }, 429, {
    'retry-after': String(retryAfterSeconds),
    'cache-control': 'no-store',
  });
}

account.get('/data-export', async (c) => {
  const s = await currentSession(c);
  if (!s) return c.json({ error: 'Unauthorized' }, 401);
  const userId = s.user.id;

  // A cross-site page cannot read the answer (no CORS), but refuse its request outright too (L2):
  // a browser that says the request is not from our own origin, or a user action, is not our dashboard.
  const site = c.req.header('sec-fetch-site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none')
    return c.json({ error: 'Forbidden' }, 403);

  const limit = await hit(c.env.DB, `dsar-export:${userId}`, EXPORTS_PER_HOUR, HOUR_MS);
  if (limit.limited) return tooMany(c, limit.retryAfterSeconds);

  const db = c.env.DB;
  // Every statement is bound to the verified user id. Column lists are explicit, never SELECT *.
  const [user, memberships, sessions, accounts, passkeys, invitations, audit] = await db.batch([
    db
      .prepare('SELECT id,name,email,email_verified,image,created_at,updated_at FROM "user" WHERE id=?')
      .bind(userId),
    db
      .prepare(
        `SELECT m.organization_id AS workspace_id, o.name AS workspace_name, m.role AS role, m.created_at AS joined_at
         FROM member m JOIN organization o ON o.id=m.organization_id WHERE m.user_id=? ORDER BY m.created_at`,
      )
      .bind(userId),
    db
      .prepare(
        `SELECT created_at,updated_at,expires_at,ip_address,user_agent,active_organization_id
         FROM "session" WHERE user_id=? ORDER BY created_at DESC`,
      )
      .bind(userId),
    db
      .prepare('SELECT provider_id,created_at FROM "account" WHERE user_id=? ORDER BY created_at')
      .bind(userId),
    db
      .prepare(
        'SELECT name,device_type,backed_up,transports,created_at FROM passkey WHERE user_id=? ORDER BY created_at',
      )
      .bind(userId),
    db
      .prepare(
        // The invitee address is a third party's data and is not selected.
        `SELECT organization_id AS workspace_id, role, status, expires_at, created_at
         FROM invitation WHERE inviter_id=? ORDER BY created_at`,
      )
      .bind(userId),
    db
      .prepare(
        // No subject_id and no metadata_json: they describe workspace objects, not the person.
        `SELECT organization_id AS workspace_id, action, subject_type, outcome, ip, user_agent, created_at
         FROM audit_events WHERE actor_id=? ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(userId, EXPORT_ROW_LIMIT + 1),
  ]);

  await recordAudit(db, {
    organizationId: null,
    actorId: userId,
    action: 'account.export',
    subjectType: 'organization',
    subjectId: null,
    outcome: 'success',
    ...requestOrigin(c.req.raw.headers),
  });

  const auditRows = audit?.results ?? [];
  const body = {
    format: 'lumi-noti-account-export/v1',
    exportedAt: new Date().toISOString(),
    credentialsIncluded: false,
    notes: [
      'Contains only data about you. Workspace content (integrations, deliveries, notification text) belongs to the workspace; its admins can export it.',
      'Session tokens, password hashes and passkey keys are never included.',
      'Audit rows that name you as the actor are included without the object they refer to.',
    ],
    user: user?.results[0] ?? null,
    memberships: memberships?.results ?? [],
    sessions: sessions?.results ?? [],
    signInMethods: accounts?.results ?? [],
    passkeys: passkeys?.results ?? [],
    invitationsSent: invitations?.results ?? [],
    auditEventsAsActor: auditRows.slice(0, EXPORT_ROW_LIMIT),
    rowLimit: EXPORT_ROW_LIMIT,
    truncated: { auditEventsAsActor: auditRows.length > EXPORT_ROW_LIMIT },
  };
  return c.json(body, 200, {
    'content-disposition': 'attachment; filename="lumi-noti-account-export.json"',
    'cache-control': 'no-store',
  });
});

interface SoleAdminWorkspace {
  workspace_id: string;
  workspace_name: string;
  other_members: number;
}

/** Workspaces where the person is the only admin: erasing them would leave the workspace with none. */
async function soleAdminWorkspaces(db: D1Database, userId: string): Promise<SoleAdminWorkspace[]> {
  const rows = await db
    .prepare(
      `SELECT m.organization_id AS workspace_id, o.name AS workspace_name,
              (SELECT COUNT(*) FROM member x WHERE x.organization_id=m.organization_id AND x.user_id<>m.user_id) AS other_members
       FROM member m JOIN organization o ON o.id=m.organization_id
       WHERE m.user_id=? AND m.role='admin'
         AND NOT EXISTS (SELECT 1 FROM member a WHERE a.organization_id=m.organization_id AND a.role='admin' AND a.user_id<>m.user_id)`,
    )
    .bind(userId)
    .all<SoleAdminWorkspace>();
  return rows.results;
}

account.delete('/', async (c) => {
  // Repeats the central Origin check so this file stands on its own.
  const origin = c.req.header('origin');
  if (!origin || origin !== new URL(c.env.APP_ORIGIN).origin) return c.json({ error: 'Forbidden' }, 403);
  const s = await currentSession(c);
  if (!s) return c.json({ error: 'Unauthorized' }, 401);
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json'))
    return c.json({ error: 'Expected application/json' }, 415);
  const userId = s.user.id;

  // Step-up (H1): a stolen session cookie must not be enough to erase an account. The person signs in
  // again (password or passkey), which creates a new session, and retries. Better Auth's own
  // `session.freshAge` is only enforced on its own routes, so the check is ours, on `createdAt`
  // (`updatedAt` moves on every refresh).
  if (!isFreshSession(s.session.createdAt))
    return c.json({ error: 'reauth_required' }, 403, { 'cache-control': 'no-store' });

  const limit = await hit(c.env.DB, `dsar-erase:${userId}`, ERASURES_PER_HOUR, HOUR_MS);
  if (limit.limited) return tooMany(c, limit.retryAfterSeconds);

  // Typing the account email is the confirmation: a stray request cannot erase an account.
  const body: unknown = await c.req.json().catch(() => null);
  const confirm = asRecord(body)?.confirm;
  if (typeof confirm !== 'string' || confirm.trim().toLowerCase() !== s.user.email.toLowerCase())
    return c.json(
      { error: 'Type your account email address exactly to confirm.', fields: [{ field: 'confirm' }] },
      422,
    );

  const db = c.env.DB;
  const blockers = await soleAdminWorkspaces(db, userId);
  if (blockers.length > 0)
    return c.json(
      {
        error:
          'You are the only admin of a workspace. Make another member an admin, or schedule the workspace for deletion and wait for it to finish, then delete your account.',
        blockers: blockers.map((b) => ({
          workspaceId: b.workspace_id,
          workspaceName: b.workspace_name,
          otherMembers: b.other_members,
          action: b.other_members > 0 ? 'transfer_admin_role' : 'delete_workspace',
        })),
      },
      409,
    );

  const memberships = await db
    .prepare('SELECT organization_id FROM member WHERE user_id=?')
    .bind(userId)
    .all<{ organization_id: string }>();
  // The erasure row carries no IP address or user agent (L5): it would outlive the person it describes.
  const record = (organizationId: string | null) =>
    auditStatement(db, {
      organizationId,
      actorId: userId,
      action: 'account.delete',
      subjectType: 'organization',
      subjectId: organizationId,
      outcome: 'success',
    });

  // Tell the address on file before anything is deleted, so a takeover cannot erase silently. Best
  // effort: a send failure is logged and never blocks (or reveals) the erasure.
  try {
    await sendNoticeEmail(c.env, {
      to: s.user.email,
      subject: 'Your Lumi Noti account is being deleted',
      text: `A request to delete your Lumi Noti account was just accepted, and your account, sessions and memberships are being removed. Workspaces you belonged to are not deleted.\n\nIf this was not you, someone was signed in as you. Report it privately: ${SECURITY_REPORT_URL}`,
    });
  } catch (error) {
    log('warn', 'account_deletion_notice_failed', { error });
  }

  try {
    await db.batch([
      // One audit row per workspace the person leaves (its admins can see that a member erased their
      // account, not who: the actor id no longer resolves to a person), or one without a workspace.
      ...(memberships.results.length > 0
        ? memberships.results.map((m) => record(m.organization_id))
        : [record(null)]),
      db.prepare('DELETE FROM github_auth_states WHERE user_id=?').bind(userId),
      // Pending invitations this person sent belong to the invitee too (M1): hand each to another admin of
      // the same workspace so the cascade below does not delete them. Guarded, because inviter_id is
      // NOT NULL; with no other admin the row is left to the cascade.
      db
        .prepare(
          `UPDATE invitation SET inviter_id=(
             SELECT a.user_id FROM member a
             WHERE a.organization_id=invitation.organization_id AND a.role='admin' AND a.user_id<>?1
             ORDER BY a.created_at, a.id LIMIT 1)
           WHERE inviter_id=?1 AND status='pending' AND EXISTS (
             SELECT 1 FROM member a
             WHERE a.organization_id=invitation.organization_id AND a.role='admin' AND a.user_id<>?1)`,
        )
        .bind(userId),
      // Invitations addressed to this person's email belong to them as well. Invitations they SENT go
      // with the cascade from `user` below.
      db.prepare('DELETE FROM invitation WHERE lower(email)=lower(?)').bind(s.user.email),
      // Cascades: sessions, sign-in methods, passkeys, memberships, invitations sent.
      db.prepare('DELETE FROM "user" WHERE id=?').bind(userId),
    ]);
  } catch (error) {
    // The batch is one transaction, so nothing was changed. Only the last-admin trigger means "refused"
    // (another admin was removed after the check above); anything else is a fault, not a conflict (M2).
    if (error instanceof Error && error.message.includes(LAST_ADMIN_TRIGGER))
      return c.json(
        { error: 'Your workspaces changed while this ran. Nothing was deleted; try again.' },
        409,
      );
    log('error', 'account_erase_failed', { error });
    return c.json({ error: 'Something went wrong. Nothing was deleted; try again later.' }, 500);
  }

  return c.json({ deleted: true }, 200, {
    'cache-control': 'no-store',
    // The session row is gone; ask the browser to drop the now-useless cookies too.
    'clear-site-data': '"cookies"',
  });
});

export default account;
