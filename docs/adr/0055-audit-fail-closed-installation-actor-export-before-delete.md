# ADR 0055: An audit failure fails the action, the installation as an actor, export before delete

Status: Accepted · Date: 2026-10-15 · Implements the remainder of slice 1.32 of [`docs/specs/REMAINING.md`](../specs/REMAINING.md):
F222 (`docs/specs/14-dashboard-and-ux.md`: "Audit write fails: the action fails", installation actor rendering, export before
deletion) and the fail-closed row of F236 (`docs/specs/15-security-and-compliance.md`). Builds on [ADR 0019](0019-workspace-switcher-audit-log.md),
[ADR 0028](0028-ingress-contract-and-audit-read.md) and [ADR 0039](0039-audit-immutability-and-audited-reads.md), which left these three
open (section 5). **No migration.**

## Context

F222's errors table says "Audit write fails: the action fails. There is no unaudited write path", and F236's says destructive
operations (revocation, member removal, workspace deletion) fail closed. Most writers already put the audit row in the batch of the
change (`auditStatement`), but nobody had checked them one by one, and none of them had a test that made the audit insert fail. Reading
every site found three that wrote the row separately:

- **Workspace deletion request.** The `workspace_deletions` upsert ran on its own; the pause of every integration and the audit row ran
  in a second batch. A failed audit insert left the deletion scheduled (it would purge in 7 days), the integrations still on, and no
  record of who asked.
- **Cancelling a deletion.** The cancel `UPDATE` ran on its own; the restore and the audit row ran after. A failed audit insert left the
  deletion cancelled, every integration still off, and no record.
- **Binding a GitHub installation.** `bindInstallation` committed the binding; the route then wrote `github.installation.bind` with
  `recordAudit`. A failed write sent the person to the generic error page, and the installation stayed bound, unaudited.

Separately, F222 asks that an installation lifecycle row (GitHub uninstalled, suspended, changed the repositories) show **GitHub's
installation** as the actor. Those rows have no `actor_id`, so the audit page called them "Noti (automatic)", which is wrong: Noti did
nothing, GitHub told us. And F222 and F30 ask that the export be offered before a workspace is deleted; it existed only as a separate
panel above the danger zone with a one-line hint.

## Decisions

### 1. Every destructive or security-relevant change commits with its audit row, and a test proves each one

1. **The three sites are now one batch each**, chained with `changes()` guards so the batch does the same thing the separate statements did:
   - Deletion request: `[upsert, audit (only if the upsert changed a row), pause (only if the audit row was written)]`. The 409 for a
     pending request is read from the upsert's row count. The audit row's `disabledIntegrations` is read by SQLite in the same batch
     from the snapshot the upsert stored (`json_array_length`), so it is exact rather than counted before.
   - Cancel: `[guarded cancel, audit (only if it changed a row), restore (only if the audit row was written)]`. The restore reads the
     snapshot from the row it just cancelled, in a scalar subquery with the workspace predicate, instead of a value read back in a
     separate statement. The response's `restoredIntegrations` is the restore's row count, as before.
   - Bind: the row is a statement of `bindInstallation`'s batch, directly after the upsert and guarded on it. `completeVerification`
     takes the request's IP and user agent for it. The route no longer writes the row.
2. **`auditStatement` gains `countAs`**, which adds one count to the metadata from a closed list of fixed SQL expressions in
   `src/audit/audit.ts` (`AUDIT_COUNTS`; today only `deletionSnapshot`). The key is validated as a plain identifier and bound; the SQL is
   a literal. Nothing a request sends reaches the SQL text, and `tests/security/bound-parameters.test.ts` still passes without a new
   allow-list entry. Rejected: interpolating a caller-supplied subquery (an injection surface for a convenience); counting before the
   batch (a race between the count and the snapshot).
