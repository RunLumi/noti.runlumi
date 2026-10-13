# 12 — Delivery Reliability

> The central engineering claim of the product: **a notification you were told was accepted
> is not silently lost, and a duplicate is never hidden from you.**
>
> External references read 2026-10-13. See `README.md#sources`.

## The contract, stated plainly

Cloudflare's own words, which we adopt verbatim:

> "Queues provides **at least once** delivery by default… messages are guaranteed to be
> delivered at least once, and **in rare occasions, may be delivered more than once**… as
> **exactly once delivery incurs additional overheads in any messaging system**."
> — [queues/reference/delivery-guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)

**"Exactly once" must not appear in our code, our tests, our docs or our marketing.** Not as
an aspiration, not as a TODO.

### Why it is impossible here, concretely

The consumer's acknowledgement and its side effect are two separate system transitions with an
irreducible crash window between them:

1. Consumer POSTs to Slack.
2. Consumer acks the message.

If the process dies between (1) and (2), the message is redelivered and (1) happens again.
There is **no way to ask Slack whether it already received it** — Slack has no documented
dedup key on `chat.postMessage` (F103). Making a remote effect and a local ack atomic requires
remote support that does not exist.

The only destination with true server-side idempotency is **Lark's app API**, which accepts a
`uuid` and collapses duplicates within a 1-hour window (F188). Everything else is on us.

---

## F169 — Durable acceptance before acknowledgement

**Priority** P0 · **Status** partial · **Fixes** part of D4

**Story** As a customer, I want every event I was told was accepted to actually be stored, so
that an `AGENTS.md`-compliant "acknowledge only after durable acceptance" is real.

**Acceptance**
- [ ] Ingress performs: verify → resolve tenant → dedup claim → **one `db.batch()`** → `202`.
- [ ] That batch is a real transaction: *"Batched statements are SQL transactions. If a
      statement in the sequence fails… it aborts or rolls back the entire sequence."*
- [ ] Acknowledgement is sent **after** the batch resolves, never before, never in parallel.
- [ ] Nothing in the handler can lose an event: no `waitUntil` fire-and-forget writes, no
      queue send that is not awaited.
- [ ] ⚠️ **`waitUntil()` must never wrap a queue `send()`.** Cloudflare: *"because
      `waitUntil()` is non-blocking, any errors raised from the `send()` or `sendBatch()`
      methods on a queue will be **implicitly ignored**."* Silent event loss.
- [ ] If the batch fails, return `5xx`. This costs nothing on GitHub — there is no retry — so
      the request must be recoverable via F69 instead.

**Design** — The current code already batches correctly
(`src/index.ts:47`), which is the one genuinely good piece of the outbox. What is missing is
the *ordering* guarantee: nothing asserts that the response follows the commit.

**Errors** — a failed batch is `internal_error` with a `correlation_id` for the customer to
quote. Never silently `202`.

**Security** — n/a.

**Tests**
- `ack_is_never_sent_before_the_batch_commits`
- `batch_failure_rolls_back_every_statement`
- `no_queue_send_is_wrapped_in_waituntil`
- `waituntil_queue_send_is_rejected_by_a_lint_rule`

**Deps** — F09, F64.

---

## F170 — Deduplication key derivation

**Priority** P0 · **Status** partial

**Story** As a customer, I want GitHub's redelivery button to not spam my team, so that I can
use it for debugging.

**Acceptance**
- [ ] Dedup on **`(source, id)`**, per the normative CloudEvents rule: *"Consumers MAY assume
      that Events with identical `source` and `id` are duplicates."*
- [ ] Concrete derivation, with **unambiguous component boundaries**:

```
dedup_key = SHA-256( 0x00 ‖ orgid ‖ 0x00 ‖ connectionid ‖ 0x00 ‖ source ‖ 0x00 ‖ id )
```

- [ ] `0x00` separators, **never `.`** — the Standard Webhooks spec warns that attacker-
      controlled components must not be allowed to contain the separator.
- [ ] `orgid` and `connectionid` are included because they are **mandatory for tenant safety**:
      without them, two customers who both use GitHub and both receive delivery GUIDs would
      collide, and one customer's notification would be silently suppressed. This is tested.
- [ ] The **full 256-bit digest** is stored. A truncated prefix collision must never be
      treated as a duplicate — that is silent data loss.
- [ ] ⚠️ **Signature and timestamp are never part of identity.** Stripe: *"Stripe generates the
      timestamp and signature each time we send an event… we generate a new signature and
      timestamp for the new delivery attempt."*

**Schema**
```sql
-- F170
CREATE TABLE event_dedup (
  orgid        TEXT NOT NULL,
  dedup_key    BLOB NOT NULL,          -- full SHA-256, never truncated
  connectionid TEXT NOT NULL,
  source       TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  hit_count     INTEGER NOT NULL DEFAULT 1,
  outcome       TEXT NOT NULL,         -- accepted | suppressed | failed | dlq
  PRIMARY KEY (orgid, dedup_key)
);
```

