# ADR 0049: Source revoke and fingerprint in the dashboard

Status: Accepted · Date: 2026-10-15 · Completes the dashboard part of F39 and F40 (spec 03) for sources; builds on
[ADR 0036](0036-credential-destruction-and-boot-hygiene.md) section 3 and [ADR 0012](0012-generic-source.md)

## Context

ADR 0036 built revoke, drain, destroy and audit for both kinds of connection, and the dashboard control for
integrations only. A source could be revoked through `POST /api/sources/:id/revoke-credentials` (admin only,
`source.revoke`, Origin-checked, tenant-scoped, three fixed reasons, one `source.credentials.revoke` audit row, then
`source.key_destroyed` after the 60 second drain window), and its view already carried `credentialFingerprint`,
`revoked` and `keyDestroyed`. The Sources page ignored all three: a person could not see which secret was stored,
could not revoke one they no longer trusted, and a revoked source looked like a paused one whose switch failed with a
422 when pressed. REMAINING slice 1.2 listed this as left.

## Decision

### 1. One revoke dialog for both kinds of connection

`RevokeDialog` (`web/src/integrations/settings/RevokeDialog.tsx`) now takes the revoke mutation and its copy (open
label, title, body, confirm label) as props; `IntegrationRevokeDialog` wraps it with the webhook-URL copy and is what
the integration settings use, unchanged for the person. The source card wraps it with a source copy. Everything
that made the dialog safe is shared, not copied: focus starts on Cancel, Escape and Tab behave, the reason is one of
the three radio cards that match the server's closed list, and Enter on a radio never revokes (only the confirm
button does). Rejected: a second dialog in `web/src/sources/` (two copies of a destructive control drift apart), and
moving the dialog to `components/` (it depends on the integrations error copy; the move adds churn and no behaviour).

### 2. The card shows the fingerprint, the revoked state and what happened to the encrypted copy

Every source card shows `Fingerprint` (monospace), with a line saying it is computed from the stored secret and is
not the secret, or why there is none. The fingerprint stays after a revoke, as on the server. A revoked source also
shows `Stored secret: Revoked` (danger badge) and its `Encrypted copy` state, in three cases rather than the
integration's two: destroyed (`keyDestroyed`), being destroyed (revoked with a fingerprint: the credential sweep runs
every minute and destroys it once the drain window has passed), and kept until an operator destroys it (revoked with
no fingerprint: ADR 0036's review round makes the destroy wait for one, so "being destroyed" would be false). The
parser requires the three fields (a malformed row is an error, as for every other source field) and never reports a
destroyed key on a row that is not revoked.

### 3. A revoked source has one way back, and the card points at it

A red-rail notice says the source refuses every event until an admin rotates the secret (generic) or pastes a new
credential from the provider (GitLab, Stripe). The receiving switch stays off, is `aria-disabled`, and its state text
says the secret was revoked, because the server refuses to turn a revoked source on; pressing it sends nothing. The
revoke button is gone while revoked. After a revoke the card announces it in a status region and moves focus to the
rotate button, the next step (the revoke button that had focus no longer exists). The rotate dialog of a revoked
source says the source is turned back on and the revoked secret stays refused; for a provider it asks for a new
credential, not the revoked one. Rotating clears the notice and the badge: the server lifts the revoke and switches
the source on in the same statement (ADR 0036).

### 4. Admins only, as the server enforces it

The control sits with Rotate and Delete, which a member already does not see (`isAdmin`, from `/api/workspace/me`). The
server still answers 403 to a member; the a11y mock server does the same, so a test cannot pass by a hidden button
alone. The members' hint now says admins can rotate or revoke the secret.

### 5. Copy

New strings are under `sources.card.*`, `sources.revoked.*`, `sources.revoke.*` and `sources.rotate.*revokedBody` in
`messages.en.ts` and `messages.sources.vi.ts`. They state what the server does and nothing more: no HTTP status
(ingress answers 410 for a switched-off endpoint, which the copy does not need), "a few minutes" for the destroy
(drain window plus a one-minute cron), and the Cloudflare Time Travel caveat already used for integrations.

## Consequences

- No API, migration or server behaviour change. The new server test pins what the dashboard relies on: no Origin,
  a member, another workspace and a missing id are each refused without touching the row, and the audit entry carries
  the kind and the chosen reason (`tests/security/credential-lifecycle.test.ts`).
- A client older than this change keeps working: it ignores the three fields. A server older than ADR 0036 would now
  fail the strict parse of the source list; no such server is deployed with this client.
- The integration dialog's behaviour and copy are unchanged; its tests run against the shared component.

## Verification

- jsdom and axe (`web/src/a11y/dialogs.a11y.test.tsx`, "source credential"): fingerprint and the no-fingerprint
  line; the dialog's focus contract (Cancel first, Tab trapped, Escape closes, focus returns); Enter on a reason does
  not revoke; revoke sends `POST /api/sources/src_1/revoke-credentials?org=…`, then the badge, copy state, notice and
  locked switch appear, the fingerprint stays, and focus lands on Rotate; rotate lifts it; destroyed and kept copy
  states; GitLab wording; no control for a member; Vietnamese with diacritics. Axe is clean on every state.
- Unit (`web/src/sources/sources.test.ts`): the parser reads and requires the fields; the API call sends the reason
  as JSON to the workspace-scoped path.
- Typecheck, lint, format and `docs:check` on the changed files.

## Not done

- No browser pass at desktop or 320 px, no screen-reader pass, no real-contrast check, no screenshot. The card adds
  one wide fact and, when revoked, two facts and a notice; the reflow of a revoked card at 320 px is unverified.
- The fingerprint in the audit view, and the fingerprint per delivery attempt (ADR 0036, still open).
- Nothing here has run against a real D1 or a real provider.

## Revisit when

- A source gets a detail page of its own: the credential facts and the revoke control move there with the rotate
  action.
- The revoke reasons change on the server: the dialog reads `REVOKE_REASONS` from `web/src/lib/api.ts`, which must
  follow.
