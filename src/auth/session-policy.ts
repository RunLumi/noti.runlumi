/**
 * Session lifetime, in one dependency-free module so the retention matrix
 * (`src/compliance/retention.ts`) reads the value the auth configuration really uses.
 */
export const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30;
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;
/**
 * The longest a session lives however often it is used (ADR 0030). `SESSION_EXPIRES_IN_SECONDS` is an IDLE
 * limit that every day of use pushes out; without this bound a stolen session in daily use would never
 * end. Counted from sign-in (`session.created_at`). Enforced twice: exactly, on every request our own
 * routes handle (`src/auth/workspace.ts`), and for every other path (Better Auth's organization routes)
 * by the hourly purge deleting the row (`src/pipeline/expired-records.ts`).
 */
export const SESSION_ABSOLUTE_SECONDS = 60 * 60 * 24 * 90;

/**
 * How long an emailed password-reset link works (Better Auth's default, made explicit so a library
 * upgrade cannot change it silently). `tests/auth/credentials-policy.test.ts` shows it expiring.
 */
export const RESET_PASSWORD_TOKEN_EXPIRES_IN_SECONDS = 60 * 60;
/** How long an emailed verification link works (spec 02 F17). */
export const EMAIL_VERIFICATION_EXPIRES_IN_SECONDS = 60 * 60;
/** An invitation to join as an admin lives only 48 hours: it is worth more to whoever intercepts it. */
export const ADMIN_INVITATION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 2;
/**
 * How long an invitation can be accepted (spec 02 F21). Seven days: an admin invites a colleague who may
 * be away, and an invitation can be cancelled at any time. Better Auth's default is 48 hours.
 */
export const INVITATION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7;

/**
 * True when a session created at `createdAt` has outlived `SESSION_ABSOLUTE_SECONDS`. A garbled time counts as
 * past. An absent one does not: `session.created_at` is NOT NULL, so it is absent only in a test double,
 * and the hourly purge is the second enforcement for any row this misses.
 */
export function sessionPastAbsoluteLife(createdAt: unknown, now: number = Date.now()): boolean {
  if (createdAt === undefined || createdAt === null) return false;
  const created =
    createdAt instanceof Date
      ? createdAt.getTime()
      : typeof createdAt === 'number'
        ? createdAt
        : typeof createdAt === 'string'
          ? Date.parse(createdAt)
          : NaN;
  return !Number.isFinite(created) || now - created > SESSION_ABSOLUTE_SECONDS * 1000;
}
