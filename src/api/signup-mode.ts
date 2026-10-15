import type { Context } from 'hono';
import type { Bindings } from '../env';
import { signupMode, type SignupMode } from '../auth/signup-policy';

/**
 * How long a browser or edge cache may keep the answer. Changing `SIGNUP_MODE` needs a deploy, so a minute is
 * short enough that the `closed` kill switch reaches the sign-up page almost at once (ADR 0048).
 */
export const SIGNUP_MODE_MAX_AGE_SECONDS = 60;

export interface SignupModeAnswer {
  readonly mode: SignupMode;
}

/**
 * `GET /api/public/signup-mode` (ADR 0048): the deployment's sign-up mode, so the sign-up page can say up front
 * that sign-up is by invitation or closed. Better Auth answers a refused sign-up with the same 200 as an
 * accepted one, so without this a refused visitor is told to check an inbox that stays empty.
 *
 * Public on purpose and deployment-wide only: it takes no input, reads no database row, and answers the same to
 * everyone. It never says whether an address holds an invitation or is on `SIGNUP_ALLOWLIST`; that decision
 * stays inside Better Auth's `user.create.before` hook, where the anti-enumeration answer protects it. An
 * unknown `SIGNUP_MODE` value reads as `closed`, exactly as the hook treats it.
 */
export function signupModeRoute(c: Context<{ Bindings: Bindings }>): Response {
  const answer: SignupModeAnswer = { mode: signupMode(c.env.SIGNUP_MODE) };
  return c.json(answer, 200, { 'cache-control': `public, max-age=${SIGNUP_MODE_MAX_AGE_SECONDS}` });
}
