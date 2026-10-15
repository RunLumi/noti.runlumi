# ADR 0056: Delivery and source detail as routes, and a Destinations health page

Status: Accepted · Date: 2026-10-15 · Completes the remainder of slice 1.27 (F205) in
[`docs/specs/REMAINING.md`](../specs/REMAINING.md): the delivery detail and the source detail get their own addresses,
and the navigation gets a Destinations health item. Spec 14 is authoritative. Builds on
[ADR 0025](0025-setup-and-shell-ux.md) (route guard as a list, shell 404, breadcrumbs, `returnTo`),
[ADR 0050](0050-request-id-in-detail-and-pause-delete-impact.md) (the detail dialog's support details) and
[ADR 0023](0023-delivery-ledger-depth.md) (the breaker and pacing state `GET /api/integrations` reports).
Supersedes the sentence of ADR 0025 decision 4 that the two details have no breadcrumb. **No migration, no new
endpoint, no new metric.**

## Context

F205 says "every state a user can reach is a URL" and that a support reply must resolve to a working deep link. After
ADR 0025 two states still had no address:

- **A delivery's detail** was a dialog opened from a row of Activity. Its content (state, what happened, duplicates,
  facts, attempts, replays, redeliver, request id) existed only while the dialog was open.
- **A source's detail** was a card in the list on Sources. There was no way to link to one source.

F205's final navigation also names a **Destinations health** item, which did not exist. The data it needs already
reaches the dashboard: every row of `GET /api/integrations` carries the destination kind and host, the switch, the
credential state (`ok`, `legacy`, `quarantined`, plus `revoked`) and, when the server has a record, a `health` object
with the breaker state, failures in a row, the retry time, a pacing hold and how often the breaker opened (ADR 0023).
`toHealthView` returns no object at all when the integration has never had a breaker-class failure or a pacing hold, or
when a quiet closed record was cleared.

The API already answers `GET /api/deliveries/:id` and `GET /api/sources/:id` with `404` for an id another workspace
owns, the same as for an id that does not exist (`WHERE ... AND organization_id = ?`).

## Decision

### 1. Keep the dialog, add the route (the smaller honest change)

Two options were weighed for each detail:

- **Navigate from the list to the route.** The list would unmount on every "Details" click: the filters survive in the
  URL, but the loaded pages of the infinite list, the scroll position and the row focus returns to do not. Rebuilding
  that would be the larger change and would make the common case (look at a few failures in a row) worse.
- **Keep the dialog and add the route** (chosen). The dialog stays the quick look from Activity, with its focus return.
  A delivery's own page renders the **same body**: `DeliveryDetailBody` was extracted from the dialog and both use it, so
  they cannot drift. The dialog gains one real link, "Open as a page", with a hint that the page can be bookmarked or
  pasted into a reply. On the page, opening a replay or the first delivery of a repeat navigates to that delivery's
  page (the dialog switches in place, as before). Section headings are one level under the title in both places
  (`h3` under the dialog's `h2`, `h2` under the page's `h1`), so neither outline skips a level.
- A source's page renders the **same `SourceCard`** in a `standalone` mode: the page heading names the source, so the
  card drops its own heading and its link to itself. Each card on the list gains an "Open page" link (with an accessible
  name that includes the source), and an integration that routes from a source now links to that source's page rather
  than to the list.

Routes: `/activity/$deliveryId` and `/sources/$sourceId`. The two list routes became index routes (`/activity/`,
`/sources/`) so the detail routes are siblings, exactly as `/integrations/` and `/integrations/$id` already were; links
keep saying `/activity` and `/sources`.

### 2. Reload, guard, 404 and breadcrumbs

- **Reload.** Each page reads only its own endpoint (`GET /api/deliveries/:id`, `GET /api/sources/:id`, the latter added
  to the web client as `sourcesApi.get` and `useSource`). Nothing is assumed from a list that may not be loaded. The
  source page shows the cached list row at once when there is one and still confirms it, like integration settings.
  The Worker already serves the SPA shell for every non-API path, so a cold load works server-side without change.
- **Guard.** `/sources` and `/activity` become `prefix` rows in `route-guard.ts`; `/destinations` is a new `exact` row.
  Signed out, the guard sends the visitor to sign in with `returnTo` set to the detail page (the existing
  `safeReturnTo`). The guard test now replaces every `$param` when it checks that each file route has a row, and a
  look-alike such as `/activityx` still has none.
- **404.** A `404` from either endpoint renders the shell's own `RootNotFound` inside the shell. Because the server
  answers the same for "deleted" and "another workspace's", the page cannot and does not say which, and it does not
  echo the id. Other failures are an error with a retry, never a 404.
- **Breadcrumbs.** `Workspace › Activity › Delivery` and `Workspace › Sources › <source name>`. The source crumb fills
  in the name from the same query the page uses and keeps the generic "Source" for an id the workspace does not hold,
  so a foreign name never appears. The delivery crumb stays generic: a delivery has no name of its own and the page
  heading already names the integration. The document title is "Delivery · Lumi Noti" and "Source · Lumi Noti".
- **Workspace switch.** Switching workspace on a detail page goes to its list (`/activity`, `/sources`), as it already
  did for `/integrations/:id`: the id belongs to the workspace just left.
- **Delete from the source page** goes back to the list. The delete hook now refreshes the list and only marks the
  deleted source's own query stale (`refetchType: 'none'`), so the page does not flash "not found" on the way out;
  opening the address again refetches and shows the 404. A rotated secret is revealed on the source page exactly as on
  the list (`useSourceOutcome`: component state only, discarded on dismissal or navigation); the page navigates only
  to `/sources` and puts nothing in the URL (tested by source scan).

