import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api';
import { noteAuditFailure, recordAudit, recordDenial, requestOrigin, type AuditEntry } from '../audit/audit';
import { hit } from '../security/rate-limit';
import { sessionPastAbsoluteLife } from './session-policy';
import { log } from '../platform/log';

/**
 * Audit events for the changes Better Auth makes on its own routes (docs/specs/02 F28, ADR 0030): invitations,
 * membership, roles, and the sessions a password reset ends. Our own routes write their audit row in the same
 * D1 batch as the change; Better Auth owns these writes, so this is an `after` hook: it runs once the change
 * has been made and records it, and a failure to record is logged and never changes the response.
 *
 * What that means, plainly: the row is NOT atomic with the change. If the Worker dies between the two, the
 * change stands and the row is missing; `audit_write_failed` is logged when the insert itself fails. Closing
 * that gap would mean owning these writes, which this product deliberately does not do.
 *
 * Nothing the actor typed is stored: the invitee's address is a third party's data and stays out of the row;
 * the role is a closed value (`admin` or `member`, validated by `beforeCreateInvitation` and
 * `beforeUpdateMemberRole`); the ids are ours.
 */

/** The only role names the product has; anything else is dropped from the row rather than stored. */
const ROLES: ReadonlySet<string> = new Set(['admin', 'member']);
const role = (value: unknown): string | undefined =>
  typeof value === 'string' && ROLES.has(value) ? value : undefined;
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const rec = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/** The Better Auth routes this module audits, and the action each success is recorded as. */
export const AUDITED_PATHS = {
  '/organization/invite-member': 'member.invite',
  '/organization/accept-invitation': 'member.invite.accept',
  '/organization/reject-invitation': 'member.invite.reject',
  '/organization/cancel-invitation': 'member.invite.cancel',
  '/organization/update-member-role': 'member.role.change',
  '/organization/remove-member': 'member.remove',
  '/organization/leave': 'member.remove',
  '/reset-password': 'session.revoke_all',
  '/change-password': 'session.revoke_others',
} as const;
type AuditedPath = keyof typeof AUDITED_PATHS;
export const isAuditedPath = (path: string | undefined): path is AuditedPath =>
  path !== undefined && Object.hasOwn(AUDITED_PATHS, path);

export interface AuthChange {
  readonly path: AuditedPath;
  /** The value Better Auth returned for the request. */
  readonly returned: unknown;
  /** The signed-in person who made the request (null for a password reset, which needs no session). */
  readonly actorId: string | null;
  /** The role the member had before a role change, read before Better Auth changed it. */
  readonly previousRole?: string | undefined;
  /** Sessions ended by a password reset, counted just before they were. */
  readonly revokedSessions?: number | undefined;
  /** For a password reset: the person whose password it was. */
  readonly resetUserId?: string | undefined;
}

/**
 * The audit row for a successful change, or null when the response does not carry what a row needs (the
 * hook then records nothing rather than a row with holes). Pure, so every shape is tested without a server.
 */