**Errors** — none; the key is derived deterministically or it is a bug.

**Security** — the key is a hash, so it is not a capability. But a collision across tenants
would be a **data leak**, hence `orgid` in the derivation and in the primary key.

**Tests**
- `identical_delivery_produces_exactly_one_outbound_message`
- `dedup_key_is_injective_across_component_boundaries`
- `same_event_in_two_workspaces_produces_two_deliveries`
- `truncated_hash_collision_is_not_treated_as_duplicate`
- `signature_and_timestamp_never_affect_the_key`

**Deps** — F47, F171.

---

## F171 — Deduplication storage and TTL

**Priority** P0 · **Status** not started

**Story** As an operator, I want duplicate suppression to be bounded and self-cleaning, so
that the dedup table does not grow without limit.

**Acceptance**
- [ ] Two dedup tables with **independent TTLs**, because they answer different questions:

| Table | Key | TTL | Basis |
| --- | --- | --- | --- |
| `event_dedup` | transport identity | **7 days** | Must exceed max retry horizon + redelivery window. GitHub redelivery window is **3 days**; Stripe retries up to **3 days**. |
| `semantic_dedup` | `data.object.id + type` | 7 days | Stripe: *"two separate Event objects are generated and sent"* for one underlying change |

- [ ] ⚠️ The hard constraint is `dedup TTL > (max retry horizon + provider redelivery
      window)`. With a 7-day TTL against GitHub's 3-day window and Stripe's 3-day retry
      horizon, we have margin. **If either provider extends its horizon, the TTL must move.**
      This relationship is asserted in a test, not just documented.
- [ ] Purge is a scheduled job, chunked, resumable.
- [ ] TTL is configurable per connection, and the UI shows it.
- [ ] A duplicate increments `hit_count` and updates `last_seen_at` — duplicate volume is a
      useful signal about provider behaviour, and it is free.

**Errors** — a purge failure retries; partial purges are resumable and not reported complete.

**Security** — the dedup table is small (ids and hashes) and contains no payload.

**Tests**
- `post_ttl_redelivery_is_processed_again`
- `dedup_ttl_exceeds_provider_redelivery_horizon`
- `semantic_and_transport_dedup_have_independent_ttls`
- `purge_resumes_after_interruption`

**Deps** — F170, F192.

---

## F172 — Atomic outbox claim

**Priority** P0 · **Status** not started · **Fixes** the core of D4

**Story** As an operator, I want an outbox row dispatched exactly once, so that a cron tick
and a `waitUntil` kick cannot both enqueue the same event.

**Acceptance**
- [ ] Dispatch requires an **atomic claim**, not a read-then-write:

```sql
UPDATE outbox SET state='claimed', claimed_at=? 
WHERE id = ? AND state='pending'      -- changes === 0 means someone else won
```

- [ ] Only the caller that observed `changes === 1` may call `queue.send()`.
- [ ] This closes the **specific** bug in `src/index.ts:88`, where `Queue.send()` precedes
      the state update with no claim step at all.
- [ ] It also closes the current double-dispatcher: `waitUntil(dispatchOutbox)` at
      `src/index.ts:53` **and** the every-minute cron can both select the same pending rows,
      because `SELECT … WHERE state='pending'` has no exclusive lock.
- [ ] A claimed row that is never dispatched is reclaimed by the reconciler after a timeout.

**Design** — This is the single highest-value reliability change in the codebase. D1 is
single-threaded, so a conditional `UPDATE` is genuinely atomic here — no `SELECT … FOR UPDATE`
is needed or available.

**Errors** — `changes === 0` is a **normal, expected** outcome, not an error. Two dispatchers
racing is the design working.

**Security** — n/a.

**Tests**
- `two_concurrent_dispatchers_claim_each_row_exactly_once`
- `claim_is_atomic_under_contention`
- `crashed_claim_is_reclaimed_after_timeout`
- `waituntil_and_cron_never_double_dispatch`

**Deps** — F09, F172.

---

## F173 — Outbox pump

**Priority** P0 · **Status** partial

**Acceptance**
- [ ] `queue.send()` is **awaited**, never `waitUntil`-wrapped (F169).
- [ ] On success: `state='dispatched'`, `dispatched_at=now`.
- [ ] On failure: `state='pending'`, `last_error` recorded, retried by the reconciler.
- [ ] Queue messages carry **identifiers only** — `delivery_id`, `orgid`, `dedup_key`. Never a
      secret (D5: today `type Delivery` embeds `ciphertext` in the queue body), never a full
      payload.
- [ ] Message size is ≤4 KB by construction against a 128 KB platform limit.
- [ ] **Alert on a stuck outbox**: any row `state='pending'` older than 5 minutes raises
      `outbox_stalled`. A notification product that silently drops is worse than one that is
      noisy.

