import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { organization } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/d1';
import { and, eq, gt, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { sendAuthEmail, type EmailEnvironment } from './email';
import { ac, roles, isOrgRole } from './permissions';
import { log } from '../platform/log';
import { settleBackground } from '../platform/background';
import { createAuditHooks } from './audit-hooks';
import { AUTH_DEFAULT_RATE, AUTH_RATE_RULES } from './rate-limit-rules';
import { allowlistOf, signupMode, signupRefusal } from './signup-policy';
import {
  ADMIN_INVITATION_EXPIRES_IN_SECONDS,
  EMAIL_VERIFICATION_EXPIRES_IN_SECONDS,
  INVITATION_EXPIRES_IN_SECONDS,
  RESET_PASSWORD_TOKEN_EXPIRES_IN_SECONDS,
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
} from './session-policy';

export interface AuthBindings extends EmailEnvironment {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  /** `open` (default when unset), `invite_only` or `closed` (src/auth/signup-policy.ts, ADR 0047). */
  SIGNUP_MODE?: string;
  /** Exact addresses that may sign up while `invite_only` (the first operator has no one to invite them). */
  SIGNUP_ALLOWLIST?: string;
}

/**
 * The narrow slice of the Workers execution context this module actually uses.
 *
 * Declared structurally on purpose: Cloudflare's own `ExecutionContext` gained a type
 * parameter in @cloudflare/workers-types v5, so hand-annotating it couples us to a type
 * that changes shape across majors. Depending on what we consume keeps the module testable
 * and immune to that churn. Hono's `c.executionCtx` satisfies this structurally.
 */
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export function createAuth(env: AuthBindings, executionCtx?: ExecutionContextLike) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32)
    throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters');
  if (!env.APP_ORIGIN || !env.AUTH_FROM_EMAIL || !env.AUTH_EMAIL)
    throw new Error('Missing Cloudflare Email Sending binding or required origin/sender');
  const origin = new URL(env.APP_ORIGIN);
  const db = drizzle(env.DB, { schema });
  const send = (input: Parameters<typeof sendAuthEmail>[1]) => {
    const promise = sendAuthEmail(env, input);
    if (executionCtx) executionCtx.waitUntil(settleBackground(promise, 'auth_email_send'));
    else return promise;
  };
  const audit = createAuditHooks(env.DB);
  return betterAuth({
    appName: 'Lumi Noti',
    baseURL: env.APP_ORIGIN,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_ORIGIN],
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    emailAndPassword: {
      enabled: true,
      autoSignIn: false,
      requireEmailVerification: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: RESET_PASSWORD_TOKEN_EXPIRES_IN_SECONDS,
      // Counts the sessions about to be ended so the audit row can say how many (src/auth/audit-hooks.ts).
      // Best effort: a failure to count must never turn a successful password change into an error.
      onPasswordReset: async ({ user }) => {
        try {
          await audit.noteReset(user.id);
        } catch {
          log('error', 'audit_note_failed', { action: 'session.revoke_all' });
        }
      },
      sendResetPassword: async ({ user, url }) => {
        await send({
          to: user.email,
          subject: 'Reset your Lumi Noti password',
          intro: 'Use this one-time link to reset your password:',
          url,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      expiresIn: EMAIL_VERIFICATION_EXPIRES_IN_SECONDS,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }) => {
        await send({
          to: user.email,
          subject: 'Verify your Lumi Noti email',
          intro: 'Verify your email to activate your Lumi Noti account:',
          url,
        });
      },
    },
    hooks: { before: audit.before, after: audit.after },
    session: { expiresIn: SESSION_EXPIRES_IN_SECONDS, updateAge: SESSION_UPDATE_AGE_SECONDS },
    databaseHooks: {
      user: {
        create: {
          // Every account-creating path (password sign-up, and any future one) passes here, so the beta's
          // invite-only rule and the kill switch hold for all of them (ADR 0047).
          before: async (user) => {
            const refusal = await signupRefusal({
              mode: signupMode(env.SIGNUP_MODE),
              email: user.email,
              allowlist: allowlistOf(env.SIGNUP_ALLOWLIST),
              hasPendingInvitation: async (email) => {
                // Across workspaces on purpose: an invitation to any workspace admits the address. Reads only
                // existence; nothing about the inviting workspace reaches the caller.
                const found = await db
                  .select({ id: schema.invitation.id })
                  .from(schema.invitation)
                  .where(
                    and(
                      eq(sql`lower(${schema.invitation.email})`, email),
                      eq(schema.invitation.status, 'pending'),
                      gt(schema.invitation.expiresAt, new Date()),
                    ),
                  )
                  .limit(1);
                return found.length > 0;
              },
            });
            if (refusal) {
              log('info', 'signup_refused', { reason: refusal });
              throw new APIError('FORBIDDEN', {
                code: refusal.toUpperCase(),
                message:
                  refusal === 'signup_closed'
                    ? 'New accounts are not being created right now'
                    : 'Sign-up is by invitation only',
              });
            }
          },
        },
      },
      session: {
        create: {
          // A new session starts in the user's earliest workspace, so a member of several
          // is never left without an active one (every workspace route would answer 403).
          before: async (session) => {
            // No session for an address nobody has proved they own. Password sign-in already refuses it
            // (`requireEmailVerification`), but a passkey sign-in does not: Better Auth creates the session
            // for any account that holds the credential. Our own routes would still answer 401 (workspace.ts
            // checks `emailVerified`), but Better Auth's organization routes under /api/auth would not, so the
            // refusal belongs where every session is born (spec 02 F19, tests/auth/passkeys.test.ts).
            const owner = await db
              .select({ verified: schema.user.emailVerified })
              .from(schema.user)
              .where(eq(schema.user.id, session.userId))
              .limit(1);
            if (!owner[0]?.verified) throw new APIError('FORBIDDEN', { message: 'Verify your email first' });
            const first = await db
              .select({ organizationId: schema.member.organizationId })
              .from(schema.member)
              .where(eq(schema.member.userId, session.userId))
              .orderBy(schema.member.createdAt, schema.member.organizationId)
              .limit(1);
            const organizationId = first[0]?.organizationId;
            return { data: organizationId ? { ...session, activeOrganizationId: organizationId } : session };
          },
        },
      },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: AUTH_DEFAULT_RATE.window,
      max: AUTH_DEFAULT_RATE.max,
      customRules: AUTH_RATE_RULES,
    },
    plugins: [
      passkey({
        rpID: origin.hostname,
        rpName: 'Lumi Noti',
        origin: origin.origin,
      }),
      organization({
        ac,
        roles,
        creatorRole: 'admin',
        // No organizationLimit: a user may belong to several workspaces.
        // docs/PRODUCT.md names "agency/operator: needs many customer workspaces"
        // as a target audience, which a cap of 1 excludes outright.
        // Isolation comes from organization_id predicates on our own tables
        // (docs/specs/02 F24-F27), never from membership cardinality.
        disableOrganizationDeletion: true,
        requireEmailVerificationOnInvitation: true,
        invitationExpiresIn: INVITATION_EXPIRES_IN_SECONDS,
        sendInvitationEmail: async ({ id, email, organization: org }) => {
          await send({
            to: email,
            subject: "You're invited to Lumi Noti",
            intro: 'You have been invited to join ' + org.name + ' on Lumi Noti:',
            url: new URL('/invite?id=' + encodeURIComponent(id), env.APP_ORIGIN).toString(),
          });
        },
        organizationHooks: {
          // No one-workspace-per-user rule: an agency or operator belongs to many
          // workspaces (docs/PRODUCT.md audience #4). Isolation is organization_id
          // predicates on our own tables, never membership cardinality.
          // eslint-disable-next-line @typescript-eslint/require-await -- hook contract requires a Promise.
          beforeAcceptInvitation: async ({ user }) => {
            if (!user.emailVerified) throw new APIError('FORBIDDEN', { message: 'Verify your email first' });
          },
          // These guards only validate the role name and have nothing to await, but the
          // organizationHooks contract requires a Promise return — a sync function fails to
          // typecheck against Better Auth's hook signature.
          /* eslint-disable @typescript-eslint/require-await */
          beforeCreateInvitation: async ({ invitation }) => {
            if (!isOrgRole(invitation.role)) throw new APIError('BAD_REQUEST', { message: 'Invalid role' });
            // An invitation that makes someone an admin is a more valuable thing to intercept: it lives 48 hours.
            if (invitation.role === 'admin')
              return {
                data: {
                  ...invitation,
                  expiresAt: new Date(Date.now() + ADMIN_INVITATION_EXPIRES_IN_SECONDS * 1000),
                },
              };
          },
          beforeUpdateMemberRole: async ({ newRole }) => {
            if (!isOrgRole(newRole))
              throw new APIError('BAD_REQUEST', { message: 'Only admin and member roles are supported' });
          },
          /* eslint-enable @typescript-eslint/require-await */
        },
      }),
    ],
  });
}

export type NotiAuth = ReturnType<typeof createAuth>;