export function entryFor(change: AuthChange): Omit<AuditEntry, 'ip' | 'userAgent'> | null {
  const action = AUDITED_PATHS[change.path];
  const out = rec(change.returned);
  switch (change.path) {
    case '/organization/invite-member':
    case '/organization/cancel-invitation': {
      const invitationId = text(out.id);
      const organizationId = text(out.organizationId);
      if (!invitationId || !organizationId) return null;
      const r = role(out.role);
      return base(action, change.actorId, organizationId, 'invitation', invitationId, r ? { role: r } : {});
    }
    case '/organization/accept-invitation': {
      const invitation = rec(out.invitation);
      const invitationId = text(invitation.id);
      const organizationId = text(invitation.organizationId);
      if (!invitationId || !organizationId) return null;
      const r = role(rec(out.member).role) ?? role(invitation.role);
      return base(action, change.actorId, organizationId, 'invitation', invitationId, r ? { role: r } : {});
    }
    case '/organization/reject-invitation': {
      const invitation = rec(out.invitation ?? out);
      const invitationId = text(invitation.id);
      const organizationId = text(invitation.organizationId);
      if (!invitationId || !organizationId) return null;
      return base(action, change.actorId, organizationId, 'invitation', invitationId, {});
    }
    case '/organization/update-member-role': {
      const userId = text(out.userId);
      const organizationId = text(out.organizationId);
      const now = role(out.role);
      if (!userId || !organizationId || !now) return null;
      const before = role(change.previousRole);
      return base(action, change.actorId, organizationId, 'member', userId, {
        role: now,
        ...(before ? { previousRole: before } : {}),
      });
    }
    case '/organization/remove-member':
    case '/organization/leave': {
      const member = rec(out.member ?? out);
      const userId = text(member.userId);
      const organizationId = text(member.organizationId);
      if (!userId || !organizationId) return null;
      const r = role(member.role);
      return base(action, change.actorId, organizationId, 'member', userId, {
        ...(r ? { role: r } : {}),
        self: userId === change.actorId,
      });
    }
    case '/change-password': {
      // Only when the person asked to end their other sessions; nothing else about a password change is recorded here.
      if (!change.actorId || !change.revokedSessions) return null;
      return base(action, change.actorId, null, 'session', null, { revoked: change.revokedSessions });
    }
    case '/reset-password': {
      if (out.status !== true || !change.resetUserId) return null;
      return base(action, change.resetUserId, null, 'session', null, {
        revoked: change.revokedSessions ?? 0,
        reason: 'password_reset',
      });
    }
  }
}

function base(
  action: AuditEntry['action'],
  actorId: string | null,
  organizationId: string | null,
  subjectType: AuditEntry['subjectType'],
  subjectId: string | null,
  metadata: NonNullable<AuditEntry['metadata']>,
): Omit<AuditEntry, 'ip' | 'userAgent'> {
  return { organizationId, actorId, action, subjectType, subjectId, outcome: 'success', metadata };
}

/** The capability a refused request lacked, for the denial row (the closed list of `AUDITED_PATHS`). */
const DENIED_CAPABILITY: Readonly<Record<string, string>> = {
  '/organization/invite-member': 'invitation.create',
  '/organization/cancel-invitation': 'invitation.cancel',
  '/organization/update-member-role': 'member.update',
  '/organization/remove-member': 'member.delete',
};

/**
 * `before` and `after` hooks for `betterAuth({ hooks })`. `previousRoles` and `pendingReset` are per-request
 * scratch: `createAuth` builds a new instance for every request, so nothing is shared between requests.
 */
