# ADR 0030: Sessions and the device list, the absolute lifetime, audit of membership changes, and what the auth tests showed

Status: Accepted · Date: 2026-10-14 · Implements slices 2.1, 2.2, 2.3 (in part) and the session parts of 1.24 of
[`docs/specs/REMAINING.md`](../specs/REMAINING.md): F16 to F22, F28, F234 (each in part, see Evidence). **No migration**:
every change is code, configuration constants and an operator script, and the existing indexes serve the new queries.

## Context

Better Auth was configured (password policy, verification, reset, passkeys, organizations, rate limits) but no rule had
a test, so the behaviour was believed, not shown. A person could not see where they were signed in or end a session
(AR-1's fifth mitigation was "scheduled"). A session lived 30 days from its last use with no outer bound. Membership,
invitation and role changes made through Better Auth's routes left no audit row. And a database restore could bring back
a session row the person had ended.

## Decisions

1. **The behaviour is shown, through the real handler.** `tests/auth/` builds the REAL `createAuth` over the real
   migrations in a Node SQLite stand-in, with only the email transport replaced by a recorder (`tests/auth/harness.ts`).
   Mutation-checked: switching `minPasswordLength` to 8 or `revokeSessionsOnPasswordReset` off, or removing the audit
   hooks, fails the tests. What is shown: the 12 to 128 character policy and that only a salted hash is stored; sign-up
   grants no session; sign-in before verification is refused and re-sends the link; verification links work once, expire
   after an hour, and do not sign anyone in; email is stored lower-cased and a second sign-up differing in case creates
   no second account; wrong-password and unknown-address sign-ins are indistinguishable; reset answers identically for a
   known and an unknown address, ends every session, is single use, expires after an hour and applies the password
   policy; every rule in the rate-limit table triggers at exactly its maximum, resets after its window, is per client
   address (a forged `X-Forwarded-For` does not move it; a request with no address shares one bucket instead of
   bypassing), and lives in the database; role validation, who may invite, who may accept (only the invited address, case
   insensitive, once), that accepting creates no workspace and may add a second one, expiry, cancellation and the
   last-admin trigger.
2. **Two defects the tests found, fixed.**
   - *A passkey sign-in created a session for an account whose email was never verified.* Password sign-in refuses it, but
     the passkey plugin does not. Our own routes were safe (`workspace.ts` answers 401 for an unverified user) but Better
     Auth's organization routes under `/api/auth` do not go through that gate. `databaseHooks.session.create.before` now
     refuses a session for an unverified user (`FORBIDDEN`), so the rule holds wherever a session is born.
   - *Invitation lifetime was Better Auth's silent default (48 hours); reset and verification lifetimes were too.* All
     three are now explicit constants in `src/auth/session-policy.ts`: reset link 1 hour, verification link 1 hour,
     **invitation 7 days** (an admin invites someone who may be away; an invitation can be cancelled at any time). The
     seven days is a decision, not a finding: shorten it by changing one constant.
3. **Session management is ours, one audited path.** `GET /api/workspace/me/sessions`, `POST .../:id/revoke`,
   `POST .../revoke-others` (`src/api/sessions.ts`). Every statement is bound to the user id of the verified session, so
   another person's session answers 404 like a missing one. The token is never selected. The delete and its audit row are
   one D1 batch; `revoke-others` records the exact count from SQLite's `changes()`, and a request that changed nothing
   records nothing. The session making the request cannot be revoked here (409; that is signing out). 30 revokes and 120
   lists a minute per person; the central `Origin` check applies. The address is shown shortened (`203.0.113.x`).
   Better Auth's own `list-sessions`, `revoke-session`, `revoke-sessions` and `revoke-other-sessions` are **closed with 404
   at the Worker**: they return each session's token and act on a token the caller supplies, so they cannot be audited as
   one change and they are a read path for the credential AR-1 says has none.
4. **An absolute session lifetime of 90 days**, from sign-in (`SESSION_ABSOLUTE_SECONDS`). The 30-day figure is an idle
   limit that daily use pushes out; without an outer bound a stolen session in daily use never ends. 90 days is long enough
   not to nag a person who uses the product weekly and short enough that a lost laptop is not a standing risk; passkeys
   make signing in again cheap. Enforced **twice**: exactly, on every request our own routes handle
   (`sessionPastAbsoluteLife` in `currentSession`), and for every other path (Better Auth's organization routes) by the
   hourly purge deleting the row (`overAgeSessions` in `src/pipeline/expired-records.ts`, with a unit canary on
   `created_at` and the existing majority guard extended to count over-age rows). So the bound is exact for our API and
   at most one cron period late elsewhere. Better Auth has no native absolute timeout; this is our layer over it.
5. **Audit for what Better Auth owns** (`src/auth/audit-hooks.ts`): `member.invite`, `.invite.accept`, `.invite.reject`,
   `.invite.cancel`, `member.role.change` (new and previous role), `member.remove` (`self: true` when a member leaves),
   `session.revoke`, `session.revoke_others`, `session.revoke_all` (also written after a password reset, with the count),
   and an `access.denied` row when a member's request to invite, cancel, change a role or remove is refused. It is a
   Better Auth `hooks.after`, so **the row is not atomic with the change**: the change stands and the row can be missing if
   the Worker dies between the two, or if the insert fails (logged as `audit_write_failed`; the response never changes).
   Closing that would mean owning Better Auth's writes, which this product does not. Nothing the actor typed is stored: the
   invitee's address is never in a row; the role is dropped unless it is `admin` or `member`. A refusal is recorded only for a
   member of the named workspace, so a stranger cannot write into another workspace's log. Session events have no workspace:
   they appear in the person's own account export, not in a workspace's audit view.
6. **A restore ends every session.** A Time Travel or backup restore can resurrect a session row the person ended (the
   token is stored as is, AR-1). `scripts/revoke-all-sessions.mjs --reason restore|incident [--apply]` deletes every
   `session` row and every `verification` row (so a restored, used reset link is dead) and writes one `session.revoke_all`
   event. The test first restores a revoked row and shows it works again, then shows the script ending it. It is a runbook
   step (`docs/RUNBOOK.md` "After a restore"), run with `MAINTENANCE_MODE` on so no session is created between count and
   delete.
7. **Token storage, verified against the installed Better Auth (1.7.7).** The `session.token` column holds the token as is,
   and the cookie value is that token followed by a signature; a test fails if that stops being true, which would mean the
   library now hashes tokens and AR-1 should be rewritten. A second test shows what the cleartext column alone buys an
   attacker: the raw token, or the token with a missing or wrong signature, authenticates no one. That is **not** a claim
   that D1 is safe to leak: anyone holding both the table and `BETTER_AUTH_SECRET` can forge a cookie, and the signing key is
   the only thing standing between the two. AR-1 stays accepted, with its text corrected rather than softened.

## Review follow-ups (independent security review)

- **H1, fixed.** The 90-day limit was enforced only in `currentSession` and by the hourly purge, so Better Auth's own routes
  (`get-session`, the organization routes) kept honouring a session past its end for up to an hour. `hooks.before` now resolves the
  session cookie on every Better Auth request; a session past its absolute end is deleted and the request gets 401 (sign-out is
  exempt). `currentSession` treats that 401 as "not signed in". `tests/auth/absolute-life.test.ts` ages a session to 89 and 91 days.
- **H2, fixed.** The purge's "more than half expired" guard counted over-age sessions, so a cohort reaching day 90 together
  aborted every hourly pass and blocked the other purges. Only idle-expired rows count now; the `created_at` unit canary stays.
- **M1.** The wording is "no endpoint returns a session token other than the caller's own": sign-in and `get-session` still
  return it to its owner.
- **M2.** A failed audit write is counted in `ops_state` (`audit_write_failures`) and `/health/ready` warns
  `audit_write_failed_recently` for an hour. The Better Auth rows remain non-atomic with their change.
- **M3.** `/change-password` with `revokeOtherSessions` is audited (`session.revoke_others`, count taken before). A failure of the
  reset counter is logged and ignored, so it cannot turn a successful reset into an error.
- **Low.** Numeric `created_at` no longer fails closed. Refusal rows from the hook are capped at 10 a minute per person.
  `revoke-all-sessions.mjs --apply` needs `--i-froze-writes`. An admin-role invitation lives 48 hours (member: 7 days).
  **Gap, documented:** the Team page cannot list or cancel pending invitations (Better Auth's `list-invitations` and
  `cancel-invitation` exist; no UI yet).

## Evidence

| | Where |
| --- | --- |
| Password, email, resend, reset, verification | `tests/auth/credentials-policy.test.ts` |
| Rate-limit rules, one per rule, window, address, storage | `tests/auth/rate-limit.test.ts` (rules in `src/auth/rate-limit-rules.ts`) |
| Invitations, roles, last admin | `tests/auth/invitations.test.ts` |
| Passkey sign-in with a software authenticator: counter behind or equal is refused and not stored, a never-counting authenticator is accepted, a challenge answers once, wrong origin / relying party / key refused, an unverified email yields no session | `tests/auth/passkeys.test.ts`, `tests/auth/webauthn.ts` |
| Session list and revoke, tenant isolation (another person's id is 404), no token in any response, closed Better Auth routes, token storage, the 90-day bound | `tests/api/sessions.test.ts` |
| Audit rows end to end and through `GET /api/audit`; the pure mapping | `tests/auth/audit-events.test.ts`, `tests/auth/audit-hooks.test.ts` |
| Restore script | `tests/security/revoke-all-sessions.test.ts` |
| Over-age purge | `tests/pipeline/expired-records.test.ts` |
| UI: list, revoke one, revoke all, error states, axe in English and Vietnamese | `web/src/account/sessions.test.tsx`, `web/src/account/device.test.ts` |

## Not verified, stated so it is not assumed

- **No real WebAuthn authenticator, browser or device.** The passkey tests prove the server's checks against a software
  authenticator. A counter regression is *refused*; the person sees a generic failure, not a prompt to re-register (F19
  asked for the prompt: not built). Passkey-only recovery with no verified email and no password is not built.
- **No real email delivery.** The transport is a recorder; Cloudflare Email Sending has never sent one of these mails (F17).
  Email-volume monitoring and a provider migration plan are not built.
- `wrangler d1 execute --file` has never run `revoke-all-sessions.mjs` against a real D1 (UNVERIFIED, `docs/RELEASE_GATES.md`).
- The UI was checked in jsdom with axe (and the stylesheet tests that pin 44 px controls and reflow); it was not driven in a
  real browser at 320 px in this slice.
- The absolute lifetime's purge half was exercised on the Node SQLite stand-in, not on D1.
- Vietnamese copy has not been reviewed by a native-speaking editor.
- Password reset does not step up or notify the address on file that sessions were ended (the audit row exists; no email).

## Consequences

- Anyone with a stolen cookie can end the real person's *other* sessions (revoke-others is not behind a fresh sign-in).
  The remedy is the same as before: reset the password, which ends every session. Adding step-up here would make a
  compromised person's own clean-up harder, and was not done.
- Ending a session is not an audit event for the workspace an admin sees; the person's own export contains it.
- A new `AUDIT_ACTIONS` entry needs a `SUMMARY_FIELDS` allow-list and en/vi labels (tests enforce both); this ADR added nine.
- Three constants (`SESSION_ABSOLUTE_SECONDS`, `INVITATION_EXPIRES_IN_SECONDS`, the two one-hour link lifetimes) now live in
  `src/auth/session-policy.ts` and are read by the retention matrix and the Settings screen, so the copy cannot drift.

## Alternatives rejected

- **Hash session tokens ourselves.** Hand-rolled session storage puts authentication correctness in our code (AR-1's reason).
- **Enable `session.cookieCache`.** It makes revocation lag; a static test keeps it off.
- **Keep Better Auth's `list-sessions` and `revoke-session`.** They expose tokens and cannot be audited as one change.
- **An absolute lifetime enforced only by the purge.** Up to an hour late for our own API. **Only in `currentSession`:**
  Better Auth's organization routes would not see it.
- **Audit inside Better Auth's database writes** (a delete hook on `session`): it would record every sign-out and every
  expiry sweep as noise.
