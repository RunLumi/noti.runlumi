# ADR 0050: The request id in the delivery detail, and what pause and delete affect

Status: Accepted · Date: 2026-10-15 · Completes the dashboard half of slice 1.10 (F193, the id in the detail dialog)
and the pause and delete counts of slice 1.30 (F217) in [`docs/specs/REMAINING.md`](../specs/REMAINING.md). Spec 13
and spec 14 are authoritative. Builds on [ADR 0046](0046-correlation-held-events-and-delivery-logs.md) (the lookup by
id), [ADR 0025](0025-setup-and-shell-ux.md) (settings sections and the danger zone) and
[ADR 0016](0016-noise-control.md) (held updates). **No migration.**

## Context

- Every delivery view has carried `correlationId` since ADR 0024, and `GET /api/deliveries?correlationId=` finds a
  request's deliveries. The dashboard parsed neither: a support reply could not point a customer at the id, and a
  customer could not search by it.
- F217 asks that pause state "the exact consequence" and that delete state, before confirming, "how many deliveries and
  events will be removed". The switch paused at once, with no confirmation. The delete dialog counted only noise-held
  updates.
- What the pipeline does decides the copy, so it was read first (`src/pipeline/consumer.ts`,
  `src/pipeline/noise-release.ts`, `DELETE /api/integrations/:id`):
  - A `pending` or `retrying` delivery of a paused or deleted integration is not sent. When its turn comes the consumer
    finds the integration unusable and marks it failed (`config_invalid`, `integration_unavailable`, permanent).
  - A `claimed` delivery has already passed that check and may still arrive.
  - A failed delivery keeps its outbox message (the outbox purge keeps rows of failed deliveries), so it can be
    redelivered once the integration is on again. A delivery of a deleted integration cannot be (`redeliver` needs a
    usable integration).
  - Noise-held updates of a paused integration are not due. They are released after it is turned back on.
  - **The delete removes no delivery row.** It removes the integration, its held updates, its open noise failures and
    its routing decisions. The delivery history stays, shown as "Deleted integration", until retention removes it.

The slice description said the delete dialog should say how many deliveries "will be removed". That would be false,
so the dialog says how many stay.

## Decision

### 1. The request id in the detail dialog and as a filter

1. **A row in "Details for support", next to the delivery ID and the error code.** F220 puts the support details
   there, collapsed, "alongside the correlation id … which is also copyable". The id is a `<code class="mono-wrap">`
   (Geist Mono, a technical fragment per `DESIGN.md`), followed by the shared `CopyButton` (stated outcome, polite live
   region, honest failure) and a link, "Show every delivery from this request".
2. **The link is a real link** (`/activity?correlationId=…`), so it can be opened in a new tab or pasted into a reply.
   Following it closes the dialog. The list reloads, and the row that opened the dialog can be gone for a moment, so
   focus moves to the page heading instead of being lost on `<body>` (WCAG 2.4.3).
3. **A delivery with no id says so**: "Not recorded. Older deliveries, and ones Noti made without an incoming request,
   have none." No link is offered.
4. **The activity filters take a request ID** (`?correlationId=` in the URL, as on the audit log). The field uses the
   audit log's free-text filter, moved to `components/TextFilter.tsx`: applied on Enter or blur, an impossible value is
   flagged and never sent. Validation is the server's own `sanitiseCorrelationId` (`src/platform/correlation-id.ts`),
   imported, so the client accepts exactly what the API accepts. A value in a delivery view that the server would not
   accept is dropped to `null` when parsed, rather than shown as a filter that would answer `422`.

### 2. One read endpoint for the impact counts

`GET /api/integrations/:id/impact` (`integration.read`, in `src/api/routing.ts`, the integration read side; logic in
`src/delivery/impact.ts`). No existing endpoint returned these: the delivery summary is workspace-wide and limited to
24 hours, and `noise-status` counts held updates only. The answer is counts only:

```
{ impact: { deliveries: { total, unsent, sending }, held: { waiting, failed } } }
```

- **`unsent`** is `pending` + `retrying`, **`sending`** is `claimed`, **`total`** every delivery row of the integration.
  Each is `{count, capped}`. **`held`** reuses `heldStatus` (the same numbers `noise-status` gives).
- **Bounded.** Each delivery count is `SELECT COUNT(*) FROM (SELECT 1 … LIMIT 10001)`: it stops after 10,001 rows and
  reports `capped: true` with 10,000, which the dialog reads as "More than 10,000". The unsent count is its own bounded
  range, not a slice of the capped total. There is no `(organization_id, integration_id)` index on `deliveries`, and
  adding one is a migration: the counts walk the workspace's rows through `deliveries_org_idx`, which retention already
  bounds. The cap bounds the rows counted, not the rows examined.
- **Tenant-scoped twice.** The route loads the integration with `id = ? AND organization_id = ?` (404 otherwise) and every
  count binds the organization again, so a row that names this integration id under another workspace is not counted.
  A foreign workspace gets `404`, with no counts, whether it relies on its session or names this workspace (`?org=`).
- **Rate-limited** at 60 reads a minute per user (the counts cost more than a row read).
- **Registered** in `ROUTE_POLICY`, `docs/AUTHORIZATION.md` regenerated, `docs/API.md` updated. The isolation drill
  attacks it like every other capability route.