**Design** — Queue messages are plaintext in Cloudflare infrastructure. Carrying destination
ciphertext there replicates secret material into a system we inspect less carefully than D1,
and breaks in-flight messages on key rotation. Carrying the full payload invites drift between
the queued copy and the stored event. Ids only.

**Errors** — a `Too Many Requests` (5,000 msg/s per queue) or `Storage Limit Exceeded` (25 GB
backlog) is a transient pump failure; record and retry.

**Security** — this is the D5 fix. The queue body must be safe to log verbatim.

**Tests**
- `outbox_message_contains_no_secret_fields`
- `outbox_message_body_is_under_the_size_budget`
- `stalled_outbox_raises_an_alert`
- `send_failure_leaves_the_row_pending_for_retry`

**Deps** — F07, F172, F174.

---

## F174 — Outbox reconciler

**Priority** P0 · **Status** partial

**Story** As an operator, I want a scheduled sweeper, so that an event which reached the outbox
is eventually dispatched even if every prompt path failed.

**Acceptance**
- [ ] Scheduled job re-dispatches rows that are `pending` past a threshold, or `claimed` past
      a claim timeout.
- [ ] Runs every minute (cron minimum is 1 minute and the documented per-cron CPU allowance
      is ~30 s for sub-hourly intervals, so the job must be chunked and bounded).
- [ ] ⚠️ Cloudflare's docs disagree on whether cron CPU is 30 s or 15 min; we build to the
      conservative reading and keep the job cheap.
- [ ] The reconciler is **idempotent** and safe to run concurrently with the prompt path,
      because F172 makes claiming atomic.
- [ ] It is the documented **recovery mechanism**, not a redundant second path — stated that
      way in `docs/IMPLEMENTATION.md`.

**Design** — Two-tier dispatch (prompt `waitUntil` kick + scheduled reconciliation) is the
right shape and already present. It only needed the atomic claim (F172) to be correct. The
failure mode is now: crash-after-enqueue-before-mark (F172 handles) and pump-down
(this handles).

**Errors** — a reconciler that fails is itself alerted on.

**Security** — n/a.

**Tests**
- `reconciler_recovers_a_pending_row`
- `reconciler_reclaims_a_stuck_claim`
- `reconciler_is_safe_to_run_concurrently_with_the_pump`

**Deps** — F172, F192.

---

## F175 — Idempotent consumer

**Priority** P0 · **Status** not started

**Story** As a customer, I want a duplicate queue message to not become a duplicate
notification, so that a crash never costs me a spam wave.

**Acceptance**
- [ ] The consumer claims the delivery before acting, in one batch:

```sql
INSERT INTO delivery_claims (delivery_id, orgid, dedup_key, claimed_at)
VALUES (?,?,?,?) ON CONFLICT (delivery_id) DO NOTHING
```

- [ ] `changes === 0` → `msg.ack()` immediately and drop.
- [ ] Otherwise: render → send → record → ack.
- [ ] This is Cloudflare's own prescribed mitigation: *"generating a unique ID when writing the
      message to the queue and using that as the primary key on database inserts and/or as an
      idempotency key to de-duplicate the message after processing."*
- [ ] The claim is **released** on a retryable failure so the retry can claim it again;
      a permanently-failed delivery keeps its claim so it is never re-sent.

**Design** — This is what turns the unavoidable crash window (enqueue-then-crash, F172) from
a double notification into a **no-op**. At-least-once from the queue is fine; at-least-once
plus an unguarded consumer is not.

**Errors** — n/a; `changes === 0` is the success path for a duplicate.

**Security** — the claim row is keyed by `orgid` + `delivery_id`; cross-tenant claim
collision is a leak and is tested.

**Tests**
- `crash_between_send_and_dispatch_update_produces_one_message`
- `duplicate_queue_message_is_dropped_at_the_claim`
- `released_claim_can_be_retried`
- `permanently_failed_delivery_is_never_reclaimed`

**Deps** — F172, F175.

---

## F176 — Per-message acknowledgement

**Priority** P0 · **Status** not started · **Fixes** part of D8

**Story** As a customer, I want one bad message not to re-send nine good ones, so that a
single poison event does not multiply into spam.

**Acceptance**
- [ ] `msg.ack()` per message, **immediately after that message's own commit**. Never
      `ackAll()` at the end of the batch.
- [ ] ⚠️ Queues batch retry is **all-or-nothing by default**: *"if a batch of 10 messages is
      delivered, but the 8th message fails to be delivered, all 10 messages will be retried
      and thus redelivered to your consumer in full."* One poison message ⇒ 10 duplicate
      notifications per attempt, per user.
- [ ] `msg.retry({ delaySeconds })` per message, so a retryable failure does not redeliver the
      batch.