### 3. Destinations health (`/destinations`)

One page, one table, one row per integration (each integration has exactly one destination), in the order the API
returns them. Columns: the integration (a link to its settings, with its repository or "Events from your own system"),
the destination kind and host, the switch (On / Turned off), sending (the breaker: sending normally, paused
automatically with "Tries again …", checking the destination; plus "Slowed down until …" for a pacing hold and "Paused
automatically N times so far"), failures in a row, and the webhook URL state (stored, needs to be entered again,
unreadable, revoked).

- **Nothing is computed.** `destinationRow` (pure, unit-tested) passes the API's values through. When there is no
  `health` object both the sending cell and the failures cell say **"Not reported"**, never `0` and never "healthy",
  and a note under the table says what that means: no health record, started at the first failure or slow-down
  request, cleared after a quiet period, and not proof that a message arrived; the integration's page has the recent
  deliveries. A second note repeats the ADR 0023 rule that Noti pauses sending by itself but never turns an integration
  off.
- Loading, empty ("No destinations yet", with the create link) and error states use the shared components; a failed
  load is an error, never an empty table. The 200-row truncation notice of the Integrations page is shown when the API
  says `truncated`.
- The table reuses the delivery log's `.delivery-table` markup and styles: explicit table roles, and below 760px each
  row stacks into a labelled card, so nothing scrolls sideways at 320px. The integration link is a 44px target. Each
  state has its own word and icon; colour is a rail, not the signal. The only new CSS is `destinations/destinations.css`
  (two rules), added to the static 320px reflow test.
- **Navigation.** "Destinations health" (Tabler `heartbeat`) sits after Activity and its failed-deliveries link, for
  members and admins. That makes eight primary items for an admin. F205's cap of six at 1280px is not met; it was not
  met before this change either (seven), and folding Sources and Audit into other screens is a separate decision.

### 4. Copy

All strings are in `messages.shell.en.ts` and `messages.shell.vi.ts` (a new catalogue merged in `i18n/index.ts`, so
this slice does not collide with other edits to the shared files). Vietnamese uses "nơi nhận" for destination, as the
existing breaker copy does. No literal number appears in any message.

## Consequences

- Two addresses now exist that a support reply can use, and both survive a reload. The dialog remains, so Activity
  works as before for the common case.
- The detail body is one component used in two places; a change to the dialog's content now changes the page too,
  which is the point.
- `/activity` and `/sources` are prefix rows: any deeper address under them is answered by the router's 404 inside the
  shell rather than by a missing guard row. That is the same contract `/integrations` already had.
- The admin navigation has eight items. The F205 six-item cap is further away than before.

## Verification

Automated, run for this change (only the touched files and `web/src/a11y/`, as instructed):

- `web/src/shell/detail-routes.test.tsx` (jsdom, real route components, mock API): a cold load of `/activity/del_3`
  reads only `GET /api/deliveries/del_3?org=…`, shows the dialog's sections as `h2`, the request id, the breadcrumb
  and the title; an id the workspace does not hold shows the shell 404 inside the shell and never the id; signed out
  goes to `/signin?returnTo=/activity/del_3` with no delivery request; "Open as a page" in the dialog is a real link that
  navigates; a repeat's "Show the first delivery" moves to that page. `/sources/src_1` loads cold with the source name in
  the heading and breadcrumb, the card without a self-link; the list links each card; a foreign id is the 404 and the
  breadcrumb keeps "Source"; delete returns to the list without a "not found" flash and without refetching the deleted
  address; an integration from a source links to its page. `/destinations` lists every fixture integration, the open
  breaker's state, retry time, failures and times opened as reported, "Not reported" twice on rows with no record, the
  note, the nav item for a member with `aria-current`, and an error instead of an empty list.
- `web/src/shell/shell.test.ts`: guard rows for the new paths and look-alikes, every file route has a row, the nav item
  for members and admins, the new breadcrumbs.
- `web/src/a11y/pages.a11y.test.tsx`: seven new axe scenarios (delivery page, delivery 404, source page, source 404,
  destinations, empty, error), each in English and Vietnamese, zero serious or critical violations; the route-coverage
  test mirrors the three new file routes. `keyboard.test.tsx`: the shell tab order includes the new item.
- `web/src/destinations/health.test.ts`, `web/src/sources/sources.test.ts` (the source page's secret and navigation
  rules), `web/src/a11y/reflow.test.ts` (the new stylesheet).
- Type checks (`typecheck`, `typecheck:web`), ESLint and Prettier on the changed files, `docs:check`, `build:web`.

## Not done, and not verified

- **No browser pass.** The pages were not opened in a real browser at desktop or 320px, not with a screen reader, not
  with forced colours or reduced motion, and no screenshot was taken. The 320px claim rests on the reused stacking CSS
  and the static reflow test. The Vietnamese copy has not been reviewed by a native speaker.
- The full test suite was not run (machine load); only the files above.
- The six-item navigation cap of F205, and the rest of spec 14's "Is it working?" grouping, are not done.
- The Destinations page shows a snapshot from page load (with the query's normal refetch on focus); it does not poll.
- `lastFailureCode` and `lastFailureAt`, which the server's health view has, are not parsed by the web client and are
  not shown.

## Revisit when

- The navigation is reworked to meet the six-item cap.
- A destination status model with probes and a degraded state exists (slice 2.7): the Sending column should show it.
- Someone needs a link to the Activity list with a delivery's dialog open (a `?delivery=` search value would do it).
