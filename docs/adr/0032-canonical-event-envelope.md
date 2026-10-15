# ADR 0032: A CloudEvents-aligned canonical event envelope, versioned and closed

Status: Accepted · Date: 2026-10-15 · Records why the envelope looks the way it does; the mechanics are in
[ADR 0020](0020-canonical-event.md) (slice 4b). F38, F41, F45 of spec 04. **No code change, no migration.**

## Context

Four sources (GitHub, generic webhook, GitLab, Stripe) produced four ad-hoc shapes. Routing, noise control, rendering and
the delivery log need one shape. Three alternatives were on the table: keep per-source shapes, adopt CloudEvents
wholesale, or define a private envelope.

## Decision

Use a **[CloudEvents](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md) 1.0 aligned** envelope (`specversion`, `id`, `source`, `type`, `subject`, `time`, plus the extension
attributes `provider` and `adapterversion`) with a **closed, versioned `data` object** and a hand-written bounded
validator. "Aligned" means attribute names and the duplicate rule (`source` + `id`) follow CloudEvents; we do not claim
full conformance, do not depend on a CloudEvents SDK, and do not emit it to third parties.

Not taken:

- **Per-source shapes** keep every consumer coupled to every provider.
- **Wholesale CloudEvents with free-form `data`** would let a payload body, an email or a display name travel into routing,
  logs and queues; the closed `data` object is the control (ADR 0020 decision 1).
- **A private envelope** gives up a well-known vocabulary for no gain.

## Why

- A closed shape is what makes the delivery path auditable: an invalid event never reaches a renderer, errors name the
  field never the value, and the whole thing fits a 64 KiB budget.
- Borrowing CloudEvents names costs nothing and keeps a later export or a provider-neutral adapter easy.
- No library: the envelope is about 10 attributes, and a dependency in the request path that handles tenant payloads is a
  supply-chain cost (docs/SUPPLY_CHAIN.md).

## Consequences

- Tenancy is not on the event (`orgid` and `connectionid` are deliberately absent): it stays on the queue message and the rows.
- Adding a provider means a mapper into the closed shape, a fixture set and a conformance entry, never a new field.
- `dataschema` is an identifier, not a resolvable schema document, until F52 is built.
- A change to `specversion` or to the closed `data` shape is a new version with a replay of every golden fixture.

## Revisit when

- The source catalogue passes about four providers and the closed `data` object keeps needing provider-specific facts.
- We must emit events to a customer or another system, where full CloudEvents conformance would matter.
- F52 (published schemas) is authorised.

## Sources

- [CloudEvents v1.0.2 core](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md): attribute names and the
  `source` + `id` duplicate rule. Cited in `docs/specs/04-event-model.md`. **Not re-read** on 2026-10-15.