- [ ] Precedence is first-call-wins; we never rely on ordering between `ack()` and `ackAll()`.
- [ ] ⚠️ `max_batch_size` for the **delivery** queue is kept small (1–5). With whole-batch
      retry, one poison message in a batch of 100 causes 100 redeliveries. Batching buys D1
      round trips, not downstream batching — none of these destinations accept multi-message
      requests.

**Design** — This is the highest-value single line in the consumer. Cloudflare documents that
`retry()`/`retryAll()` do **not** count as failed invocations for autoscalling, so a poison
message will not melt the concurrency budget either.

**Errors** — per-message retry with an explicit delay; never a batch-level throw.

**Security** — n/a.

**Tests**
- `one_failure_in_a_batch_retries_only_that_message`
- `ack_happens_after_the_messages_own_commit`
- `delivery_queue_batch_size_is_small`

**Deps** — F08, F175.

---

## F177 — Retry policy: two-tier backoff

**Priority** P0 · **Status** not started · **Fixes** part of D4/D11

**Story** As an operator, I want a transient outage ridden out and a chronic one given up on
predictably, so that retries neither hammer a recovering destination nor give up too early.

**Acceptance**
- [ ] **Tier 1 — transient (attempts 1–6, ≤24 min).** Full Jitter exponential:
      `delay = random(0, min(cap, base · 2^attempt))`, `base=2s`, `cap=900s`.
- [ ] **Tier 2 — chronic (attempts 7–13, out to ~7 days).** Fixed ladder:
      `+2h, +6h, +12h, +24h, +48h, +72h, +96h`.
- [ ] Total: **13 attempts over ~7 days.** Bounds are per-connection configurable.
- [ ] Full Jitter is not decoration. AWS: *"The no-jitter exponential backoff approach is the
      clear loser. It not only takes more work, but also takes more time"* — and *"none of
      these approaches fundamentally change the N² nature of the work to be done, but do
      substantially reduce work at reasonable levels of contention."*
- [ ] Every retry path calls the jitter function. A lint/test asserts it.

**Design** — Why two tiers rather than pure exponential: a pure 8-attempt exponential with
`cap=3600` spans only ~1.5 hours, far short of Stripe's **3-day** retry horizon and Svix's
~30.5 hours. Why Full Jitter rather than the other variants: the AWS blog's own verdict is that
Equal Jitter *"is the loser"* and the Full/Decorrelated choice *"is less clear"*, so we take
the simplest of the two.

**Errors** — the backoff function is pure and injectable, so it is unit-testable with a seeded
RNG.

**Security** — n/a.

**Tests**
- `backoff_is_within_cap_and_uses_full_jitter`
- `backoff_distribution_is_uniform_over_many_samples`
- `tier_two_schedule_spans_about_seven_days`
- `every_retry_path_applies_jitter`

**Deps** — F08.

---

## F178 — `Retry-After` handling

**Priority** P0 · **Status** not started

**Story** As an operator, I want a rate-limited destination to tell us when to come back, so
that we stop making a throttle worse.

**Acceptance**
- [ ] Parse both RFC 9110 forms: `delay-seconds` and `HTTP-date`.
- [ ] Clamp to `[1s, cap]`. Absurd values (`86400`) must not exceed the attempt budget.
- [ ] ⚠️ **A server-supplied `Retry-After` overrides our computed backoff.** CloudEvents'
      webhook profile: the sender *"MUST observe the value of the Retry-After header and
      refrain from sending further requests until the indicated time."*
- [ ] ⚠️ **Not every provider signals throttling with 429.** Lark legacy OpenAPIs return
      **HTTP 400** for the same condition; classification uses `x-ogw-ratelimit-*` and
      `code: 99991400`. Discord puts the value in the 429 **body** (`retry_after`), not just
      the header. Parse body, headers and provider-specific fields.
- [ ] `x-ratelimit-remaining: 0` is treated as a throttle signal even on a 200.
- [ ] Slack's cooldown is **per-method-per-workspace**, not global.

**Design** — Emitting `RateLimit` / `RateLimit-Policy` on our own responses is optional and
best-effort: the defining draft is still an unratified Active Internet-Draft. Do not present
it as standardized.

**Errors** — a malformed `Retry-After` falls back to computed backoff and raises a metric.

**Security** — n/a.

**Tests**
- `retry_after_parses_both_rfc9110_forms`
- `retry_after_overrides_computed_backoff`
- `retry_after_is_clamped_to_a_sane_window`
- `lark_400_throttle_is_detected_by_code`
- `discord_body_retry_after_is_honoured`

**Deps** — F177, F99.

---

## F179 — Error classification

**Priority** P0 · **Status** not started · **Fixes** D11 · **Extends** F13

**Story** As an operator, I want permanent failures to stop burning retries, so that a
revoked webhook does not cost me 13 attempts.

**Acceptance** — per destination, mapped onto the F13 taxonomy:

| Destination | Permanent (dead-letter) | Transient (retry) |
|---|---|---|
| Slack webhook | `400 invalid_payload`, `403 action_prohibited`, `404 no_service`, `channel_is_archived`, `no_active_hooks`, `no_text` | `429` |
| Slack API | `channel_not_found`, `is_archived`, `no_permission`, `missing_scope`, `invalid_blocks`, `token_revoked`, `token_expired`, `team_disabled` | `ratelimited`, `internal_error`, `fatal_error`, `service_unavailable`, `request_timeout` |
| Discord | **`404` — immediately.** Retrying a deleted webhook *"will result in a temporary restriction"* | `429` (body `retry_after`) |
| Lark | `19021` (sign/timestamp), `19022` (IP), `19024` (keyword), `230028` (DLP), `230025` (too long), `230011`/`230110` (recalled/deleted) | `11232`, `230020`, `99991400`, `9499` |
| Teams | trigger disabled, `Request Entity too large` | 5xx, auth-mode mismatch |

- [ ] ⚠️ **`410 Gone` disables the destination** and stops routing to it — the provider has
      said it is no longer interested.
- [ ] `message_limit_exceeded` (Slack) is a **workspace plan** limit, not our bug; the user
      message says so.
- [ ] Every unmapped error raises a metric. The mapping is expected to be incomplete and that
      should be visible, not assumed.
- [ ] ⭐ **Discord 404 is special and dangerous.** *"If a webhook returns a 404 status you
      should not attempt to use it again — repeated attempts to do so will result in a
      temporary restriction"* — and any 401/403/429 counts toward a 10,000-per-10-minutes
      invalid-request limit, the penalty for which is an **IP ban from the entire Discord
      API**. Retrying one dead webhook takes out every other Discord delivery for 10 minutes.
      This must be a hard test.

**Design** — Discord is the clearest argument for a per-destination circuit breaker rather
than a generic retry policy: the failure mode of retrying the wrong thing is an *external*
punitive action against a shared IP.

**Errors** — see the table.

**Security** — classification detail is redacted (F12) before storage or display.

**Tests** — table-driven over every code in the matrix; plus
`discord_404_is_terminal_and_never_retried`.

**Deps** — F13, F99.

---

## F180 — Dead-letter queue

**Priority** P0 · **Status** not started · **Fixes** part of D11

**Story** As an operator, I want exhausted deliveries to land somewhere I can see, so that
they are never silently dropped.

**Acceptance**
- [ ] `noti-dead-letter` configured as the delivery queue's DLQ, `max_retries: 8`.
- [ ] ⚠️ **Without a DLQ configured, messages that reach the retry limit are deleted
      permanently.** Today `wrangler.jsonc` does configure one — but nothing consumes it.
- [ ] ⚠️ ⭐ **A DLQ with no active consumer silently evaporates after four days.** *"Messages
      delivered to a DLQ without an active consumer will persist for four (4) days before
      being deleted."* A DLQ consumer must exist from day one, and a health check must assert
      it is attached.
- [ ] ⚠️ Retention is **14 days on Workers Paid, a hard 24 hours on Free.** A 14-day DLQ
      therefore requires Paid ($5/mo minimum). Until we are on Paid, this must be stated in
      customer-facing documentation rather than assumed.
- [ ] Every dead-lettered delivery has a **terminal** status with the taxonomy code and the
      full attempt log. It is never left as `retrying` — the current behaviour
      (`src/index.ts:75`) and an explicit requirement in `docs/RELEASE_GATES.md`.

**Design** — The distinction between "retrying" and "dead-lettered" is the difference between
"we are working on it" and "we gave up and here is why". Collapsing them into one state is
how a notification product becomes untrustworthy.

**Errors** — n/a; the DLQ is the error state.

**Security** — DLQ messages carry ids, not secrets (F173).

**Tests**
- `exhausted_delivery_reaches_a_terminal_dead_letter_state`
- `dlq_consumer_presence_is_asserted_by_a_health_check`
- `dead_lettered_delivery_has_a_full_attempt_log`

**Deps** — F08, F179, F213.

---

## F181 — Dead-letter inspection

**Priority** P0 · **Status** not started

**Story** As a support engineer, I want to see why a notification failed, so that I can tell a
customer something better than "it didn't work".

**Acceptance**
- [ ] Filterable by workspace, destination, event type, error code and time.
- [ ] Each entry shows: the rendered payload (**credential-redacted**), the attempt history
      with timestamps and per-attempt taxonomy codes, the provider status, and the
      correlation id.
- [ ] Grouped view: "this destination has failed 412 times in the last hour with
      `destination_revoked`" is more useful than 412 rows.
- [ ] Empty states name the cause: "No dead letters. 0 retries exhausted in the last 30 days."
- [ ] Customers can see their own dead letters. They are a product-quality signal, and hiding
      them makes the delivery log lie.

