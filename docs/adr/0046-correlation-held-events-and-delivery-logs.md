# ADR 0046: Correlation for held events, delivery-path logs and the lookup by id

Status: Accepted · Date: 2026-10-15 · Completes slice 1.10 of [`docs/specs/REMAINING.md`](../specs/REMAINING.md): the remainder of F193 and the
`correlation_missing` rule of F11 (spec 13 and spec 01 are authoritative). Builds on [ADR 0024](0024-job-runner-alerting.md) (the id on the rows,
the queue message and the consumer bindings), [ADR 0016](0016-noise-control.md) (held events) and [ADR 0028](0028-ingress-contract-and-audit-read.md)
(the id in webhook error bodies). **No migration.**

## Context

ADR 0024 carried the id from ingress through the rows, the queue message and the consumers' log lines. Four things were still open:

- A held event is stored in the ingress request, before any delivery exists, and its ingress id was never stored. At release a notification gets a
  new id, but the spec's wording ("links back to the originating event") was not made true or tested, and nothing said which link existed.
- The outbox dispatcher runs from the cron as well as from the ingress kick. The cron has no request, so its lines named no id, and a failed
  `Queue.send()` was silent: the row was released and only the pass summary counted it.
- A failed noise-release batch logged the integration, not the notification it failed to create, and the unit's failure was rethrown without the
  notifications it had already released.
- F11 requires `correlation_missing` once for a message or row that arrives without an id. Nothing logged it.

The lookup by id (`GET /api/deliveries?correlationId=`) was workspace-scoped by its query, but no test named a foreign workspace on the request.

## Decision

### 1. A held event: fresh id on release, linked through the ledger's own ids

1. **The ingress id is not stored on a held event.** Storing it needs a `held_events.correlation_id` column, which is a migration. This ADR adds none. The
   tests pin the absence (`tests/noise/correlation.test.ts`), so the first column added will change a test on purpose.
2. **A released notification gets a fresh id, minted at planning time** (`mintNotification()` in `src/pipeline/noise-release.ts`), before any statement is built.
   The delivery row, the outbox row, the queue message and every log line about that notification carry the same id. A retry of a failed release mints
   a new one; the failed attempt's log line names the id it used.
3. **The link back to the originating event uses ids the ledger already has.** `held_events.id` is the originating event's deterministic delivery id.
   For a lone event the released delivery has that same id, so the event and the notification are one row. For a combined or digest notification,
   `held_events.released_in` names the notification that covered each held row. The link is a lookup in both directions, and it is not a
   correlation id: the ingress id remains unlinked.

### 2. Logs on the delivery path name the row they are about

The rule: a line about a delivery, a notification or an outbox row carries that row's correlation id. Lines that describe a whole pass
(`outbox_reconcile`, `outbox_dispatch_incomplete`, `noise_release`, `retention_purge` and the rest) describe many rows and name no id. That is deliberate.

1. **Outbox dispatch binds each row.** `dispatchRow` runs inside `withMessageCorrelation(row.correlation_id)`, so the claim, the retries, the send and the
   mark of a cron-run row name it. `SELECT_RECONCILE_CANDIDATES_SQL` returns the column (same tenant predicate).
2. **A failed send logs `outbox_send_failed`** (warn, `delivery_id`, `workspace_id`) with the row's id, before the row is released. It was silent.
3. **A failed noise-release batch logs `noise_release_failed` once per notification in it**, under that notification's id, with its `delivery_id`. The unit
   is reported as failed, the run still fails at the end, and the notifications its other batches released are counted in the report (the rethrow used to
   discard them). A failure before any notification of the unit exists (claim or plan) has no id to name and logs the integration only.
4. **`correlation_missing`** (warn, `delivery_id`, `workspace_id`, no id) is logged once per message or row without a usable id: at the consumer, the
   dead-letter consumer and the dispatcher. The message still delivers (F11: a missing id is never a reason to drop a notification). It is logged once per
   delivery attempt, so a retried legacy message logs again.

### 3. The lookup by id is tenant-scoped, and tested as such

`GET /api/deliveries?correlationId=` already filters on the resolved workspace (`organization_id = ?`). The tests now state what that means:
a member of another workspace who sends the id with no workspace named gets that member's own (empty) workspace, never this one's rows; a non-member who
names the workspace in the query (`?org=`) gets `404` with no row and no echo of the id (`resolveWorkspace` already answers a non-member with `404`,
so an existence probe learns nothing). No code change was needed for this.

## Consequences

- **Failure logs grow with the failure.** A failed batch logs once per notification it held (at most 15 per batch). A failed send logs one line per row.
  Nothing is logged on the healthy path beyond what it logged before.
- **Cron-run rows are traceable** from the claim to the mark, and a legacy row (written before 0027) produces one `correlation_missing` line, not silence.
- **No wire, schema or dedup change.** The queue message has the same fields, released ids are minted where they were already minted, and the
  dedup keys are unchanged.
- **Budget accounting for a failed unit changes**: the unit consumes the planned notifications, not one unit. The run still fails at the end.

## Not done, and not verified

- **The ingress id on held events.** Needs `held_events.correlation_id` (a migration with a rollback plan, not written here). Until then a customer
  who quotes the `x-request-id` of a held event finds nothing in the delivery list, and the notification that later releases it has a new id.
- Analytics Engine blobs, the support evidence bundle (F202) and a correlation row in the dashboard's detail dialog: still open (REMAINING 1.10).
- Verified only over the fake D1 and the Worker's handlers, with `console` captured. Not exercised on a deployed Worker, in Workers Logs, or
  against a real queue; the 256 KB per-request log budget (F194) is not measured here.
- The pass-level summaries carry no id by design. If a support question needs a per-row cron trail beyond the lines above, it needs per-row lines,
  not a larger summary.

## Revisit when

- Support needs to find a held event by the id its request returned (then add the column, with a migration and a rollback plan).
- Analytics Engine (F191) or the support bundle (F202) is built, since both read these ids.
- Workers Logs show the failure lines are too noisy at the real failure rate (the per-notification lines are the first to trim).