### 3. The pause confirmation

1. **Pausing now asks first; resuming does not.** Resuming has no consequence to state, so it applies at once as before.
   The confirmation opens from the switch on the card and on the settings page alike.
2. **The consequence, in order.** "No new notifications will be sent. Settings and credentials are kept, and you can
   turn it back on at any time." Then one sentence per non-empty group: how many have not been sent and that each is
   marked Failed when its turn comes, then redeliverable from Activity after turning it back on; how many are being sent
   right now and may still arrive; how many saved updates stay saved and go out after it is back on; how many past
   deliveries stay in Activity. A group with nothing in it is left out, so the dialog never reads "0 …". With nothing
   waiting it says "No notifications are waiting to be sent."
3. **A slow or failed count never blocks the pause.** It is the first thing to reach for when an integration is too
   noisy (F217). While counting the block says so; if the count fails it says the number is unknown and that pausing
   still works. It never shows a zero it did not measure.
4. **Focus** starts on "Keep sending" (Enter does not pause), Escape cancels, and focus returns to the switch.

### 4. The delete confirmation

1. The existing body (credentials destroyed, cannot be undone) stays. The impact block replaces the old held-updates
   line and adds: how many have not been sent (marked Failed, cannot be redelivered once the integration is deleted);
   how many are being sent now; how many saved updates are deleted and never sent (waiting and failed together); how many
   past deliveries stay in Activity as "Deleted integration" until they age out; and that the record of why updates were
   sent or held back is deleted.
2. **The typed confirmation stays inert while the counts are on their way**, so the statement is on screen before the
   delete can happen. If the count fails, the dialog says so and the delete is allowed: refusing would make a broken
   count a reason an integration cannot be deleted.
3. The counts are asked each time a dialog opens (`staleTime: 0`, `gcTime: 0`): a number from an earlier opening may be
   out of date.

### 5. Presentation

The impact block is an opaque Paper White sheet with a hairline border inside the dialog, a Civic Navy label "What this
affects" and a plain list. No colour carries meaning. It is one `role="status"` region that stays mounted, so the counts
are announced when they arrive. Body copy is 16px. Every string is in `messages.ledger.en.ts` and `.vi.ts`; numbers are
formatted for the locale (1,284 and 1.284).

## Consequences

- Pausing takes one more step than before. That is the cost of stating what happens to undelivered notifications, which
  the spec asks for and which a person cannot otherwise know.
- The detail dialog, the activity filters and both confirmations depend on a field and an endpoint the dashboard did not
  read before. A malformed impact answer is an error, not a zero (`parseImpact`).
- The unused copy `noise.delete.waiting` is removed; the held-updates count now comes from the impact endpoint.

## Verification

- `tests/api/integration-impact.test.ts` (real Worker, real migrations, fake D1): the four counts for one integration and
  not another; zero for an empty one; the cap at 10,000 with `capped`, and the unsent count unaffected by it; a member can
  read; a foreign admin gets `404` with no counts by session and by `?org=`; rows of another workspace under the same
  integration id are not counted; no session is `401`; a pause keeps every delivery and held update, and a delete removes
  the held updates and keeps the delivery rows, which is what the copy says.
- `tests/security/route-capability.test.ts`, `tenant-query-scope.test.ts`, `authorization-doc.test.ts` and
  `tests/drill/tenant-isolation.test.ts` pass with the new route.
- `web/src/a11y/request-and-impact.a11y.test.tsx` (jsdom, axe): the id in monospace, copied to the clipboard, the link's
  href, the filtered request, the filter field and focus on the heading after following it; the no-id sentence; the
  request-id filter refusing an impossible value. The pause dialog's counts, focus on Cancel, Escape with no request sent,
  confirm sending one `PATCH`, a failed count that still allows pausing, resume with no dialog, the dialog from the list.
  The delete dialog's counts, Delete inert while counting even with the name typed, a failed count that allows the delete.
  English and Vietnamese, each scanned with axe.
- `web/src/integrations/impact.test.tsx`: "More than 10,000", omitted empty groups, singular forms, failed held updates
  counted for delete only, the unknown-count copy, `parseImpact` rejecting malformed answers.
- `web/src/deliveries/deliveries.test.ts`: the id parsed and an invalid one dropped; the URL filter round trip.

## Not done, and not verified

- **No browser pass.** Not seen at 320 px or desktop in a real browser, not with a screen reader, no screenshot. Contrast
  was checked by the stylesheet tests, not observed. The Vietnamese copy has not been reviewed by a native speaker.
- **Not measured on D1.** The cost of the counts on a large workspace is reasoned from the indexes, not measured; an
  `(organization_id, integration_id)` index would make them cheap and needs a migration.
- **Export before delete** (F217) does not exist for delivery history; the dialog does not offer one.
- **Disconnect-source** (F217) is still open.
- The counts are a snapshot: a delivery created between the count and the click is not in it.

## Revisit when

- A delivery-history export exists (then the delete dialog offers it first).
- Real traffic shows the counts are slow, or a migration adds the index.
- Pausing is reported as too slow in an incident (then consider an undo instead of a confirmation, as the
  notification preferences in spec 14 use).
