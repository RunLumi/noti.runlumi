# ADR 0035: At-least-once delivery is the contract; duplicates are surfaced, never hidden

Status: Accepted · Date: 2026-10-15 · Records the contract behind AR-5 and F185; the mechanics are in
[ADR 0005](0005-delivery-reliability.md) and [ADR 0023](0023-delivery-ledger-depth.md). **No code change, no migration.**

## Context

Cloudflare Queues delivers at least once. The destinations we send to (Slack, Teams, Lark, Discord, a customer webhook) do
not give us a server-side idempotency key. A Worker can also crash after a provider accepted a message and before the ledger
recorded it. Exactly-once delivery to a chat tool is therefore not achievable by us, whatever we build.

## Decision

1. **The promise is at least once**, and no document, UI string or sales claim may say "exactly once". AGENTS.md already
   forbids promising it.
2. **We dedupe where we can**: one stable idempotency key per event and destination, an atomic claim before sending,
   terminal rows acknowledged without a provider call (ADR 0005, F170).
3. **We never hide a possible duplicate**: a redelivery, a retry after an ambiguous failure and a manual replay are visible in
   the delivery log as such, with attempt counts.
4. **Ambiguous failures retry; terminal failures do not.** A closed error taxonomy decides, with bounded exponential backoff
   and jitter, a dead-letter queue and manual redelivery.
5. **Sources are treated the same way inbound**: a provider may redeliver, so ingress deduplicates on the provider's id.
6. A signed customer webhook carries a stable delivery id so the receiver can dedupe (ADR 0014).

## Why

Promising more would be a false claim, and hiding duplicates would remove the evidence a customer needs when two messages
arrive. Surfacing them keeps the ledger an honest record, which is also what incident reconciliation relies on (INCIDENT_RESPONSE S3).

## Consequences

- A destination can show the same message twice, rarely; support answers from the ledger.
- Replays (bulk and manual) are a user-visible act with a warning about duplicates.
- Digest and grouping features must stay idempotent under replay (ADR 0016).

## Revisit when

- A destination offers real idempotency (a client-supplied dedup key honoured server-side), AR-5's trigger.
- Queues offers an exactly-once or transactional send that includes the outbox write.
- A measured duplicate rate in production that customers notice.

## Not verified

No real-provider test has measured a duplicate rate; the figure is unknown.