**Design** — This is the screen that converts "reliability" from a claim into something the
customer can verify. `AGENTS.md` asks for "dead-letter inspection and manual redelivery";
this is the first half.

**Errors** — n/a.

**Security** — ⚠️ the rendered payload may embed a destination webhook URL. It must be
redacted exactly as F98 does for the test preview.

**Tests** — `dead_letter_view_redacts_credentials`; `dead_letters_are_tenant_scoped`.

**Deps** — F180, F24.

---

## F182 — Manual replay

**Priority** P0 · **Status** not started

**Story** As a customer, I want to retry a failed notification myself, so that I do not have
to wait for you to notice.

**Acceptance**
- [ ] Replay one dead letter, or all for a destination since a date (Svix calls these
      "Recover Failed" and "Replay Missing").
- [ ] Replay enqueues to `noti-redeliver` with a **fresh attempt counter** and a
      `replayed_from` pointer, so the history shows both attempts.
- [ ] ⚠️ **Replay does not bypass the dedup window** for a *new* event; it replays a
      *specific failed delivery*, which is a different operation. Replaying a delivery that
      already succeeded is not offered.
- [ ] Requires `replay` capability (F204) — not available to every member.
- [ ] Every replay is audited.
- [ ] A replay of a delivery whose destination was since fixed is the primary happy path.

**Design** — `AGENTS.md`: "dead-letter inspection and manual redelivery." Both halves.

**Errors** — replaying an already-terminal delivery is refused with an explanation.

**Security** — replay can re-send content a customer has since retracted. Requires an
explicit capability, not just membership.

**Tests**
- `replay_resets_attempts_and_preserves_history`
- `replay_requires_the_replay_capability`
- `replay_is_audited`
- `replay_of_a_successful_delivery_is_refused`

**Deps** — F180, F204.

---

## F183 — Circuit breaker

**Priority** P1 · **Status** not started

**Story** As an operator, I want a broken destination to stop being hammered, so that a bad
webhook cannot trigger punitive limits against our shared IP.

**Acceptance**
- [ ] Per `(connectionid, destination_host)`: closed → open → half-open.
- [ ] Opens after **5 consecutive terminal failures**; open for 5 minutes; half-open probes
      with one request.
- [ ] While open, fail **fast into the retry queue** — do not hold a Worker invocation open.
      Consumer wall time is capped at 15 minutes and CPU at 30 s default.
- [ ] Opening the breaker **surfaces to the user** — it is never a silent optimisation.
- [ ] ⚠️ Never auto-disable a destination. Svix disables endpoints after 5 days of failure and
      notifies via webhook; for a notification product, *silently stopping someone's alerts is
      worse than noise*. We surface and let the user decide.
- [ ] Discord's 10,000-per-10-minutes invalid-request penalty is the canonical case this
      feature exists to prevent (F179).

**Design** — Marked as engineering judgment: no provider doc above specifies a circuit
breaker. It is justified by Discord's documented IP-ban behaviour and by the fact that
holding Worker invocations open costs real money.

**Errors** — breaker state is transient and rebuildable; a cold start begins closed.

**Security** — n/a.

**Tests**
- `breaker_opens_after_five_consecutive_terminal_failures`
- `breaker_fails_fast_without_retaining_the_invocation`
- `breaker_state_change_is_surfaced_to_the_user`
- `breaker_never_auto_disables_a_destination`

**Deps** — F179, F190.

---

## F184 — Delivery ledger

**Priority** P0 · **Status** partial

**Story** As a support engineer, I want one row per notification attempt, so that a customer
question can be answered from data rather than guesswork.

**Acceptance**
- [ ] `deliveries(id, orgid, integrationid, dedup_key, event_id, destinationid,
      state, attempts, first_attempt_at, last_attempt_at, next_attempt_at, error_code,
      error_detail_redacted, provider_message_id, provider_ts, replay_of, test)`
- [ ] `delivery_attempts(id, deliveryid, attempt, started_at, finished_at, http_status,
      provider_code, taxonomy_code, latency_ms, retry_after)` — one row per try, retained
      with the delivery.
- [ ] `state` ∈ `pending | claimed | sent | failed | dead_lettered | suppressed`.
- [ ] The composite identity is `(dedup_key, destinationid)`, **not** a hand-built string.
      Today's `x-github-delivery + ':' + integration_id` (D10) collides when two rows target
      the same destination and event type, and the second is silently dropped by
      `INSERT OR IGNORE` with no signal.
- [ ] `provider_message_id` is captured wherever the provider returns one — it is the only
      route to `canUpdate` and to client-side dedup.

**Design** — The ledger is the product. A delivery log a customer can read is what makes
at-least-once acceptable to them; a black box does not.

**Errors** — `error_detail` is redacted through F12 **before** storage, never on the way out.

**Security** — no secrets, no payloads beyond a redacted render preview, tenant-scoped on
every query (F24).

