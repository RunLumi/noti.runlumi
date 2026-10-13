# ADR 0009: Delivery log, manual redelivery, workspace data screens, Teams in the wizard

Status: Accepted · Date: 2026-10-13 · Implements slice 6b in part (F181, F182, F213, F218 —
each in part, as listed below; F207 and F215 are not built)

## Context

Delivery state existed only in the database. A person whose notification did not arrive had
nowhere to look, an admin could not redeliver, and `/activity` was a placeholder. The slice 4
service `redeliver()` had no route. The workspace export and two-phase deletion API (ADR in
PR #12) had no screens. PR #15 made `teams` a valid destination kind, but the wizard could
not create one.

## Decisions

1. **A tenant-scoped read API that returns facts, not payloads.** `GET /api/deliveries`,
   `/summary` and `/:id` (`src/api/deliveries.ts`, view mapping in `delivery-view.ts`). Every
   query carries `organization_id`; the integrations join repeats the check so a stale
   `integration_id` cannot pull another workspace's name into the log. Responses contain ids,
   state, attempts, timestamps, the integration's name/repo/destination host and a *taxonomy
   code* with its user-facing wording from `src/platform/errors.ts`. No payload, URL or secret
   is ever selected. Cursor pagination is by `(updated_at, id)`, limit at most 100.

2. **Replay is admin-only, idempotent by outcome, audited.** `POST /:id/replay` needs
   `delivery.replay`, our `Origin` and JSON (as the integrations API), is rate limited and is
   refused while workspace deletion is pending. While an earlier replay of the same delivery
   is queued or has succeeded, a second request returns it (`created: false`) rather than
   sending twice. Only dead-lettered deliveries are replayable; the service already refuses
   delivered ones.

   *Replay needs a usable integration.* The consumer dead-letters a message whose integration
   is deleted, paused or quarantined, so a replay would return 202 and then fail. The service
   now refuses with `409 integration_unavailable` ("fix the integration first, then
   redeliver"), the delivery view carries `integrationStatus` (`available`, `missing`,
   `disabled`, `quarantined`) and `canReplay` requires `available`; the dialog explains which
   it is instead of offering a button that cannot work.

   *The audit row is atomic with the replay.* The `delivery.replay` insert is a statement in
   the same `db.batch` as the replay, placed straight after the delivery insert and guarded by
   `changes() > 0`, so it exists exactly when a new replay row was created. A failed audit
   write rolls the replay back (a 5xx, nothing queued) rather than leaving an unaudited
   replay. The same insert carries the integration-usable and no-pending-deletion guards, so
   a pause, quarantine, delete or deletion request between the read and the write wins. The
   source row's `updated_at` is left alone so a reader's cursor does not shift.

   *Rate limits.* Writes keep 30 per minute per user; reads get 300 per minute per user
   (`429` with `Retry-After`), using the shared limiter in `src/security/rate-limit.ts`.

3. **The UI says "at least once", always.** The log page and the detail dialog state that a
   notification may occasionally arrive more than once. A redelivery is described as a *new
   delivery*; the failed one stays in the log. Teams rows show **Accepted**, never Delivered,
   with the explanation that Teams cannot confirm the flow posted the message.

4. **Outcomes are chips with an icon and a word.** Waiting, Sending, Delivered, Accepted,
   Retrying, Failed, Suppressed. Colour only reinforces: green (Delivered), amber (Retrying),
   red (Failed), neutral for the rest. Legacy `failed` rows are shown as Failed.

5. **Plain-language failure explanation.** The detail dialog turns the taxonomy code into
   what happened, whether Noti retried, and the next step (often a link to the integration's
   settings). The raw code appears only under "Details for support".

6. **Table, then cards.** TanStack Table with rows keyed by delivery id, so a new redelivery
   landing on top does not move focus returned to a row. Below the table breakpoint each row
   becomes a labelled card; the page never scrolls horizontally at 320 px. Filters (outcome,
   integration, from/to) live in the URL so a filtered view can be shared; "load more" appends
   pages instead of numbered paging because the cursor has no total.

7. **No invented numbers.** Overview figures (delivered, accepted-but-not-confirmed, failed,
   retrying in the last 24 hours) come from `/summary`, which counts rows. When there are no
   deliveries the page says so. Nothing is estimated, and there are no rates or latencies.

8. **Workspace data lives in Settings.** *Export workspace data* downloads the credential-free
   JSON. *Delete workspace* needs the workspace name typed, then shows a scheduled state with
   the purge date and a Cancel button. The copy states the 7-day window, what happens right
   away, and the D1 Time Travel caveat from `docs/SECURITY.md`: the data may remain in
   Cloudflare's point-in-time history for up to 30 days after the purge. Members see the
   controls disabled (`aria-disabled`, so keyboard users still find the reason) with an
   explanation, not hidden.

9. **Teams is in the wizard, because it can be done completely.** Guidance for the Power
   Automate Workflows "Post to a channel when a webhook request is received" template; the
   URL host must end in `logic.azure.com` (the same policy the server uses, imported from
   `url-policy.ts`); trigger access must be *Anyone* because Noti cannot sign in as a
   Microsoft user (`triggerAuth` is omitted, which the API treats as `anyone`); the orphaned
   flow warning (the flow belongs to its creator) and the accepted-is-not-delivered caveat
   appear on the step. Test send for Teams (F215, which must ask the person to confirm the
   message appeared) is not built, so the wizard does not offer it.

## Indexes

Migration `0013_delivery_log_indexes.sql` adds `deliveries(organization_id, updated_at DESC,
id DESC)` for the list and `deliveries(organization_id, created_at)` for the 24-hour summary,
whose predicate is now `created_at >= ? OR (created_at IS NULL AND updated_at >= ?)` instead
of `COALESCE(...)`, which no index can serve. Tests assert with `EXPLAIN QUERY PLAN` that the
list uses its index with no sort step and the summary uses its index. The summary query names
its index (`INDEXED BY`), because without ANALYZE statistics SQLite may pick the broader
`deliveries_org_idx`; the consequence is that migration 0013 must be applied before the
Worker that uses it is deployed. Rollback is `DROP INDEX` for each (no data changes).

## Not built

Test send (F215), the setup-progress model (F207), per-attempt history (F184), free-text and
event-type filters, bulk replay, a dedicated dead-letter page with a health banner, and
export of the log. The detail dialog says plainly that Noti records created, first attempt,
latest attempt and stop time, not every attempt.

## Verification (2026-10-13)

**Automated.** `npm run format && npm run check` passes: format, lint, Worker and web type
checks, the Worker and web tests (API tests over the fake D1 for the delivery routes;
`web/src/deliveries/deliveries.test.ts`; Teams cases added to the integrations client
validation test, which cross-checks every URL against the real server parser), web build,
Worker bundle check.

**Browser, against a real local Worker.** `wrangler dev` with local D1 (all migrations),
the real Worker code and the Vite dev proxy. Setup done outside the UI and therefore not
evidence of those paths: the account was signed up through the API and marked verified in D1;
the workspace was created through the Better Auth API; two integrations, seven delivery rows,
one outbox row and one GitHub installation with two repositories were inserted directly into
D1.

Checked in the in-app browser (Chromium) at 1280 px and 320 px:

- Activity page: filters, table, stacked cards at 320 px with no horizontal overflow, detail
  dialog for a failed delivery, Escape closing the dialog and returning focus to the row's
  button.
- Redelivery through the real API: the confirmation step, `409` "original message is no
  longer available" when the outbox row did not exist (shown honestly), then, after adding the
  outbox row, `202` and the new Waiting delivery appearing under "Redeliveries of this
  delivery". Replay while a workspace deletion is pending returned `409`.
- Settings: schedule deletion (type the name, real API), the scheduled notice with the purge
  date, Cancel deletion; the export endpoint returned `credentialsIncluded: false`.
- Create wizard: Teams option, the Teams step with the caveats, no overflow at 320 px (a
  one-word hostname did overflow the guide until `overflow-wrap` was added), and a Teams
  integration created through the real API; it appears in the list and in the log as
  Microsoft Teams.
- Overview: delivery figures come from `/summary`.

The review follow-up (integration-unavailable refusal, atomic audit, indexes, read rate
limit, export blob URL revoked after a delay) was verified with the API and web tests over
the fake D1, including `EXPLAIN QUERY PLAN`; it was not re-run in the browser.

**Not verified.** The file download itself was not triggered (the export endpoint was called
with `fetch`). The member (non-admin) view of Settings and the Redeliver control was not
rendered in a browser (no second account); it is covered by the API role tests and by source
inspection. No axe scan or screen-reader pass. Vietnamese strings were not rendered (the
catalogue is English only). The wizard was walked to the Teams step but not submitted through
the UI; creation was verified through the API. Nothing was tested against a real Teams, Slack
or Lark endpoint; no delivery in the log was produced by a real provider.
