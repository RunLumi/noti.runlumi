# ADR 0023: Delivery ledger depth: dedup storage, attempts, bulk replay, breaker and pacing

Status: Accepted · Date: 2026-10-14 · Implements slices 1.5, 1.6 and 1.7 of
[`docs/specs/REMAINING.md`](../specs/REMAINING.md) and the feasible part of 1.8: F171, F178, F181,
F182, F183, F184, F185, F186 (server side), F187 (in part), F99 (persisted reason). Spec 12 is
authoritative; "Not done" below lists everything this slice leaves out. Builds on
[ADR 0005](0005-delivery-reliability.md), [ADR 0006](0006-destination-adapter-contract.md),
[ADR 0009](0009-delivery-log.md), [ADR 0014](0014-extended-destinations.md),
[ADR 0016](0016-noise-control.md) and [ADR 0018](0018-test-send.md).

## Context

The ledger recorded one row per delivery. A repeated provider delivery was dropped by
`INSERT OR IGNORE` without a trace, so "no silent loss" was not true for dedup. A support question
("what happened on the second try?") could not be answered from the product. A failing destination
was retried by every queued message in turn, and nothing stopped one integration from running into
its own rate limit. Replay was one delivery at a time.

## Decisions

1. **Dedup is recorded, not dropped (F171, F185).** Ingress already makes a repeat a no-op through
   the deterministic delivery id. The change is what happens next. `src/delivery/dedup.ts` appends
   three statements to the same D1 batch, directly after the statement whose `changes()` is zero
   exactly for a repeat (the outbox insert on the deliver path, the `held_events` insert on the hold
   path): a `suppressed` delivery row (reason `duplicate`, `duplicate_of` the original), the hit
   counter on `event_dedup`, and the `event_dedup` row itself on first sight. They commit with the
   event or not at all, in GitHub, generic and provider (GitLab, Stripe) ingress alike.
   - `event_dedup` is keyed `(organization_id, delivery_id)`, not by the raw event: the delivery id
     is `H(dedup key, integration)`, so it is the grain the log shows (one event routed to three
     integrations is three rows). It has a foreign key to the organization with cascade and is also
     drained by the bounded workspace purge.
   - TTL is 7 days (`DEDUP_TTL_MS`), asserted to exceed the GitHub and Stripe redelivery horizons
     (3 days each). A `dedup_purge` cron job deletes expired rows in bounded, resumable rounds.
   - The suppressed row's `dedup_key` is NULL on purpose: the generic route looks up
     `WHERE dedup_key = ?` for the first delivery of an event, and a suppressed row must never be
     found there.
   - **At most 20 suppressed rows per original** (`SUPPRESSED_ROWS_PER_ORIGINAL`). `hit_count` and
     `last_seen` keep counting past it, so a provider stuck in a retry loop cannot fill the log; the count
     is the truth, the rows are the sample.
   - **Gated on the right statement.** The suppression statements follow the outbox insert, which only runs
     when the DELIVERY insert before it changed a row. The outbox insert is an upsert, so an outbox row that
     outlived its purged delivery (an orphan) is taken over by the new delivery, still counts as a change,
     and can never make a brand-new delivery look like a repeat.
   - **A repeat of a FAILED original** is shown as such: the view carries the original's state, and the
     dialog says "the first delivery of this event failed, redeliver that one", with a link. Noti does not
     auto-create a replay: a repeat is not a request to send, and a person decides about a failed one.
   - **What the window does and does not bound.** It bounds the counter and the suppression record.
     The delivery row still blocks a repeat for the whole delivery-retention period, so a repeat
     after the TTL is recorded again with a fresh `event_dedup` row. It is never processed twice. The
     TTL is a constant; a per-connection TTL (F171) is not built.
   - **Possible duplicates (F185).** A retry that follows an attempt whose outcome we could not
     observe (timeout, dropped connection, 5xx, or a claim that expired mid-attempt) sets
     `deliveries.possible_duplicate`. The view says the destination MAY have shown the message twice;
     it never says it did, and never says it did not. A 4xx is the provider saying it did not process
     the request, so it does not set the flag.
