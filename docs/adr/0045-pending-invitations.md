# ADR 0045: Pending invitations on the Team page, admin-only list and cancel

Status: Accepted · Date: 2026-10-15 · Completes the pending-invitations part of spec 02 F21 and F28 (REMAINING 2.3); builds on ADR 0028 (tenant resolution, denial audit) and ADR 0030 (member and invitation audit by Better Auth hook)

## Context

An admin who invites someone could not see what was still outstanding. The Team page showed members only, so a typo in an
address, a link sent to the wrong person, or an invitation that expired unaccepted could be cleared only by waiting for it to
lapse. Better Auth can cancel an invitation (`/organization/cancel-invitation`), but no part of the product showed the list
that cancel acts on, and that Better Auth route writes its audit row from an `after` hook, which is not atomic with the change
(ADR 0030).

Two facts shaped the decision. The `invitation` table already carries `created_at` and `expires_at`, so the list can show a real
sent time and a real expiry without inventing either. And the Team page's member list is readable by every member
(`GET /api/workspace/team`), so the new list must be gated more tightly than that one, not copied from it.

## Decision

### 1. Two routes, both on the workspace guard (`src/api/invitations.ts`)

- `GET /api/workspace/invitations?org=`: the pending invitations of the resolved workspace.
- `POST /api/workspace/invitations/:id/cancel?org=`: cancel one of them.

Both call `authorize(c, capability)`, the single gate for domain routes (ADR 0028): `?org=` is resolved against the caller's own
memberships, a workspace the caller is not in answers 404 exactly like one that does not exist, and the role is checked for that
workspace. Both routes are registered in `src/auth/route-policy.ts`, so `tests/security/route-capability.test.ts` requires a guard
for them. The cancel repeats the Origin check inline, as `sessions.ts` does (`tests/security/static-guards.test.ts` requires it in
every route file that mutates); the Worker's central Origin middleware covers it as well.

The tenant-isolation drill (`scripts/lib/drill-plan.mjs`, spec 15 F233) attacks every route behind a session or capability, so the
cancel route is attacked too. Its victim now carries a pending invitation in the other workspace (`invitationId`, required by
`scripts/tenant-isolation-drill.mjs` and documented in `docs/RUNBOOK.md`). Operators preparing a staging drill must add one.

### 2. Who may see and cancel: admins only

- `invitation.read` is added to Better Auth's statements and granted to `admin` only. It is the one new capability; the list is
  refused to a member with `403 Missing capability: invitation.read`, and the refusal is audited in that workspace.
- `invitation.cancel` already existed in the role model and is granted to `admin` only.
- The `invitation` resource stays Better Auth's own. The two actions our routes check are listed explicitly as
  `ROUTE_CHECKED_INVITATION_CAPABILITIES` rather than added to the domain resources, because `invitation.create` is enforced by
  Better Auth's invite route and has no route of ours; the route-capability test accepts exactly this set.

### 3. Tenant scope

- The list query is `organization_id = <resolved workspace> AND status = 'pending'`. Accepted, rejected and cancelled
  invitations are finished and are not shown. An expired invitation still has status `pending` in the table; it is shown with
  `expired: true` (computed by the server) so an admin can cancel it.
- A cancel first looks the id up under the resolved workspace. An id that belongs to another workspace and an id that does not
  exist get the same 404 with the same body, and nothing of the other workspace is read or changed. The refusal is written to
  the caller's own workspace log as `access.denied` with `reason: not_in_workspace` and no subject id, so an admin there can see
  that such a request happened without learning where the invitation is.
- The list is capped at 100 rows with a `truncated` flag; the screen says only the most recent ones are shown.

### 4. Cancel is one batch with its audit row

The cancel is `UPDATE invitation SET status='canceled' WHERE id=? AND organization_id=? AND status='pending'`, and in the same D1
batch an `auditStatement` for `member.invite.cancel` (subject `invitation`, subject id, metadata `{role}`) guarded by
`changes() > 0`. The row exists if and only if the status changed, and a failure to write the row rolls the status back (the
test makes the audit insert fail and checks the invitation is still pending). This is the first Better Auth-owned write that
the product owns and makes atomic; the others (invite, accept, reject, role change, removal) are still written by Better Auth's
`after` hook, as ADR 0030 records.

Acceptance needs no separate change: Better Auth refuses to accept an invitation whose status is not `pending`
(`node_modules/better-auth/dist/plugins/organization/routes/crud-invites.mjs`), so a cancelled link stops working at once. A second
cancel, or a cancel of an accepted invitation, matches no row and answers 404 with nothing written.