**Tests**
- `two_deliveries_to_the_same_destination_do_not_collide`
- `ledger_records_every_attempt`
- `ledger_is_tenant_scoped_on_every_query`

**Deps** — F24, F184.

---

## F185 — Honest duplicate surface

**Priority** P0 · **Status** not started

**Story** As a customer, I want to be told when a duplicate was possible, so that I can judge
the reliability of my channel myself.

**Acceptance**
- [ ] The delivery detail states the delivery model in plain language: *"Noti delivers at
      least once. A notification may occasionally be delivered more than once."*
- [ ] Where a duplicate was **detected and suppressed** (dedup hit, claim conflict, provider
      idempotency), the delivery is marked `suppressed` with the reason — not silently
      dropped.
- [ ] Where a duplicate was **possible but not detectable**, the UI says so rather than
      implying exactly-once.
- [ ] Customer-facing docs carry the same statement. No marketing page claims exactly-once.
- [ ] Slack's `internal_error` / `fatal_error` warning — *"It's possible some aspect of the
      operation succeeded before the error was raised"* — is surfaced as a possible duplicate.

**Design** — `AGENTS.md`: "expose possible duplicates and dedupe where feasible." The
difference between a product that hides duplicates and one that surfaces them is the
difference between trust and blame.

**Errors** — n/a.

**Security** — n/a.

**Tests**
- `delivery_detail_discloses_the_at_least_once_model`
- `suppressed_duplicate_records_its_reason`
- `no_user_facing_text_claims_exactly_once`
- `slack_internal_error_is_flagged_as_a_possible_duplicate`

**Deps** — F184, F213.

---

## F186 — Client-side deduplication window

**Priority** P0 · **Status** not started

**Story** As a customer, I want a retry storm not to become a message flood, so that a
recovering destination is not buried.

**Acceptance**
- [ ] Because **only Lark's app API has server-side idempotency**, every other destination
      needs a client-side window: `dedup_key + destinationid` suppressed within N minutes.
- [ ] N is per-destination and defaults to the provider's realistic retry window (5 min for
      Slack/Discord/Telegram; 1 h for Lark, matching its own window).
- [ ] Suppression is recorded, not silent (F185).
- [ ] The window is **never longer than the retry horizon**, or a genuinely new event that
      collides would be suppressed. It must be shorter than the provider's dedup semantics
      where those exist.

**Design** — This cannot make delivery exactly-once. It narrows the window in which a crash
between send and ack produces a visible duplicate, and it is honest about being a mitigation
rather than a guarantee.

**Errors** — n/a.

**Security** — n/a.

**Tests**
- `retry_storm_within_the_window_produces_one_message`
- `a_genuinely_new_event_outside_the_window_is_not_suppressed`
- `lark_app_uses_server_side_uuid_instead`

**Deps** — F170, F188.

---

## F187 — Outbound rate limiting per destination

**Priority** P0 · **Status** not started

**Story** As an operator, I want to stay inside each destination's real limit, so that we
are never the reason a customer's other integrations fail.

**Acceptance**
- [ ] Limits are enforced **per provider account/app**, not per connection. Slack's cooldown
      is *"per-method-per-workspace"*; Lark's 100/min is *"single tenant, single bot"*.
      Per-connection keys would let a customer's ten integrations collectively exceed the cap.

| Destination | Limit |
| --- | --- |
| Lark custom bot | **100/min, 5/sec** |
| Lark app | 1000/min, 50/sec; 5 QPS per target |
| Slack | ~1 msg/s per channel; Tier 3 = 50+/min for `chat.update` |
| Discord | **50 req/s global**; per-route — parse headers, do not hardcode |
| Telegram | **20 msg/min per group** (the binding constraint, not the 1 msg/s chat cap) |
| Teams | ⚠️ **Power Automate throttling numbers not verified** — do not hardcode |

- [ ] ⚠️ Discord's own guidance: *"rate limits should not be hard coded into your app.
      Instead, your app should parse response headers."* We parse `X-RateLimit-*` and the 429
      body, and treat any hardcoded number as a coarse pre-filter only.
- [ ] The Workers Rate Limiting binding is **per-Cloudflare-location** and *"not an accurate
      accounting system"* — acceptable as a coarse guard, **not** as the enforcement mechanism.
      Anything needing a globally consistent counter uses D1 or a Durable Object.
- [ ] Our token bucket consumes 1 per outbound POST and sets the message delay on exhaustion
      rather than blocking.

**Design** — Shaping via a delay on the queue message, not by sleeping inside the consumer,
is what keeps this compatible with the 30 s CPU / 15 min wall-clock limits.

**Errors** — bucket exhaustion is a normal `destination_rate_limited`, not an error condition.

**Security** — n/a.