2. **One row per attempt (F184, F181, F99).** `delivery_attempts` gets a row for each consumer
   attempt and each deferral. It is written in the SAME batch as the ledger transition and only
   when that transition changed a row (`INSERT … SELECT … WHERE changes() = 1`, directly after the
   fenced UPDATE), so a consumer that lost its claim leaves nothing and a double-consumed message
   records one attempt. Columns are closed vocabularies or numbers: outcome, the F13 code, a
   diagnostic we minted, a status CLASS (`2xx` … `timeout`, `network`, `none`), `retry_after_ms`.
   Never a status code, a body, a header or a URL. A test to a customer endpoint hides the status
   class and the detail (the same oracle concern as ADR 0018).
   - `provider_message_id` exists on both tables and is never populated: no current adapter response
     carries one. UNVERIFIED against real providers.
   - Retention deletes a delivery's attempts first and only deletes a delivery once none remain, so
     an interruption cannot strand rows. The workspace export includes attempts.
   - A claim that expires mid-attempt (the stale-claim sweep) writes an attempt row too (outcome
     `retry_scheduled` or `dead_lettered`, reason `claim_expired`) and sets `possible_duplicate`, so the log
     and the ledger agree. `possible_duplicate` is an UPPER BOUND: it marks deliveries that could have been
     shown twice, not ones that were.
   - **Waits are folded.** A wait (breaker open or paced) is recorded as one `deferred` row per run of
     identical waits: the next identical wait moves that row's end and bumps `repeat_count`, in the same
     batch. A 24 hour outage or a one-second pacing hold is one row, not hundreds (tested with 2,000 waits).
     A deferral stores the attempts already spent (0 when none), never the number of the next real attempt
     (`attempt >= 0`). The history returns the newest 50 rows (oldest first for display), so the final
     outcome is never the row cut off.
   - Retention is driven by attempt age (`delivery_attempts_age`) so the purge does not scan; a delivery is
     only purged once none of its attempts remain (checked by index).
   - `delivery_attempts` and `destination_health` carry `organization_id NOT NULL REFERENCES organization
     ON DELETE CASCADE`, like `event_dedup`, and are also drained by the bounded workspace purge. The
     cross-workspace retention statements are reviewed as such (they delete by age, not by tenant).
3. **Bulk replay is two steps (F182).** `POST /api/deliveries/replay-plan` counts the eligible
   dead-lettered deliveries for a workspace, optionally one integration and a time window, and
   returns a token. `POST /api/deliveries/replay` takes the same filter, the token and the confirmed
   count, recomputes the set and refuses (`plan_stale`, nothing written) unless it is exactly the set
   that was shown. The token is a SHA-256 over the tenant, filter and sorted ids: it proves "this is
   what you saw", it does not authorise (the `delivery.replay` capability does). Consequences:
   a double click or a retried request cannot replay twice (the second finds nothing eligible), and a
   backlog that changed since the preview cannot send more than was previewed.
   - At most 200 per request; the rest is reported as `remaining` and a second round sends it.
   - **Chain roots only.** Eligibility requires `replay_of IS NULL`: a replay that itself failed is not a
     second thing to replay, its root is, and the latest-replay clause decides whether the root is eligible.
     So "A failed, its replay R1 failed" plans one delivery and creates one new replay of A.
   - **Audit is written in two steps.** An intent row (`phase: started`, with the requested count and the
     filter) is written after the plan is verified and BEFORE the first replay: if that write fails nothing
     has been replayed and the request fails whole with 503 (retryable). The counts row (`phase: finished`)
     is written after, best effort and logged loudly: the replays are already durable and audited as
     started, so a failure must not turn them into an error the person would retry.
   - **Concurrent identical requests** both pass the plan check; `redeliver()`'s ids are deterministic in
     `(original, replay sequence)` and the sequence advances only inside the batch that inserts the row, so
     one creates each replay and the other counts it as `alreadyInFlight`. Nothing is sent twice.
   - The token is not a secret and not a security boundary: it detects that the set changed since it was
     shown. Authorisation is the capability check.
   - Each replay goes through `redeliver()`, so every single-replay guard applies (usable
     integration, original message present, deletion pending). Eligibility also excludes test
     deliveries and rows whose latest replay is in flight or delivered.
   - One audit row (`delivery.bulk_replay`) with the counts and the filter, not 200 rows; each new
     delivery carries `replay_of`. Rate limit 6 per minute per user. The dashboard asks the person to
     type the count above 20.
   - Cost: two D1 calls per created replay (the source read and the write batch), plus the plan and the
     two audit rows, so a full request is about 400 against a 1,000-per-invocation limit. UNVERIFIED on a
     real deployment.