3. **`changes()` inside an `UPDATE`'s `WHERE`** reads the row count of the statement before it, as it does in the `INSERT ... SELECT ...
   WHERE changes() > 0` the audit writer already uses: SQLite sets the count when a statement completes, not row by row. This was
   checked against Node's SQLite on a multi-row update before relying on it. Not checked against a real D1.
4. **`tests/security/audit-fail-closed.test.ts`** makes the audit insert for one action fail (a `BEFORE INSERT` trigger that aborts, the
   way a full or failing store would) and asserts the change did not happen, through the real Worker routes over the real migrations:
   integration delete, pause, credential rotation, credential revoke and key destruction; source delete, revoke and rotation; ending one
   session and ending the others; account erasure; workspace deletion request and cancel (each also shows that the same request works
   once the store is back and records the exact count); the final purge step; the workspace and account exports. Elsewhere, in the file
   that already sets up the flow: the GitHub bind and an installation lifecycle transition (`tests/github/install-flow.test.ts`), the
   Discord auto-pause (`tests/pipeline/extended-destinations.test.ts`); already covered before this ADR: a single replay, a bulk replay
   and an invitation cancel. The deletion request and cancel tests were run against the previous code and failed there.
5. **An inventory of every audit write site.** The same test file counts the calls to `auditStatement`, `recordAudit`, `recordDenial` and
   raw `INSERT INTO audit_events` in every file under `src/` and compares them to a list that says, per file, how a failed write behaves:
   `batch` (same batch as the change), `before` (written before anything is changed or returned: the bulk replay's intent row, the audit
   read, both exports), `denial` (a record of a refusal, which never changes the answer: a 500 where a 404 was due would itself leak),
   `best-effort` (the bulk replay's counts row, after durable replays) or `out-of-scope`. A new site fails the test until it is listed.
   It is a text count, not a proof: it sees a call, not whether the call is in the right batch; the behavioural tests are the proof.
6. **What stays as it was, and why.**
   - *Bulk replay* is not one batch: up to 200 replays each read their own row first, and D1 cannot hold a transaction across reads. Its
     intent row is written before the first replay, so a failed write sends nothing ([ADR 0023](0023-delivery-ledger-depth.md), tested). The converse is accepted: a row
     can say "started" for replays a later fault stopped; the "finished" row says how many happened.
   - *An installation lifecycle event* fails closed like the rest: the status change and its row are one batch, and a failed write answers
     5xx with nothing applied. This is a revocation signal, so failing it could in principle keep an installation active. It is accepted
     because GitHub itself stops sending events for a suspended or deleted installation, the delivery is not acknowledged as accepted
     (so a redelivery applies it), and an unaudited revocation is exactly what F222 forbids. The test shows the redelivery applying it.
   - *Better Auth's own routes* (member removal, role change, invitation create, accept and reject, the session revocation after a
     password reset) are audited by an `after` hook once Better Auth has committed. Those rows are not atomic with their change. This is
     REMAINING 2.3 and is out of scope here; the inventory names `src/auth/audit-hooks.ts` as such.

### 2. GitHub's installation is an actor of its own

1. **Write.** Every `github.installation.lifecycle` row now carries `account` (the installation's GitHub login, read with the row the
   event resolved), so the name is frozen at write time, as F222's schema sketch asks (`actor_label`, without the column, which would need
   a migration). A rename's own metadata carries the new login and wins.
2. **Read.** `GET /api/audit` returns `actor: {kind: 'installation', account}` for a row with no `actor_id` whose action is in
   `INSTALLATION_ACTIONS` (today only `github.installation.lifecycle`). `account` is the frozen login, else the installation's current
   login from a `LEFT JOIN github_installations` that repeats the workspace predicate (`gi.organization_id = e.organization_id`), else
   `null`. A row of this workspace that names another workspace's installation row reads no login (tested). The login passes through
   `safeText` like every other shown value. Noti's own automatic actions (`integration.auto_pause`, purges) stay `system`.
3. **Filter.** `actor=~github-installation` selects these rows and `actor=~system` no longer does. A saved link with `~system` that was
   meant to find lifecycle rows now finds Noti's own actions only; this is the point of the distinction and is accepted.
4. **Dashboard.** The Who cell shows the login on the first line and "GitHub App installation" under it (`cell-main` and `cell-sub`, the
   same pair the subject cell uses), or "GitHub App installation" alone when no login is known; never a blank and never the row id. The
   CSV has one plain label, "acme (GitHub App installation)". The Who filter lists "GitHub App installation" after "Noti (automatic)".
   Strings: `audit.actor.installation`, `audit.actor.installation.named` and the revised `audit.filter.actor.hint`, in
   `messages.audit.{en,vi}.ts`. Older dashboards would reject the new actor kind as malformed and show the error panel; the dashboard and
   the Worker ship together, so this is a deploy-order note, not a compatibility layer.

### 3. Export is offered first in the deletion dialog, and never forced

The dialog that schedules a deletion now starts, below its description, with an opaque block "Keep a copy first (optional)": one
sentence on what the export holds (no credentials) and that the deletion can be scheduled without it, and a "Download export" button
that runs the same request as the Settings panel (`downloadExport`, `GET /api/workspace/export` for the workspace the dialog was opened
for, audited as `workspace.export`). The result is a success or error notice inside the block; the dialog stays open and nothing about
the confirmation changes. It is not a step: focus still starts on "Keep workspace", the confirm button does not wait for it, and a
failed export does not block scheduling. It reuses the `.impact` block of ADR 0050 (Paper White, hairline border, Civic Navy title) and
the outline button (44 px). Rejected: requiring a download before the confirm button works (a forced step the user did not ask for, and
one that fails whenever a browser blocks the download); a link that closes the dialog and scrolls to the panel (the person loses their
place in a destructive flow).

## Consequences

- No schema change. `account` in lifecycle metadata was already allow-listed for display (`SUMMARY_FIELDS`), so the detail column also
  shows it; that repetition is accepted.
- Rolling back the Worker restores the separate statements (the old failure modes return) and the old actor rendering; rows written
  meanwhile keep their `account` key, which the old reader already displays as a detail. Nothing is lost.
- An audit store that refuses writes now makes deletion, cancel and bind fail with a 5xx instead of half-applying. These failures are
  not added to the failed-audit-write counter behind the readiness warning (`ops_state.audit_write_failures`, ADR 0039), which counts
  denials and Better Auth hook rows only; they show as 5xx answers. Counting them there is a possible follow-up.

## Verification

Run here, against the fake D1 (Node's SQLite) with the real migrations:

- `tests/security/audit-fail-closed.test.ts` (17 tests: the fail-closed cases and the inventory), and the whole of `tests/security/`.
- `tests/api/workspace-lifecycle.test.ts` and `tests/api/account.test.ts` unchanged and passing; `tests/github/install-flow.test.ts`
  (bind and lifecycle fail-closed, the frozen `account`); `tests/pipeline/extended-destinations.test.ts` (auto-pause).
- `tests/api/audit-read.test.ts`, `tests/api/audit.test.ts`, `tests/api/audit-read-recorded.test.ts`: installation actor with a frozen and a
  current login, no cross-workspace login, the two filters apart, bidi stripping.
- `web/src/audit/audit.test.tsx` (parsing, the two-line cell, Vietnamese, CSV label, filter in the URL), `web/src/a11y/pages.a11y.test.tsx`
  (a new audit scenario with installation rows, axe in English and Vietnamese), `web/src/a11y/dialogs.a11y.test.tsx` (the dialog with the
  export block: axe in both languages, focus still on Keep workspace, export without scheduling, scheduling without export, a failed export).

Not verified: a real D1 (the `changes()` reads and the trigger-based failure are SQLite's), a real GitHub lifecycle delivery, a real
browser download at 320 px, a screen reader, and the Vietnamese copy by a native speaker.

## Revisit when

- Better Auth's member and invitation rows are made atomic (REMAINING 2.3): then the inventory's `out-of-scope` entry goes.
- An `actor_type`/`actor_label` column is added (F222's schema): then the frozen login moves out of metadata.
- Another source has an installation-like actor (a GitLab group hook, a Stripe account): add its action to `INSTALLATION_ACTIONS` or
  generalise the kind.
