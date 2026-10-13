import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { organization } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { sendAuthEmail, type EmailEnvironment } from './email';
import { ac, roles, isOrgRole } from './permissions';

export interface AuthBindings extends EmailEnvironment {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
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
    if (executionCtx) executionCtx.waitUntil(promise);
    else return promise;
  };
  const ensureNotMember = async (userId: string) => {
    const existing = await db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(eq(schema.member.userId, userId))
      .limit(1);
    if (existing.length)
      throw new APIError('FORBIDDEN', { message: 'An account can belong to only one organization' });
  };

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
      expiresIn: 3600,
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
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    advanced: {
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 60,
      customRules: {
        '/sign-up/email': { window: 600, max: 4 },
        '/sign-in/email': { window: 60, max: 5 },
        '/request-password-reset': { window: 900, max: 3 },
        '/send-verification-email': { window: 900, max: 3 },
        '/organization/invite-member': { window: 60, max: 5 },
        '/sign-in/passkey': { window: 60, max: 10 },
      },
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
        sendInvitationEmail: async ({ id, email, organization: org }) => {
          await send({
            to: email,
            subject: "You're invited to Lumi Noti",
            intro: 'You have been invited to join ' + org.name + ' on Lumi Noti:',
            url: new URL('/invite?id=' + encodeURIComponent(id), env.APP_ORIGIN).toString(),
          });
        },
        organizationHooks: {
          beforeCreateOrganization: async ({ user }) => {
            await ensureNotMember(user.id);
          },
          beforeAddMember: async ({ user }) => {
            await ensureNotMember(user.id);
          },
          beforeAcceptInvitation: async ({ user }) => {
            if (!user.emailVerified) throw new APIError('FORBIDDEN', { message: 'Verify your email first' });
            await ensureNotMember(user.id);
          },
          // These guards only validate the role name and have nothing to await, but the
          // organizationHooks contract requires a Promise return — a sync function fails to
          // typecheck against Better Auth's hook signature.
          /* eslint-disable @typescript-eslint/require-await */
          beforeCreateInvitation: async ({ invitation }) => {
            if (!isOrgRole(invitation.role)) throw new APIError('BAD_REQUEST', { message: 'Invalid role' });
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