4. **Circuit breaker and pacing share one table (F183, F187, F178).** `destination_health`, one row
   per `(workspace, integration)`, created only when something needs recording (a healthy
   destination with no rate-limit signal writes nothing).
   - **Key.** Per integration rather than per `(connection, host)`: an integration is exactly one
     stored webhook on one host, and a per-tenant key keeps one workspace's failures from ever
     affecting another's. The cost is that two integrations posting to the same provider account do
     not share a breaker or a budget.
   - **Breaker.** Closed → open after 5 consecutive `destination_unavailable` or
     `destination_timeout` failures; open for 5 minutes; then exactly one consumer wins the half-open
     probe (a conditional `UPDATE … RETURNING`, so two racing consumers cannot both probe). A probe
     that gets an answer closes it; a breaker-class failure reopens it for a full period; a probe that
     proved nothing (our own fault) releases the slot. An answer from a live endpoint (a 4xx, a rate
     limit, a revoked webhook) resets the count: the destination is reachable, and a permanent error
     dead-letters without retries anyway.
   - **A late success closes the breaker** (intended): an attempt that began before it opened and finished
     after is evidence the destination is alive.
   - **A destination that never recovers does not hold deliveries for weeks.** A delivery held back for more
     than 24 hours with no real attempt in between is dead-lettered with `destination_unavailable` and the
     reason `circuit_open_timeout` (or `destination_paced_timeout`). It spends no attempt and stays
     replayable. A real attempt in between resets the clock.
   - **While open** the consumer does not call the destination. The delivery returns to `retrying`
     with `next_attempt_at` at the end of the wait, no attempt is spent, nothing is dead-lettered, and
     the attempt log shows a `deferred` row with reason `circuit_open`. The wait goes through the
     queue's delay while retries remain and the wait fits, otherwise through the outbox park, exactly
     like any other long wait. The breaker never disables an integration.
   - **Pacing.** After any response, `x-ratelimit-remaining: 0` (with `-reset-after`, `-reset` or
     `Retry-After`) and a 429's `Retry-After` set `paused_until`. Later deliveries of that integration
     wait without a request and without spending an attempt (`destination_paced`). No provider limit
     is hard-coded (F187: parse headers). Two ceilings, on purpose: a 429's own `Retry-After` is obeyed up
     to an hour (the retry policy's ceiling, F178: a provider that says "in 30 minutes" is believed), whereas
     a bare `x-ratelimit-remaining: 0` header carries no such promise and is capped at 5 minutes.
   - **Surfaced** on the integration view (`health`) and on each waiting delivery
     (`pausedReason`), in plain words: "Paused automatically because the destination keeps failing".
     The observability summary adds counts of open, half-open and paced integrations and deferred
     attempts.
   - **Fails open.** If the health table cannot be read, the delivery proceeds and the fault is
     logged. The breaker is a safeguard, not something delivery depends on.
   - **Tests never touch it.** A test notification (`is_test`) neither reads nor changes the
     breaker, so pressing "send a test" always reaches the destination and a test is not evidence
     about real traffic.

## Migration

`0025_delivery_ledger_depth.sql`, expand only: four `ADD COLUMN`s on `deliveries` (`duplicate_of`,
`suppressed_reason`, `possible_duplicate`, `provider_message_id`) and three new tables
(`event_dedup`, `delivery_attempts`, `destination_health`). No rebuild, so no schema-diff risk to
the existing tenant triggers and indexes. **Deploy order:** apply the migration before the Worker.
**Rollback:** the previous Worker ignores the new columns and tables; it stops writing attempts and
dedup rows and stops honouring the breaker.

## Cross-tenant statements (for the tenant-query-scope allowlist)

These delete or read across workspaces on purpose (retention by age, not by tenant). The tenant-contract PR
should allowlist them with these reasons: `PURGE_EVENT_DEDUP_SQL` (`src/delivery/dedup.ts`, expiry sweep),
`PURGE_ATTEMPTS_SQL` (`src/pipeline/retention.ts`, age-driven; its `EXISTS` on `deliveries` joins on
`organization_id`), `PURGE_DESTINATION_HEALTH_SQL` (retention.ts, closed quiet rows), and the `NOT EXISTS`
on `delivery_attempts` inside `PURGE_DELIVERIES_SQL` and `PURGE_DELIVERIES_NO_CREATED_SQL` (joined on
`organization_id`). `RECORD_STALE_ATTEMPT_SQL` and the sweep selects are keyed by id and organization.

## Consequences

- Every delivery log now has rows that are not deliveries to a destination (`suppressed`). The
  state counts, the success ratio and the retention job already treat `suppressed` as terminal and
  outside the success ratio's denominator. The conservation property test now accounts for every
  ingested event as delivered, held and released, or suppressed with a reason, and checks that each
  `event_dedup.hit_count` equals the number of suppressed rows pointing at it.
- One extra D1 read per real delivery (the health row) and one to three extra statements in the
  outcome batch. Healthy destinations with no rate-limit header add no write beyond the attempt row.

## Not done

- A per-connection dedup TTL and its display; `semantic_dedup`; writing `claim_conflict` and
  `provider_idempotency` suppressions; the per-destination client-side window (F186) and the Lark
  `uuid` path (F188).
- `provider_message_id` population; a correlation id on attempts; a rendered-payload preview.
- A budget per provider account (F187), Slack API codes and cooldowns (F179), Telegram and Lark
  per-mode limits.
- An alert when a breaker opens; the Discord global breaker (F108); a dedicated redeliver queue and
  replay after the outbox message has been purged.
- No real provider has been involved: every provider response in the tests is a fixture.
