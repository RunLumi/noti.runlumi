# ADR 0018: Send a test notification, and an honest setup-progress model

Status: Accepted · Date: 2026-10-14 · Implements slice 6d: F98 (in part), F207 (in part, a
smaller model than the spec's), F215 (in part), F216 (the optional last step). Specs 07 and 14 are
authoritative; "Not done" lists everything this slice leaves out. Builds on
[ADR 0005](0005-delivery-reliability.md), [ADR 0007](0007-integrations-ux.md),
[ADR 0009](0009-delivery-log.md), [ADR 0013](0013-accessibility-localization.md) and
[ADR 0016](0016-noise-control.md).

## Context

A person who has pasted a webhook URL has no way to learn whether it works until a real event
happens, which may be hours away. That is the largest onboarding gap, and it is also the cheapest
place to lose trust. `docs/PRODUCT.md` wants most first-time users to reach a first delivery
without help; a working test message is that moment. Separately, the Overview told a new user
nothing about what was left to do.

## Decisions

1. **The test is a real delivery, not a shortcut.** `POST /api/integrations/:id/test`
   (`src/api/test-send.ts`) builds a canonical notification labelled as a test (title "Test
   notification from Noti", a summary saying the user asked for it, status `info`, event type
   `test`, no URL) and writes an ordinary `deliveries` row plus `notification_outbox` row in one
   batch, then kicks the dispatcher exactly as an ingress route does. Claiming, retries, error
   classification, redaction, the URL policy and allowlist, the adapters, Discord's dead-webhook
   pause and the sent-versus-accepted distinction all apply, because nothing was bypassed. The
   alternative, calling the adapter from the request, would have proved the adapter works and
   nothing about the path real events take, and would have needed a second copy of credential
   opening and SSRF checks.
2. **Each click is a new delivery.** The id is `SHA-256(domain ‖ org ‖ integration ‖ nonce)` with a
   per-request random nonce and its own domain tag, so a test id can never equal a real delivery
   id, and two clicks never collapse into one row (a deterministic id would make the second click
   a silent no-op, which looks like a broken button).
3. **`is_test` is a column (migration `0022`, `ADD COLUMN ... NOT NULL DEFAULT 0`).** Nothing in
   delivery reads it. It exists so reporting can tell a person's click from the service's work:
   the observability SLIs (success ratio, retry rate, latency, error codes, per-destination
   breakdown, backlog ages) and the Overview's 24 hour counts exclude tests, stall detection ignores
   them, and setup progress does not count a test as a real event. The column has
   `CHECK(is_test IN (0,1))`. **Deploy order: apply migration 0022 before the Worker that reads
   `is_test`** (the previous Worker ignores the column, so applying first is safe). Alternatives rejected: a marker in `dedup_key` (a hash, not
   queryable), `replay_of` (a test is not a replay), or parsing the outbox payload (purged after
   seven days while the delivery lives on). A replay of a test copies the flag, so redelivering a failed test
   does not pollute the SLIs either.
4. **Noise control and routing filters do not apply, by construction, not by a string.** The route
   never goes through the ingress noise planner or the filter decider, so a test is never held and
   never filtered. An earlier draft also bypassed both for event type `test`; the security review
   found that a signed generic-webhook event can name its own type, so a sender could have used it
   to skip a deny rule or quiet hours. Those bypasses are removed (`tests/routing/filters.test.ts`
   and `tests/noise/decision.test.ts` assert `test` gets no special treatment), and nothing
   downstream needs one: the test never enters a path that holds or filters. `test` and `noti.*`
   are also reserved at generic ingress (`parseGenericEvent` refuses them with a `400` and a
   field error on `type`, the route's existing contract for an invalid event), so no sender can
   produce an event that looks like one of ours. Test-ness is the `is_test` column only, which
   only `test-send` and a replay of a test set.
5. **Authorization and abuse limits.** Capability `integration.update` (a member may test what
   they may edit; no new capability). The central `requireSameOrigin` middleware plus the same
   Origin and JSON content-type check as every mutation. Refused with `409` and a `reason` while
   workspace deletion is pending, when the integration is paused, when its credentials are
   quarantined, or while a test is already running; a row in another workspace is a `404`
   identical to a missing one and consumes no budget (the tenant lookup comes first). Every click is
   an outbound request into a customer-chosen destination, so the limits are layered, per minute:
   5 per integration, 20 per user, 30 per workspace, and 10 per destination host **across all
   tenants** (a shared host such as hooks.slack.com, or one custom-webhook host, cannot receive a
   flood assembled from many workspaces). `429` with `Retry-After`. The windows are fixed, so a
   caller can land up to twice a limit around a window boundary; the in-flight guard and the host
   limit bound what that can do. **In-flight guard:** a new test is refused with `409
   test_in_flight` while an `is_test` delivery for the same integration was created in the last 15
   minutes and is `pending`, `claimed` or `retrying`. The check runs before any budget is spent and
   again inside the insert's guard (atomic), so retries cannot stack: at most one test per
   integration per 15 minutes can be retrying. The insert repeats the usability and deletion
   guards in SQL, so a pause that lands between the read and the write wins. An audit row
   (`integration.test`, ids only) commits in the same batch and only if the delivery row was
   written. The response is `202 {deliveryId}` and nothing else.
6. **The result comes from polling `GET /api/deliveries/:id`.** The client waits at most 30
   seconds at a one-second interval (`web/src/integrations/test/poll.ts`, pure and unit-tested with
   a fake clock), tolerates two failed reads (a `429` while polling is not a failure: it waits as asked, capped, and ends as "still waiting" if the bound passes), and stops on `sent`, `accepted`, `dead_lettered` or
   `retrying`. `retrying` ends the wait because the person has something to read and nothing to
   do. After the bound the panel says it is still waiting and links to Activity; it never claims a
   result it did not see.
   **A test to a custom webhook shows two buckets only.** With a tenant-chosen host, the HTTP
   status class is an oracle for probing what answers where, so the delivery view of a test to a
   `generic_webhook` reports `destination_unavailable` (could not reach it) or
   `destination_unauthorized` (it answered and refused), never 401 versus 404 versus 429; a
   success is the third bucket (reachable). Other destinations keep their real classification.

7. **Plain-language results, honest about what each state proves.** `sent`: the destination
   confirmed it. `accepted`: it accepted the message and does not say whether it was shown; for
   Teams the copy says so in as many words and points at the workflow's run history. Failures use
   the existing taxonomy message ids (`errors.*`, the delivery log's catalogue), so provider text
   never reaches the screen, with a fix link to the credentials section for credential-class
   codes, the destination's documentation, and a per-destination "where to look" line. A `409`
   is explained from what the dashboard already knows about the integration (paused, quarantined,
   or otherwise unavailable); the generic `409` copy talks about quotas and would mislead.
8. **Setup progress is derived, never stored.** `GET /api/setup/progress` (`delivery.read`) returns
   four steps from real rows: a source is connected (an active GitHub installation, or an
   **enabled** generic, GitLab or Stripe source), an integration exists, a destination is
   verified, and a real event was received (any non-test delivery, in any state: even a failed one
   proves the source reached Noti). Each step carries `done`, `status`, `since` (the earliest
   evidence) and a closed `nextAction` key. "Verified" counts only deliveries to an integration
   that still exists, is enabled and is not quarantined, within 30 days, and is a tri-state:
   `done` for a `sent` delivery (the destination confirmed), `accepted` for accepted-only
   evidence (Teams Workflows, a Discord 204: "accepted, not confirmed", `done` false).
   `complete` means no step is still `todo`, so an accepted-only workspace is not nagged forever;
   the step still says what it is while the card is visible. The delivery queries are
   `INDEXED BY deliveries_org_created` and take the first row in index order, so a missing
   migration fails loudly and cost does not grow with the ledger (`EXPLAIN QUERY PLAN` test).
   "Verified" is not sticky: evidence ages out after 30 days or when its integration goes away.
9. **Dashboard.** A "Send a test notification" section on the integration settings page and a
   compact "Send test" button on each list row share one component (`TestSend`). The create wizard
   gains an optional seventh step, "Test it", shown after the integration is saved: skipping is
   always safe because the work is already done. The Overview gains a "Finish setting up" card that
   lists the steps with the next action as the only button and disappears when everything is done;
   while loading, or if the request fails, it renders nothing and no alert (it is guidance, and a
   screen that works without it must not show an error for it). The delivery log marks test rows
   with a "Test" badge.

## Accessibility

The result region is `role="status"` (polite, atomic) and exists before the first click, so the
outcome is announced. Focus stays on the button: moving it to the result would announce the same
text twice. In the wizard, focus moves to the new step's heading, as for every other step. A paused
or quarantined integration's button is `aria-disabled` (still focusable) with the reason beside it.
Status colour always comes with words ("Done", "Next", "Not done yet", "Test sent"). Every
string has an English and a Vietnamese message (`messages.setup.*`); the catalogue and
hard-coded-string tests cover them; axe scans every outcome in English and the main ones in
Vietnamese.

## Not done

- **Scheduled re-tests and health checks** (F98's "destination health", F100's checks): a test runs
  only when a person asks. Nothing re-verifies a destination later or raises a banner when it stops
  working.
- **Rendered payload preview, HTTP status, latency and provider response code** in the result
  (F98/F215): the panel shows the classified outcome and its explanation, not the wire exchange.
  The ledger does not record them.
- **A capability-gated report** of what the test could not verify (for example editability of a
  sent message) beyond the Teams `accepted` explanation.
- **Testing a source** (a signed webhook endpoint) end to end: the test exercises one
  integration's destination only.
- **F207's seven steps and two state machines**, `blocking_reason`, and a `GET
  /api/workspace/setup-state` with per-step titles. This model has four steps and the copy lives in
  the dashboard.
- **A per-test audit view** in the Audit page: the `integration.test` row exists; no UI was added.
- **Billing exclusion**: there is no billing; `is_test` is ready for it.
- **Server-localised test text**: the message sent to the destination is English.

## Verification

Backend: `tests/api/test-send.test.ts` (authorization, cross-tenant 404 with no budget burned,
CSRF, both rate limits, deletion pending, paused and quarantined refusal, the batch guard race,
no URL or credential in any response, end to end through the real consumer and adapters for Lark,
Slack, Teams and Discord: sent versus accepted, permanent failure classification, retry then
success, the allowlist still rejecting a stored private address, Discord's auto-pause, noise and
filter bypass, SLI and summary exclusion, replay stays a test), `tests/api/setup-progress.test.ts`
(table-driven derivation, then each rule against the real schema), `tests/migration-0022.test.ts`.
Web: `poll.test.ts`, `setup.test.ts`, `test-send.a11y.test.tsx` and the existing axe scenarios,
which now include the card, the new section and the seven-step wizard. The results of the
real-browser pass are recorded in `docs/PROGRESS.md` (slice 6d), with what was and was not seen.
No provider was contacted: every provider response is a fixture, so nothing here shows that a real
Slack, Teams, Lark or Discord accepts the test message.
