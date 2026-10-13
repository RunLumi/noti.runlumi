# ADR 0005: Delivery reliability core

Status: Accepted · Date: 2026-10-13 · Implements F169–F190 in part (docs/specs/12-delivery-reliability.md) and F11–F13 (docs/specs/01-platform-runtime.md) · Fixes D4, D10, and D11 in part

## Context

The outbox called `Queue.send()` and then marked the row, with no claim step, so the ingress
`waitUntil` kick and the every-minute cron could both publish one row (D4). Delivery ids were
the hand-built string `${githubDelivery}:${integrationId}` (D10). Every failure became
`retrying`, so a revoked webhook used every retry and was then dropped silently (D11).

Delivery stays **at least once**. Nothing in this ADR claims more than that.

## Decision

The pure logic lives in `src/platform/{errors,redact,log}.ts` and
`src/delivery/{retry,state,ids,claim,classify,ledger,redeliver}.ts`. The pipeline in
`src/pipeline/{outbox,consumer}.ts` wires it together. Migration `0009` rebuilds
`notification_outbox` and `deliveries` to add lease, schedule and ledger columns and the new
state sets.

1. **Outbox claim.** Each row is claimed with one conditional `UPDATE … WHERE state='pending'
   … RETURNING`, under a lease token that also fences later writes. Only the winner sends.
   An expired lease is reclaimed by the reconciler. The reconciler's only cross-tenant read is
   the list of workspace ids that have due work. Every row read and write is scoped by
   `organization_id`.
2. **Consumer claim.** The consumer claims the ledger row itself (`pending`/`retrying`, or a
   `claimed` row whose claimer has been silent for 5 minutes). It does not use a separate
   `delivery_claims` table. Terminal rows are acknowledged without a provider call, which
   generalises the old `alreadySent` check.
3. **Queue delay maximum: UNVERIFIED.** The repo docs never state Cloudflare's maximum
   `delaySeconds`. We use 12 h (`QUEUE_MAX_DELAY_SECONDS_UNVERIFIED`). Any longer wait is
   parked on the outbox row (`not_before`), the message is acknowledged, and the reconciler
   re-enqueues the row once it is due. Attempts are counted in the ledger, not by
   `msg.attempts`. A message that has used `max_retries` (5, mirrored in
   `QUEUE_MAX_RETRIES` and asserted against `wrangler.jsonc`) is also parked rather than
   retried. Otherwise the queue would hand it to an unconsumed DLQ while the ledger still
   said `retrying`.
4. **The F177 ladder as written.** The spec says "13 attempts over ~7 days", but its own
   ladder (2+6+12+24+48+72+96 h) adds up to 260 h, about 10.8 days. We kept the ladder and
   the test asserts 260 h. F08's "capped at 24 h" also conflicts with the 48–96 h rungs.
5. **Jitter on fixed delays.** F177 requires every retry path to be jittered. Full jitter
   would let a 2 h rung fire after 0 s and would break `Retry-After`, so fixed delays are only
   *extended*, by at most 10%. This is our own choice.
6. **`Retry-After` ceiling: 1 h.** F178 asks for a clamp but names no value. The ceiling is
   configurable per policy.
7. **State names.** The states are `pending, claimed, sent, accepted, retrying, dead_lettered,
   suppressed`. F184's `failed` is called `retrying` here, as in the F14 UI type. `accepted`
   comes from F100. `held` belongs to the grouping slice. Migration 0009 maps legacy `failed`
   to `dead_lettered`, and any unknown state also becomes `dead_lettered` with
   `internal_error`, so no row is left in a non-terminal state.
8. **Replay only from `dead_lettered`.** F182 refuses to replay a delivery that succeeded, so
   `sent` and `accepted` return `already_delivered`. A replay is a new row with `replay_of`
   and a fresh attempt counter. Its id is SHA-256 over `(original id, sequence)`, and the
   sequence advances in the same transaction, so a double-submitted replay creates one row.
9. **Delivery id.** F170 only defines the dedup key:
   `SHA-256(0x00‖org‖0x00‖connection‖0x00‖source‖0x00‖id)`, with the GitHub installation id
   as `connection`. For F184's `(dedup_key, destination)` identity we use the same encoding
   with a domain tag. Until destinations are separate entities, the integration row is the
   destination. Rows that already carry legacy ids are still found and updated, because the
   consumer only looks rows up by the id the message carries. Ingress refuses to re-accept a
   GitHub redelivery whose legacy-id row exists. The Lark `uuid` is the first 50 hex
   characters of the delivery id.
10. **Taxonomy, classification and redaction.**
    - We added `timestamp_out_of_tolerance`, the amendment from spec 03.
    - `destination_timeout` reuses the "didn't respond" copy.
    - Generic HTTP mapping: 401/403 → unauthorized, 404/410 → revoked, 408 → timeout,
      413 → too large, 429 → rate limited, 5xx → unavailable. Anything else is flagged
      `unmapped`.
    - The assignment of F179 Lark codes to taxonomy entries is ours.
    - Our API statuses: 401/403 at the verification boundary, 200 for a detected replay, 422
      for config problems, 502/503/504 for upstream failures. We never return 429 for a
      provider's throttle.
    - Lease durations (outbox 2 min, consumer 5 min) are our own choice.
    - `redact()` matches denylisted keys by whole word, cuts every URL to scheme and host,
      scrubs before truncating, and never throws. A known limit: only the first word of a
      multi-word secret in free text is redacted.

11. **A minimal DLQ consumer.** Messages in a dead-letter queue with no consumer are deleted
    after four days, and nothing would have marked the ledger. `src/pipeline/dead-letter.ts`
    consumes `noti-dead-letters` in the same Worker (`batch.queue` selects it). It moves a
    non-terminal row (`pending`, `retrying`, or a `claimed` row whose claim is stale) to
    `dead_lettered`, keeping any earlier error code, or `internal_error` with
    `queue_retries_exhausted`. It never calls a provider and never re-enqueues. For this,
    the state machine also allows `pending → dead_lettered`. `max_batch_size` for
    `noti-deliveries` is now 5, the top of the F176 range.

Crypto handling is unchanged from ADR 0004. Row defects are dead-lettered without a provider
call. Key or config faults are `internal_error`, which is retryable.

## Not done (honest list)

- No DLQ health check that asserts the consumer is attached (F180). No `delivery_attempts`
  table (F184). No `event_dedup` table or TTL purge (F170/F171).
- No replay API route, `delivery.replay` capability or audit record (F182). No dead-letter
  view (F181).
- No circuit breaker (F183). No client-side dedup window (F186). No per-destination rate
  limiting (F187). Lark custom bots have no `uuid`; the helper exists for app mode (F188).
- `outbox_stalled` and reconciler-failure alerts are not built (F173/F174). Unmapped provider
  errors are logged, not counted as a metric.
- DLQ retention is 24 h on Workers Free and 14 days on Paid. This has not been checked
  against the account plan.
- No real-provider end-to-end validation. Every result here comes from the `node:sqlite` D1
  fake and mocked `fetch`.
