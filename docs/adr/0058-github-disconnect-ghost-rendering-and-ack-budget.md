# ADR 0058: GitHub disconnect, ghost rendering across destinations, and the ack budget held structurally

Status: Accepted · Date: 2026-10-15 · Implements the user-initiated part of F70; adds evidence for F60 and F64 (spec 05);
builds on [ADR 0008](0008-github-install-verification.md) §4 and §6

## Context

REMAINING slice 2.10 had three GitHub items that need no new event type and no migration.

1. **F60.** `displayOf` already drops the actor of a `ghost` sender, and the route test checked the queued
   message. Nothing checked what each destination finally renders, at each rung of its degradation ladder (card,
   markdown, plain). A rung that added an attribution line from another field would have passed.
2. **F64.** GitHub expects a 2xx within 10 seconds and otherwise "terminates the connection and considers the
   delivery a failure". The repository records this in `docs/specs/05-source-github.md` F64. One test covered "no
   outbound call" for one fixture. Nothing showed that ingress work does not grow with the payload. One path did
   grow with it: an `installation_repositories` event wrote one INSERT per 25 listed repositories, with no bound
   other than the 1 MiB body cap. That is thousands of statements before the acknowledgement, far past the Free
   plan's 50 D1 queries per invocation (`docs/specs/01-platform-runtime.md`).
3. **F70.** An installation stopped only when GitHub said so (`installation.deleted` or `suspend`). An admin had no
   way to stop one from Noti. ADR 0008 §4 said unbinding "will be an explicit, audited, admin-only action (not
   built)".

Constraints for this slice: no migration, no change to `route.ts` (another change is moving it behind a connector
interface), no invented payload shapes, and every new query carries `organization_id`.

## Decision

### 1. Disconnect marks our row `uninstalled` and pauses the integrations on it, in one batch

`POST /api/github/installations/:id/disconnect` (`src/api/github.ts`, logic in
`src/connectors/sources/github/disconnect.ts`):

- It is admin only, under `source.revoke`. It stops a source and pauses integrations, which is the same weight
  as revoking a source credential. A member gets 403.
- It needs our `Origin`. It is refused with 409 while workspace deletion is pending. It is rate limited to 10 per
  admin per minute.
- Another workspace's id gets 404, the same answer as a missing id.
- One D1 batch does the following, in order:
  - sets the row to `status='uninstalled'`, only from `active` or `suspended`;
  - writes one `github.installation.disconnect` audit row (`account`, `previousStatus`, `pausedIntegrations`),
    only if that UPDATE changed the row;
  - writes one `integration.update` audit row per integration that is still enabled, with
    `{fields: ['enabled'], enabled: false, previousEnabled: true, reason: 'github_disconnected'}`;
  - pauses those integrations (`enabled=0`).
- The per-integration audit rows are written with multi-row `INSERT … SELECT FROM (VALUES …) JOIN integrations
  WHERE enabled=1` statements of 40 rows each (`enabledIntegrationAudits` in `src/audit/audit.ts`). They sit just
  before the pause, so they record exactly the rows it turns off. A workspace at the 100-integration cap costs 7
  statements, not 202.
- "The integrations on it" are the workspace's GitHub integrations (no `source_id`) whose repository owner is the
  installation's account, or whose repository is in its synced set. The second rule covers an integration saved
  before an account rename.
- A repeat changes nothing and writes no second audit row. GitHub is not called: we hold no installation token
  (ADR 0008 §2), so there is nothing of ours to revoke there.

Why `uninstalled` and not a new `disconnected` status: the 0006 CHECK constraint allows only `active`, `suspended`
and `uninstalled`, and this slice may not migrate. `uninstalled` already means "stopped, never revived". The
consequences are honest and fail closed:

- ingress answers 403 `not-active` for every later event, even if someone switches an integration back on;
- the repository picker stops offering the installation's repositories;
- binding the same installation id again is refused.