**Tests**
- `rate_limit_is_enforced_per_provider_account`
- `discord_headers_are_parsed_rather_than_hardcoded`
- `telegram_group_cap_of_20_per_minute_is_respected`
- `lark_custom_bot_and_app_limits_are_separate_buckets`

**Deps** — F08, F187.

---

## F188 — Provider-native idempotency

**Priority** P1 · **Status** not started

**Story** As a customer, I want the one destination that can guarantee no duplicates to
actually use it, so that CI status cards are reliable.

**Acceptance**
- [ ] Lark app mode sends a `uuid` on every `im/v1/messages` call, derived from the delivery
      id and **≤50 characters** (Lark's documented maximum).
- [ ] The same `uuid` is reused across retries, which is the point: *"requests with the same
      `uuid` will send at most one message within one hour."*
- [ ] This is the **only** destination among the six with server-side idempotency, and the
      UI should say so — it is a genuine differentiator.
- [ ] Slack, Discord, Telegram, Teams and Lark custom-bot have **no** server-side
      idempotency. This is documented, not assumed.

**Design** — Relying on provider idempotency for Lark app mode lets us offer a stronger
guarantee than competitors who bolt Slack webhooks together, and it costs one field.

**Errors** — a Lark `uuid` collision from a bug would suppress a real message. Derive from
the delivery id so that cannot happen.

**Security** — n/a.

**Tests**
- `lark_uuid_is_derived_from_delivery_id_and_under_50_chars`
- `lark_uuid_is_stable_across_retries`
- `no_other_destination_claims_server_side_idempotency`

**Deps** — F186.

---

## F189 — Outbound request budget

**Priority** P0 · **Status** not started

**Story** As an operator, I want outbound calls bounded, so that a slow destination cannot
exhaust a Worker invocation.

**Acceptance**
- [ ] Explicit per-attempt timeout via `AbortSignal.timeout()`, well under the 15-minute
      consumer wall clock.
- [ ] ⚠️ **6 simultaneous open connections** per invocation
      ([workers/platform/limits](https://developers.cloudflare.com/workers/platform/limits/)).
      A `Promise.all` over 50 destinations queues. Fan out **across invocations**, never
      within one.
- [ ] `redirect: "manual"` on every outbound call. Stripe: *"We consider redirect responses
      to webhook requests as **failures**."* Following a redirect is also an SSRF bypass.
- [ ] Response bodies are size-capped before parsing. A hostile "provider" is not possible
      for allowlisted hosts, but a large error page should not blow the 128 MB isolate.
- [ ] Provider response parsing is strict: unknown shapes raise a metric, never a silent
      success.

**Design** — The invariant is *never follow a redirect*. *Amended 2026-10-13 ([ADR 0006](../adr/0006-destination-adapter-contract.md)):* this
text previously preferred `redirect: 'error'`. Both modes refuse to follow, but `'error'` turns a
redirect into a network `TypeError` that cannot be told apart from a transient failure. With
`'manual'`, the 3xx is classified as a permanent `destination_redirected`, matching Stripe's
"redirects are failures".

**Errors** — a timeout is `destination_timeout`, **transient**.

**Security** — `redirect: 'manual'` plus the allowlist (F96) is the SSRF defence in depth.

**Tests**
- `outbound_calls_never_follow_redirects`
- `outbound_calls_have_a_bounded_timeout`
- `fan_out_respects_the_six_connection_limit`

**Deps** — F96, F183.

---

## F190 — Scheduled job fleet

**Priority** P0 · **Status** partial

**Story** As an operator, I want our background work to be visible and bounded, so that a
long-running job cannot quietly exhaust the cron budget.

**Acceptance**

| Job | Cadence | Purpose |
| --- | --- | --- |
| Outbox reconciler | 1 min | F174 |
| Dedup purge | hourly | F171 |
| Retention purge | daily | F51 |
| GitHub delivery-failure poll | hourly | F65 |
| GitHub reconciliation | hourly | F69 |
| Destination health check | daily | F98 |
| Connection token refresh | hourly | F66 |

- [ ] Every job is **chunked, bounded and resumable**, and records a completion marker.
- [ ] Every job has an **alert on staleness** — a job that silently stops running is
      indistinguishable from a job with nothing to do.
- [ ] Concurrency is bounded to stay inside cron CPU limits (built to the conservative ~30 s
      reading).
- [ ] ⚠️ One Worker owns all crons (Cloudflare's docs conflict on whether the 5/250 limit is
      per account or per Worker; we use one Worker regardless).

**Design** — A job that fails silently is the most common way a system appears healthy while
it is losing data. Staleness alerts are not optional.

**Errors** — a failed job records `job_failed` and retries with backoff; after repeated
failure it alerts.

**Security** — jobs are tenant-scoped and use the same repository layer (F24).

**Tests**
- `every_scheduled_job_is_chunked_and_bounded`
- `job_staleness_raises_an_alert`
- `retention_purge_removes_expired_payloads`

**Deps** — F192.