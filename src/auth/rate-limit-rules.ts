/**
 * Better Auth's per-route limits (spec 02 F22), in one dependency-free module so `tests/auth/rate-limit.test.ts`
 * drives every rule from the same table the deployed configuration uses. Keyed by Better Auth path (no
 * `/api/auth` prefix); `window` is in seconds. The counters live in the `rate_limit` table (storage
 * `database`), so the limit holds across Worker instances.
 *
 * These are ABUSE controls for the authentication endpoints only. Webhook ingress has its own limiter
 * (`src/security/rate-limit.ts`, F29) and nothing here may be reused for quota or billing.
 */
export interface AuthRateRule {
  readonly window: number;
  readonly max: number;
}

export const AUTH_DEFAULT_RATE: AuthRateRule = { window: 60, max: 60 };

export const AUTH_RATE_RULES = {
  '/sign-up/email': { window: 600, max: 4 },
  '/sign-in/email': { window: 60, max: 5 },
  '/request-password-reset': { window: 900, max: 3 },
  '/send-verification-email': { window: 900, max: 3 },
  '/organization/invite-member': { window: 60, max: 5 },
  '/sign-in/passkey': { window: 60, max: 10 },
} as const satisfies Readonly<Record<string, AuthRateRule>>;