That refusal now has its own code, `installation_disconnected`, raised by `bindInstallation` when this workspace's
row is `uninstalled`. Its message tells the person to uninstall the App on GitHub and install it again, which
gives a new id. Before this change, the same case surfaced as `installation_deleted`, whose wording ("removed from
GitHub before it could be connected") was wrong here.

Rejected:

- Deleting our row (a true unbind). F70 asks for the row to be marked, the audit trail references the row id, and
  a delete would let another workspace bind the same installation silently once its admin verified.
- Calling `DELETE /app/installations/{id}`. It needs the App private key, which we do not hold, and it would
  uninstall the App for every repository of that account. That is GitHub's decision to make, in GitHub.

### 2. The dashboard says what disconnect does and does not do

- The Integrations page's GitHub panel shows admins a "Disconnect" control on each installation that is not
  stopped. Its accessible name is "Disconnect <account>", and it uses a Tabler Outline `IconPlugConnectedX`.
- The confirmation follows the alert-dialog pattern of ADR 0048: focus starts on "Keep connected", Tab is trapped,
  Escape closes. Its four paragraphs say:
  - updates stop at once, the integrations are paused, and the audit log says why;
  - chat destinations and their webhook settings are kept;
  - the App stays installed on GitHub until someone uninstalls it there;
  - to connect again, uninstall and reinstall the App.
- A link opens GitHub's installation settings for the account, using the URL pattern the repository picker already
  uses (`githubAccessUrl`: `github.com/organizations/<account>/settings/installations` for an organization,
  `github.com/settings/installations` for a personal account).
- On success a status notice names the account and the number of paused integrations. Focus moves to the panel
  heading, because the trigger is gone.
- A member sees "Only a workspace admin can disconnect …" instead of a control.
- `uninstalled` is now labelled "Disconnected" / "Đã ngắt kết nối". Its note covers both causes, because the
  schema cannot tell them apart: an admin disconnected it here, or the App was uninstalled on GitHub. The note
  tells the person how to connect again and repeats the GitHub settings link.
- The audit view shows `reason: github_disconnected` and `previousStatus` in words.

### 3. Ghost rendering is asserted at the last step, for every kind and rung

`tests/github/ghost-rendering.test.ts` takes the manifest fixture `github/pull_request.opened_by_ghost`, plus the
`Ghost` and `GHOST` variants derived from it. It sends each one through the real route. It then renders the queued
message with every registered destination adapter (`DESTINATION_KINDS`) at every format in that kind's
capabilities, using `startAt`.

- No rendering may contain "ghost" or a dangling "by ".
- Title, repository and link must still be there.
- A control test renders the documented sender `Codertocat` in every kind and rung. This proves the check can see
  an attribution.
- A held (grouped) ghost event stores an empty actor, and its combined notification renders none.

No product change was needed: the existing `displayOf` rule holds at every rung.

### 4. The 10-second budget is held structurally, not by a wall clock

A timing assertion against an in-process fake D1 says nothing about production. `tests/github/ack-budget.test.ts`
pins the properties that keep the handler inside the window instead:

- **The citation.** The F64 section of spec 05 contains GitHub's two sentences.
- **For each of the 34 GitHub fixtures in the manifest** (delivered, ignored, lifecycle and ping):
  - with a `fetch` that never resolves, the response still arrives;
  - no fetch and no timer was started before it;
  - the only `waitUntil` is the dispatcher hint, and only for a delivered event.
- **The number of D1 statements does not depend on the payload.** These cost the same as the plain events:
  - a pull request with 1,000 labels and a body near the 1 MiB cap;
  - a push with 2,000 commits.
- **The cost grows only per matching integration**, at a small constant each (10 or fewer statements), and
  `MAX_INTEGRATIONS_PER_WORKSPACE` (100) bounds the count.
- **A D1 that keeps failing** with a retryable error is given up on after at most two backoff waits, totalling
  under 300 ms (`ingressBatch`: 3 attempts), and the request is answered 5xx.

The one unbounded path is now bounded. `MAX_REPOSITORY_DELTA` (1,000 added plus removed, the same bound as the bind
flow) is enforced in `lifecycle.ts`:

- A delta at the bound is stored in under 50 statements.
- A larger one is not stored piecemeal. For a `selected` installation the stored set is cleared and
  `repositories_complete=0` is set, so no repository routes on stale data (a removed one in particular). The
  dashboard's existing "reconnect to refresh" notice then appears.
- An `all` installation routes by account, so it stores nothing.
- The lifecycle audit row records `overflow: true`.

## Consequences

- An admin can stop GitHub events for a workspace at once, without access to the GitHub account. The App, and
  GitHub's deliveries to our endpoint, continue until someone uninstalls it on GitHub. Every one of those
  deliveries is refused with 403, and each refusal is a bounded webhook-probe row (ADR 0028), not one row per
  event.
- Reconnecting the same account needs an uninstall and reinstall on GitHub. This costs the person one extra step.
  It stays until a migration adds a distinct `disconnected` status that `bindInstallation` may revive after a
  verified bind.
- A disconnect pauses integrations, and reconnecting does not resume them. This is deliberate: the person decides,
  and each pause carries its reason in the audit log.
- In a race with GitHub's own `installation.deleted`, the response may say `alreadyStopped` while this request
  still paused the integrations. Each pause is audited, so nothing is hidden.
- A `selected` installation whose repository change exceeds 1,000 stops routing until a reconnect. That is the
  fail-closed direction, and it is visible in the dashboard and the audit log.

## Verification

- `tests/github/disconnect.test.ts` (9 tests), over the real Worker and migrations:
  - disconnect stops the row, pauses exactly the installation's integrations with their reasons, and audits it;
  - neighbours are untouched: another account's repository, the same repository in another workspace, a
    source-bound integration, and destination credentials;
  - later events are refused, including for an integration switched back on;
  - no network call is made;
  - a repeat is idempotent;
  - another workspace gets 404;
  - a member gets 403, and so do a missing or foreign Origin (no session: 401);
  - an unknown id gets 404, and a suspended installation can be disconnected;
  - the rename rule works;
  - 100 integrations take 7 or fewer statements;
  - a re-bind is refused with `installation_disconnected`.
- `tests/github/ghost-rendering.test.ts` (6 tests) and `tests/github/ack-budget.test.ts` (41 tests), as above.
- `web/src/a11y/dialogs.a11y.test.tsx`, "disconnect GitHub": axe is clean on the open dialog, on the disconnected
  state and in Vietnamese. The focus contract holds, and the request goes to the workspace-scoped path. The
  stopped state, the GitHub link and focus on the heading are checked, and a member gets no control.
- The gates that read the code: route capability, the generated `docs/AUTHORIZATION.md` tables, tenant query
  scope, bound parameters (new fragments reviewed, chunk sizes asserted), CSRF, the audit summary allow-list, and
  the i18n catalogue and hard-coded-string tests.

## Not done

- No real GitHub App and no real D1. Everything above ran against mocked GitHub endpoints over a fake D1.
- No browser pass at 320 px or desktop, no screen reader, no native-speaker review of the Vietnamese copy.
- A distinct `disconnected` status (needs a migration), and reviving a disconnected installation after a verified
  bind.
- Purging the installation's synced repository list and envelope data on disconnect (F70 says "per retention").
  The rows stay until workspace deletion or the retention matrix removes them.
- The worst case of D1 retries is unbounded in principle: every integration's batch could fail transiently and
  then succeed, each after up to 300 ms of waiting. A request-wide retry budget needs `route.ts` changes and is
  left for the connector refactor.
- A p99 latency SLO for the handler (F64) needs production telemetry.

## Revisit when

- A migration touches `github_installations`: add `disconnected`, and let a verified bind revive it.
- The App private key exists: offer an optional "also uninstall on GitHub" through the App API, with its own
  confirmation.
- GitHub documents a size for `installation_repositories` lists, or a real event exceeds `MAX_REPOSITORY_DELTA`.
