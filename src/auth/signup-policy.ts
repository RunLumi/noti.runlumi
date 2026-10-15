/**
 * Who may create an account (ADR 0047). The switch exists for an invite-only beta and doubles as the
 * sign-up kill switch the incident playbooks call for (docs/INCIDENT_RESPONSE.md, spec 15 F242).
 *
 *  | `SIGNUP_MODE`   | A new account is created when                                                 |
 *  | --------------- | ----------------------------------------------------------------------------- |
 *  | `open`          | always (also the value when the variable is unset, so local dev and tests run) |
 *  | `invite_only`   | the address holds a pending, unexpired invitation, or is on `SIGNUP_ALLOWLIST` |
 *  | `closed`        | never: the kill switch. Existing accounts still sign in                        |
 *  | anything else   | never: an unknown value fails closed and boot names `SIGNUP_MODE`              |
 *
 * The deployed configuration sets `invite_only` in `wrangler.jsonc`, so a deploy is invite-only unless an
 * operator deliberately opens it. The check runs in Better Auth's `user.create.before` hook, which every
 * account-creating path passes through, not in one route.
 *
 * What the caller sees: Better Auth answers a refused password sign-up with the same 200 it gives a
 * successful one (its anti-enumeration behaviour while email verification is required), so a refusal
 * reveals nothing, not even whether an address holds an invitation. No account row is written and no mail
 * is sent. So the sign-up page says up front when sign-up is limited: it reads the mode, and only the mode, from
 * `GET /api/public/signup-mode` (src/api/signup-mode.ts, ADR 0048).
 */
export const SIGNUP_MODES = ['open', 'invite_only', 'closed'] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

/** Upper bound on allowlist entries read, so a pasted file cannot make every sign-up scan thousands. */
export const MAX_ALLOWLIST_ENTRIES = 50;

/** The mode in force. Unset or empty is `open`; any unrecognised value is `closed` (fails safe). */
export function signupMode(raw: string | undefined): SignupMode {
  if (raw === undefined || raw.trim() === '') return 'open';
  const value = raw.trim();
  return (SIGNUP_MODES as readonly string[]).includes(value) ? (value as SignupMode) : 'closed';
}

/** Is `SIGNUP_MODE` set to a value this Worker does not recognise? Boot names it when it is. */
export function isUnknownSignupMode(raw: string | undefined): boolean {
  return raw !== undefined && raw.trim() !== '' && !(SIGNUP_MODES as readonly string[]).includes(raw.trim());
}

/** A plain mailbox address, lower-cased: no wildcard, no bare domain, a dot in the domain. */
const ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

/** Exact addresses only, compared case-insensitively. No domains or wildcards: each operator is named. */
export function allowlistOf(raw: string | undefined): ReadonlySet<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => ADDRESS.test(e))
      .slice(0, MAX_ALLOWLIST_ENTRIES),
  );
}

export interface SignupDecisionInput {
  readonly mode: SignupMode;
  readonly email: string;
  readonly allowlist: ReadonlySet<string>;
  /** Looked up only when needed: does this address hold a pending, unexpired invitation? */
  readonly hasPendingInvitation: (email: string) => Promise<boolean>;
}

export type SignupRefusal = 'signup_closed' | 'signup_invite_only';

/** `null` admits the account; otherwise the reason it is refused. */
export async function signupRefusal(input: SignupDecisionInput): Promise<SignupRefusal | null> {
  if (input.mode === 'open') return null;
  if (input.mode === 'closed') return 'signup_closed';
  const email = input.email.trim().toLowerCase();
  if (input.allowlist.has(email)) return null;
  return (await input.hasPendingInvitation(email)) ? null : 'signup_invite_only';
}
