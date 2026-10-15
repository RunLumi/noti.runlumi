# ADR 0048: Sign-up mode notice and the remove-member confirmation

Status: Accepted · Date: 2026-10-15 · Completes the sign-up page follow-up of ADR 0047 (F242, spec 15) and replaces
the Team page's `window.confirm` for removing a member (F221, spec 14)

## Context

ADR 0047 added `SIGNUP_MODE` (`open`, `invite_only`, `closed`) and left one follow-up open: the sign-up page did
not say when sign-up is limited. Better Auth answers a refused password sign-up with the same 200 it gives an
accepted one (its anti-enumeration behaviour while email verification is required), so the page cannot learn
anything from the submit. A stranger on an invite-only deployment was told to check an inbox that stays empty,
and during an incident (`closed`) everyone was.

Separately, the Team page's "Remove" control asked with `window.confirm`, the last destructive action in the app
that did not use the alert-dialog pattern of revoking a credential, deleting an integration or cancelling an
invitation (ADR 0045 recorded the inconsistency and left it). `window.confirm` cannot be translated beyond its
message, cannot carry a structured message, does not follow the focus contract of F221 (focus on the cancel
button first), and cannot show a refusal.

## Decision

### 1. `GET /api/public/signup-mode`

A public, unauthenticated route that returns `{ "mode": "open" | "invite_only" | "closed" }`, computed with
`signupMode()` from `src/auth/signup-policy.ts`, the same function the `user.create.before` hook uses. So an unset
value reads `open` and an unknown value reads `closed`, exactly as enforced.

- **Reveals only the mode.** It reads no query, header, cookie or body, touches no database row and never calls
  Better Auth (`tests/api/signup-mode.test.ts` asserts all three, and that an address in the query changes
  nothing). Whether an address holds an invitation or is on `SIGNUP_ALLOWLIST` stays inside the hook, behind
  the uniform 200.
- **Cacheable:** `Cache-Control: public, max-age=60`. The mode changes only with a deploy or a dashboard variable
  change, and a minute is short enough for the `closed` kill switch to reach the page almost at once.
- **Registered as public** in `ROUTE_POLICY` with a reason, so the route-capability test (F232) and the generated
  `docs/AUTHORIZATION.md` list it. The public list is now three routes, asserted exactly.
- It sits under `/api`, so it shares the API's security headers, correlation id, maintenance answer and the
  auth-tier 503 (`SESSION_PATH`): when auth is misconfigured sign-up cannot work anyway, and the page then shows
  no notice.

Rejected: putting the mode in the HTML shell (the shell is cached and served by the assets layer, so a kill
switch would not reach it promptly); a per-address "may I sign up?" check (an enumeration oracle, exactly what
the uniform 200 exists to prevent); a Better Auth plugin endpoint (more surface inside the auth handler than a
read of one variable needs).

### 2. The sign-up page

`AuthPage` (sign-up mode) reads the endpoint with React Query (`staleTime` one minute, no retry):

| Mode | What the page shows |
| --- | --- |
| `open` | the form, unchanged, no notice |
| `invite_only` | a notice: sign-up is by invitation; an invited person opens the link in their invitation email and uses the address it was sent to; without an invitation no account is created and no email is sent. The form stays usable (an invited or allowlisted address signs up here). After submitting, the message says "If this address has an invitation, check your email…", not an unconditional "check your email" |
| `closed` | a warning notice: new accounts are not being created, sign in if you have an account, otherwise ask the person who runs the service. Every field and the submit button are disabled, and the submit handler refuses too |
| unknown or unreadable | no notice and the form as before; the server still decides |

**The invitation flow still reaches sign-up.** The signed-out invitation page links to `/signup?invite=<id>`
instead of `/signup`. With an invitation id (validated as URL-safe, at most 128 characters; anything else is
ignored), an invite-only page shows "You're signing up from an invitation" instead of the stranger's notice, the
"Sign in" link carries `returnTo=/invite?id=<id>`, and the verification email's callback is
`/signin?verified=1&returnTo=/invite?id=<id>`, so the new account lands back on the invitation. `returnTo` is
validated again on sign-in by `safeReturnTo`. When the mode is `closed` the form is disabled even with an
invitation, because the server refuses that too.

The notices use the shared `Notice` at 16 px with a Tabler Outline icon (mail-forward, lock), opaque, placed
between the page description and the form.

### 3. The remove-member confirmation

`web/src/team/RemoveMemberDialog.tsx` is a Base UI `AlertDialog` in the pattern of `RevokeDialog` and the
pending-invitation cancel dialog: focus starts on "Keep member", Tab is trapped, Escape closes and focus returns
to the trigger, and only the explicit "Remove member" button sends `POST /api/auth/organization/remove-member`.
The message has four parts:

1. **Who and where** (the title): "Remove {name} from {workspace}?"
2. **What they lose:** access to this workspace at once (its integrations, sources, activity and team). Membership
   is read from the database on every request (`resolveWorkspace`), so "at once" is literal.
3. **What is kept:** their Lumi Noti account is not deleted; the workspace's integrations and sources keep running.
4. **How to undo:** send a new invitation, which they choose to accept; the removal is recorded in the audit log
   (`member.remove`, `src/auth/audit-hooks.ts`).

A refusal keeps the dialog open with the server's message. On success the dialog closes with focus on the
Members heading (`finalFocus`, because the row holding the trigger is removed), and a status line names the
address. "Leave organization" still uses `window.confirm`; it was not in scope and is recorded here rather than
changed silently.

## Consequences

- A visitor to an invite-only or closed deployment is told before submitting, in English and Vietnamese. The
  ADR 0047 consequence "the sign-up page does not yet say by invitation only" no longer holds.
- One more public route, deployment-wide and input-free. Anyone can learn whether a deployment is open, invite-only
  or closed; that is the point, and it says nothing about any person.
- The notice can lag a mode change by up to a minute (cache) plus the page's own one-minute `staleTime`.
- The Team page's member removal now meets the F221 destructive-dialog contract. "Leave organization" does not yet.

## Verification

- `tests/api/signup-mode.test.ts`: each mode, unset and unknown values, no session, no database call, no Better Auth
  call, the cache header and API security headers, identical answers whatever address is supplied, GET only.
- `tests/security/route-capability.test.ts` and `docs/AUTHORIZATION.md` (regenerated): the route is public with a reason.
- `web/src/signup-mode.test.tsx`: open, invite only, closed (fields and submit disabled, Enter sends nothing),
  unreadable mode, the post-submit message, the invitation link, the invited notice, the `returnTo` on the sign-in
  link and on the verification callback, a malformed id ignored, Vietnamese; axe on each notice state.
- `web/src/team/remove-member.test.tsx`: no `window.confirm`, the four parts, focus on Keep, Escape and focus
  return, Keep sends nothing, confirm removes and announces and moves focus, a refusal stays in the dialog,
  admin-only and never for oneself, Vietnamese; axe in both languages.
- `web/src/a11y/pages.a11y.test.tsx` (three sign-up states, both languages) and `dialogs.a11y.test.tsx` (the
  remove dialog's focus contract and Tab trap).

**Not verified:** a real browser at 320 px, a screen reader, a real Better Auth verification email carrying the
`returnTo` through to the invitation on a deployment, and a native-speaker review of the Vietnamese strings.

## Revisit when

- Sign-up opens publicly (`SIGNUP_MODE=open`): the invite-only notice disappears on its own; decide whether the
  invitation-aware wording should stay for invited people.
- A second account-creating path appears (social sign-in, SSO): its entry page needs the same notice.
- "Leave organization" gets its own confirmation dialog.