The Better Auth route `/organization/cancel-invitation` is still reachable through its own API. It is still gated by Better Auth's
role check and still audited by its hook, and the new screen does not call it.

### 5. Rate limit

A person may cancel 30 invitations a minute (`hit`, the same counter style as workspace switching). The list is a read by an
admin and is not limited separately, like the other admin reads.

### 6. The screen (`web/src/team/PendingInvitations.tsx`, ADR-level choices here, detail in `docs/FRONTEND.md`)

- Shown on the Team page to admins only, between Members and Membership. The member view never requests the list.
- Each row shows the address, the recorded role or "Role not recorded" (never a guessed one), the sent time from `created_at`,
  and the expiry from `expires_at` or "Expired" with a badge. Nothing is invented in the browser.
- Empty, loading and error states use the shared `EmptyState`, `Skeleton` and four-part `ErrorPanel`, not local copies.
- Cancel uses the alert-dialog pattern of the revoke and delete dialogs (focus starts on "Keep invitation", Escape closes, only the
  confirm button sends). This differs from the older "Remove" control on the same page, which uses `window.confirm`; that control
  is not changed here, and the difference is recorded rather than fixed silently.
- After a successful cancel focus moves to the section heading, since the row that had focus is removed.

## Consequences

- Admins can see and clear outstanding invitations. A member's view of the Team page is unchanged.
- One new capability name (`invitation.read`) in the role model and in `docs/AUTHORIZATION.md`, which is regenerated from the
  code (`npm run docs:authorization`). No migration: the existing `invitation` table has every column the list needs.
- The cancel path no longer depends on Better Auth's hook for its audit row. Its failure mode is the batch's: a failed audit write
  returns 500 and changes nothing, instead of a change without a row.
- Expired invitations are not removed automatically; they stay until someone cancels them, as before this change.
- The list and cancel show the invitee's address to workspace admins. That is workspace data an admin already sees in the member
  flow; the audit row still stores no address (the invitee's address is a third party's data, as ADR 0030 decided).

## Verification

Local only; nothing here ran against a real provider, a deployed Worker or a real D1.

- Server, `tests/api/invitations.test.ts` (18 tests, fake D1 over the real migrations, real Worker routes, mocked session row):
  admin list scoped to the workspace and pending only, sent and expiry values, no other workspace's or finished rows, a member
  refused and the refusal recorded, a workspace the caller is not in answered like a missing one, a role decided per workspace,
  the 100-row cap, cancel with its audit row, expired cancel, double cancel writing nothing more, member refusal, a foreign
  invitation id answered like a missing one and recorded only in the caller's log, a caller not in the named workspace, CSRF and
  session refusals, atomicity under a failing audit insert, and the per-person rate limit.
- `tests/drill/tenant-isolation.test.ts` (the drill plan, against the real Worker over the fake D1): the cancel route is attacked
  with a victim invitation in the other workspace, and the list is checked for leaked markers.
- `tests/security/static-guards.test.ts` (Origin on every mutating route file) and `web/src/i18n/hardcoded-strings.test.ts`
  (no sentence-like display strings outside the catalogue): both pass with the new files.
- `tests/auth/permissions.test.ts` and `tests/security/route-capability.test.ts`: the admin and member matrix for
  `invitation.read` and `invitation.cancel`, and both routes guarded as the policy says.
- Web, `web/src/team/pending-invitations.test.tsx` (12 tests, jsdom): contents, no invented data, admin-only, empty, error with
  retry, cancel with focus, the 404 refresh, the failure that keeps the list, and axe in English and Vietnamese.
- `web/src/a11y/pages.a11y.test.tsx`: two new Team scenarios (nothing pending; list unavailable) scanned with axe.
- Not verified: a real browser at 320 px, keyboard use in a browser, a screen reader, and a native-speaker review of the
  Vietnamese strings (`team.invitations.*`), which the engineer drafted.

## Not done

- Resending an invitation, and showing who sent it.
- Making the other Better Auth-owned writes atomic (invite, accept, reject, role change, removal): REMAINING 2.3's first item.
- A browser pass; the Team page remains covered by jsdom and axe only.
- Writing a foreign invitation's id into any log. It is deliberately left out, so no log can be used to learn the ids of
  another workspace's invitations.

## Revisit when

- Better Auth's invite and accept writes are owned by the product, so every invitation change has its audit row in the same batch.
- Admins need to resend, or to see who sent an invitation; both need a decision about what the list shows.
- Invitations per workspace grow past the 100-row first page, which needs paging instead of a cap.
- A native speaker reviews the Vietnamese strings, or a browser pass at 320 px finds a layout fault.