export function createAuditHooks(db: D1Database) {
  const previousRoles = new Map<string, string>();
  const resets: { userId: string; revoked: number }[] = [];
  const changes: { revokedOthers: number } = { revokedOthers: 0 };

  /**
   * The 90-day absolute lifetime on Better Auth's OWN routes (`get-session`, the organization routes...): our
   * `currentSession` enforces it for our API, and the hourly purge deletes the row, but between the two a
   * session past its end would still work here. A request whose session cookie resolves to a session older than
   * the limit deletes that row and gets 401. Sign-out is left alone so the person can always clear the cookie.
   */
  async function enforceAbsoluteLife(ctx: Parameters<typeof getSessionFromCtx>[0]): Promise<void> {
    const cookie = ctx.headers?.get('cookie') ?? '';
    if (!cookie.includes('session_token') || ctx.path === '/sign-out') return;
    const session = await getSessionFromCtx(ctx).catch(() => null);
    if (!session || !sessionPastAbsoluteLife(session.session.createdAt)) return;
    await db.prepare('DELETE FROM "session" WHERE id=?1').bind(session.session.id).run();
    throw new APIError('UNAUTHORIZED', { message: 'Session expired' });
  }

  const before = createAuthMiddleware(async (ctx) => {
    await enforceAbsoluteLife(ctx);
    if (ctx.path === '/change-password' && rec(ctx.body).revokeOtherSessions === true) {
      const session = await getSessionFromCtx(ctx).catch(() => null);
      if (session) {
        const row = await db
          .prepare('SELECT COUNT(*) AS n FROM "session" WHERE user_id=?1 AND id<>?2')
          .bind(session.user.id, session.session.id)
          .first<{ n: number }>();
        changes.revokedOthers = Number(row?.n ?? 0);
      }
      return;
    }
    if (ctx.path !== '/organization/update-member-role') return;
    const memberId = text(rec(ctx.body).memberId);
    if (!memberId) return;
    // The workspace the request names, else the caller's active one: the read is scoped like every other.
    const session = await getSessionFromCtx(ctx).catch(() => null);
    const organizationId = text(rec(ctx.body).organizationId) ?? text(session?.session.activeOrganizationId);
    if (!organizationId) return;
    const row = await db
      .prepare('SELECT role FROM member WHERE id=?1 AND organization_id=?2')
      .bind(memberId, organizationId)
      .first<{ role: string }>();
    if (row) previousRoles.set(memberId, row.role);
  });

  const after = createAuthMiddleware(async (ctx) => {
    const path = ctx.path;
    if (!isAuditedPath(path)) return;
    const returned: unknown = ctx.context.returned;
    const headers = ctx.request?.headers ?? ctx.headers ?? new Headers();
    try {
      const session = ctx.context.session ?? (await getSessionFromCtx(ctx).catch(() => null));
      const actorId = session?.user.id ?? null;
      if (isAPIError(returned)) {
        if (returned.statusCode === 403 && path in DENIED_CAPABILITY)
          await recordRefusal(rec(ctx.body), path, actorId, headers);
        return;
      }
      const memberId = text(rec(ctx.body).memberId);
      const reset = path === '/reset-password' ? resets.at(-1) : undefined;
      const entry = entryFor({
        path,
        returned,
        actorId,
        previousRole: memberId ? previousRoles.get(memberId) : undefined,
        revokedSessions: reset?.revoked,
        resetUserId: reset?.userId,
        ...(path === '/change-password' ? { revokedSessions: changes.revokedOthers } : {}),
      });
      if (entry) await recordAudit(db, { ...entry, ...requestOrigin(headers) });
    } catch {
      log('error', 'audit_write_failed', { action: AUDITED_PATHS[path] });
      await noteAuditFailure(db);
    }
  });

  /** Called by `emailAndPassword.onPasswordReset`, just before Better Auth ends the person's sessions. */
  async function noteReset(userId: string): Promise<void> {
    const row = await db
      .prepare('SELECT COUNT(*) AS n FROM "session" WHERE user_id=?1')
      .bind(userId)
      .first<{ n: number }>();
    resets.push({ userId, revoked: Number(row?.n ?? 0) });
  }

  async function recordRefusal(
    body: Record<string, unknown>,
    path: AuditedPath,
    actorId: string | null,
    headers: Headers,
  ): Promise<void> {
    const organizationId = text(body.organizationId);
    if (!actorId || !organizationId) return;
    // Only a member's refused request is recorded in a workspace's log: a stranger naming a workspace they do
    // not belong to must not be able to write into it.
    const member = await db
      .prepare('SELECT role FROM member WHERE user_id=?1 AND organization_id=?2')
      .bind(actorId, organizationId)
      .first<{ role: string }>();
    if (!member) return;
    // A plain member repeating a refused request must not flood the workspace log: 10 a minute per person.
    if ((await hit(db, `auth-denial:${actorId}`, 10, 60_000)).limited) return;
    await recordDenial(db, {
      organizationId,
      actorId,
      action: 'access.denied',
      subjectType: 'capability',
      subjectId: DENIED_CAPABILITY[path] ?? null,
      outcome: 'denied',
      metadata: { role: member.role },
      ...requestOrigin(headers),
    });
  }

  return { before, after, noteReset };
}
