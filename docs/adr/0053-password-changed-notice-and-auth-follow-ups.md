# ADR 0053: Password-changed notice, no address in client logs, invitation joins only, ADR 0003 completed

Status: Accepted · Date: 2026-10-15 · Builds the reset notice of F18, the client-logging check of F16 and the accept
check of F21 (spec 02); amends ADR 0003 for F32 (REMAINING slice 2.5)

## Context

Four identity follow-ups were open in spec 02, each small and none needing a migration:

- **F18.** A successful password reset ended every session but told nobody. If someone other than the owner
  completed a reset (a reset link read from a compromised mailbox, for example), the owner learned of it only when
  their own sign-in failed.
- **F16.** The acceptance list says the web client must never log an email address. A grep had found no `console`
  call in `web/src` outside a sample snippet, but nothing would fail if one were added.
- **F21.** The invitation page (`InvitePage` in `web/src/onboarding.tsx`) lives in the same file as workspace
  creation. Tests showed that Better Auth's accept route creates no organisation, but not that the whole path a
  newcomer takes (invite-only sign-up, verification, sign-in, accept) ends with exactly the inviting workspace.
- **F32.** ADR 0003 still listed the multi-organisation decision under "Revisit when" and did not record the
  Cloudflare Email Sending constraints.

## Decision

### 1. A password-changed notice after every successful reset

`emailAndPassword.onPasswordReset` (`src/auth/better-auth.ts`) now sends `passwordChangedNotice(user.email, APP_ORIGIN)`
through the same `sendAuthEmail` path as every other auth mail. Better Auth calls this hook only after the new
password is stored (`better-auth/dist/api/routes/password.mjs`, 1.7.7), and ends the sessions right after it returns.

- **Recipient**: the address on file, never one from the request.
- **Content**: fixed plain text. It says the password was changed with a reset link and that signed-in devices are
  signed out, then what to do if this was not the owner ("Forgot password?" on the sign-in page, tell a workspace
  admin, secure the mailbox, since whoever reads it can reset the password).
- **No secret and nothing that signs in**: the one link is `APP_ORIGIN/signin` with no query. The test asserts the
  text holds no token, no `/api/auth` path, no `callbackURL` and not the new password.
- **No "ignore this email"**: `sendAuthEmail` gained an optional `outro`. Its default ("If you did not request this,
  you can ignore this email") is right for a link someone asked for and wrong for a security notice, so the notice
  states its own.
- **Best effort**: a send failure is caught and logged as the new catalogue event `password_changed_notice_failed`
  (field `error` only, redacted by `log()`); with an execution context the send runs after the response and a failure
  is logged by `settleBackground` as `background_task_failed`. A notice failure never throws out of the hook, because
  a throw there would answer an error for a reset that already happened and skip the session revocation.

Rejected: sending the notice from Better Auth's `after` hook on `/reset-password` (it sees the response, not whether
the password changed, and would need to read the user back); a notice that links to a "this was not me" endpoint
(a new authenticated surface, and any link that acts on the account is a target for phishing copies); including the
request IP or user agent (personal data in a mailbox, and an address behind a proxy would mislead).

### 2. A test that the client never logs the address

`web/src/lib/no-email-logging.test.tsx` has two halves.

- **Static**: every non-test `.ts`/`.tsx` under `web/src` (not `a11y/testing`) is parsed with the TypeScript compiler
  and fails on any reference to `console`, any `sendBeacon`, a call on a known analytics or error-reporting global
  (`gtag`, `posthog`, `Sentry`, `dataLayer` and others, also through `window.`), or an import of a known analytics or
  logging package. A syntax tree rather than a regex, so the sample code in `sources/snippets.ts`, a string, is not
  flagged; fixtures prove the scanner catches each form and ignores strings. No allowlist: the client has no logging
  call at all, the simplest guarantee that it never logs the address.
- **Behavioural**: the sign-in form (refused and accepted), the sign-up form and the forgot-password form are filled
  with an address and submitted against the mock API, with every console method spied and `navigator.sendBeacon`
  stubbed. The address, its URL-encoded, upper-cased and local-part forms must not appear in any console call, beacon
  or request URL. A deliberate `console.debug('submit', { email })` in `pages.tsx` made five of the seven cases fail,
  so the check is live.

The mock API (`web/src/a11y/testing/render.tsx`) gained an opt-in `signIn` answer (`ok` or Better Auth's 401); unset,
the route stays unmocked as before.

### 3. Accepting an invitation joins the inviting workspace and nothing else

Two tests through the real Better Auth handler and the Worker's `/api/workspace/me` (`tests/auth/invitations.test.ts`):
a newcomer on an invite-only deployment signs up, verifies, signs in (no membership, no workspace created), accepts
(the answer names the inviting workspace), and ends with exactly that one membership while the organisation count is
unchanged; a second accept changes nothing. A person who already owns a workspace gains exactly the inviting one,
keeps their own, and no third workspace appears. On the client, `web/src/workspace/stale-tab.test.tsx` shows a person
with no workspace accepting from `/invite`: one accept request, no `POST /api/auth/organization/create`, and the
invited workspace made active.

### 4. ADR 0003 records the multi-organisation and Email Sending decisions

ADR 0003 gains item 5 (no `organizationLimit`; isolation by `organization_id` predicates; `selectMembership` refuses
ambiguity, from `docs/specs/00-current-state.md` N2 and N7) and item 6 (the Email Sending constraints as recorded in
`docs/AUTH_SETUP.md` and `docs/EMAIL_LIMITS.md` on 2026-10-13, cited, not re-read, and no new external claim). The
"Revisit when" entry for `organizationLimit: 1` is marked done.

## Consequences

- A reset now costs two messages against the Email Sending allowance, the link and the notice (`docs/EMAIL_LIMITS.md`).
- An owner whose password was reset by someone else is told at the address on file, within the time the mail takes.
  If the attacker controls that mailbox they read the notice too; the notice cannot help there, and says so.
- Adding a `console` call, a beacon or an analytics SDK to the client now fails a test. Diagnostics the client might
  want later need a reviewed, redacting path first.
- The F21 risk named in spec 02 (an invitation creating a second organisation) is now covered end to end, server and
  client.

## Not done

- No notice after a signed-in password change. Better Auth's `/change-password` route is reachable (it needs the
  current password and is audited, `src/auth/audit-hooks.ts`) but does not call `onPasswordReset`, so it sends no
  notice. The client offers no screen for it. Sending one needs an `after` hook on that route.
- No real email delivery: every message in these tests goes to the harness recorder. Nothing has been sent through a
  real Cloudflare Email Sending binding (F17, F18).
- No localisation of auth mail: the notice, like every other auth message, is English only.
- The behavioural F16 check covers the three auth forms; other screens that show the address (the invitation page,
  the sessions panel, the team list) are covered by the static scan only.

## Revisit when

- A password-change screen, an email-change flow or a second account-recovery path is added: each needs its notice.
- The client needs logging or analytics: write the redaction path and an ADR before the first call, and update the
  static scan's denylist.
- Email Sending limits or pricing change (ADR 0003 item 6).
