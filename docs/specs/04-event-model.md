# 04 — Canonical Event Model

> The single most important decision in the system. Every source normalizes into this shape,
> every filter reads this shape, every renderer renders from it. Source-specific payloads never
> reach a filter, a template or a destination.
>
> External references read **2026-10-13**; see `README.md#sources`.

## Why CloudEvents

Not for interoperability marketing — we are not a broker. Because it supplies one
**normative** rule that we would otherwise have to invent:

> "Producers MUST ensure that `source` + `id` is unique for each distinct event. If a duplicate
> event is re-sent (e.g. due to a network error) it MAY have the same `id`. **Consumers MAY assume
> that Events with identical `source` and `id` are duplicates.**"
> — [CloudEvents v1.0.2 core](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md)

That is a spec-grade dedup contract, not advice. Two more rules shape the design:

| Rule | Consequence for us |
| --- | --- |
| "Intermediaries MUST forward events of a size of **64 KByte** or less. Consumers SHOULD accept events of a size of at least 64 KByte." | Hard ceiling on normalized envelope size (F45). R2 for the raw body. |
| "Sensitive information SHOULD NOT be carried or represented in context attributes. … producers, consumers, and intermediaries **MAY introspect and log** context attributes." | Context attributes are **IDs only**. Never an email, never a token, never a URL. This is the rule that makes F12's denylist short. |

### Documented inconsistencies to avoid

| Item | Reality | Source |
| --- | --- | --- |
| "IETF Webhook Security BCP" | **Does not exist.** Datatracker returns 404; no BCP titled webhook exists. Cite [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) instead. | IETF DT |
| RFC 9331 = rate limiting | **False.** RFC 9331 is *ECN for L4S*. The RateLimit headers are `draft-ietf-httpapi-ratelimit-headers`, still an **Active I-D, not an RFC** | [DT](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/) |
| Extension names may contain `_` or `.` | **False.** "Attribute names MUST consist of lower-case letters a-z or digits 0-9." | CE core |

---

## F41 — Canonical envelope

**Priority** P0 · **Status** not started

**Story** As a routing rule author, I want one stable field vocabulary, so that a filter on
"which repository" works identically whether the event came from GitHub or GitLab.

**Acceptance**
- [ ] Structured mode only (`application/cloudevents+json`). We do **not** implement the
      `ce-` binary HTTP binding on ingress — every provider has its own shape and we normalize
      *into* CloudEvents, not outward from it.
- [ ] Required attributes `id`, `source`, `specversion`, `type` are always present and
      non-empty. `specversion` is always exactly `"1.0"`.
- [ ] A JSON `null` extension is treated as **unset**, not as a literal null.
- [ ] Attribute names match `^[a-z0-9]+$` — no underscores, no dots, no uppercase.
- [ ] `time` round-trips as RFC 3339; `source` as a valid URI-reference.
- [ ] Rejects control characters (U+0000–U+001F, U+007F–U+009F), Unicode noncharacters and
      unpaired surrogates in any attribute.

**The envelope**

```json
{
  "specversion": "1.0",
  "id": "evt_01JB2QK9V3M7N2P4R6T8Y0W1Z5",
  "source": "https://github.com/acme-corp/monorepo",
  "type": "io.lumi.noti.github.pull_request.opened",
  "subject": "acme-corp/monorepo#482",
  "time": "2026-10-13T09:41:22.318Z",
  "datacontenttype": "application/json",
  "dataschema": "https://schemas.lumi.run/github/pull_request.opened/v1.json",

  "orgid": "org_7f3a91c4",
  "connectionid": "con_2b8e0411",
  "providerid": "ghd_9c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
  "attempt": 1,

  "data": {
    "action": "opened",
    "number": 482,
    "repository": { "fullName": "acme-corp/monorepo", "defaultBranch": "main" },
    "actor": { "login": "octocat", "id": "583231", "isBot": false, "isGhost": false },
    "title": "Fix notification fan-out on D1 write contention",
    "url": "https://github.com/acme-corp/monorepo/pull/482",
    "branch": "fix/d1-contention",
    "outcome": "neutral",
    "labels": ["bug", "infra"]
  }
}
```

**Design decisions, each with its reason**

| Decision | Reason |
| --- | --- |
| `orgid` / `connectionid` are CloudEvents **extensions** | Carries tenancy into the queue and the consumer without a side-channel lookup. Extension names are `[a-z0-9]+` per spec — `org_workspace_id` would be **invalid**. |
| `orgid` is Better Auth's organization id directly | Decision taken 2026-10-13: no mapping table, no sync risk. |
| `providerid` is the provider's own delivery GUID | Preserves provider dedup semantics per-connection. Never `null`. |
| `data.actor.isGhost` exists | GitHub documents a `ghost` placeholder user: *"Don't assume sender always identifies the person who caused an event."* A renderer that prints "alice opened this PR" can be wrong. (F60) |
| `data.outcome` is a closed enum | Lets status colour and grouping work across providers without per-provider special cases. |
| `id` is a ULID/UUIDv7, not the provider id | Time-sortable, so D1 primary-key ordering is useful, and provider ids are free to stay in `providerid`. |

**Errors** — a payload that fails envelope validation is rejected as `schema_invalid`
(F13) **before** any D1 write. It must never reach a renderer.

**Security** — context attributes are IDs only. This is what makes the redaction denylist
short and makes it safe to log `orgid`/`connectionid`/`correlation_id` (F11).

**Tests**
- `envelope_requires_id_source_specversion_type`
- `envelope_rejects_specversion_other_than_1_0`
- `envelope_treats_null_extension_as_unset`
- `envelope_rejects_attribute_names_outside_a_z_0_9`
- `envelope_rejects_control_characters_and_unpaired_surrogates`
- `envelope_round_trips_rfc3339_time_and_uri_source`

**Deps** — blocks every source, every filter, every renderer.

---

## F42 — Closed event type catalog

**Priority** P0 · **Status** not started · **Fixes** D12, D16

**Story** As a user picking events in the UI, I want a finite list of checkboxes, so that I
can find "pull request opened" instead of guessing a string format.

**Acceptance**
- [ ] `event_types` is a normalised table with a FK, not a JSON blob in a TEXT column
      (today's `migrations/0001`).
- [ ] Types are `provider.event[.action]`, declared in code as a closed union, and the union
      is the **only** thing the UI renders.
- [ ] Each type declares: display name, category, whether it is an "open"/"close" pair, a
      default outcome, and whether it is groupable.
- [ ] Unsupported upstream types are **accepted and labelled**, never rejected. GitHub:
      *"GitHub continues to add new event types and new actions to existing event types."*
- [ ] Unknown types arriving at runtime are stored as `unmapped:<raw>` and are **visible** in
      the dashboard with a "we haven't classified this yet" affordance — not silently dropped.
- [ ] Today's `classifyGithubEvent` returns `kind + '.' + action` freely, producing an
      unbounded, unenumerable routing key space. That stops.

**Schema**
```sql
-- F42
CREATE TABLE event_types (
  id TEXT PRIMARY KEY,            -- 'github.pull_request.opened'
  provider TEXT NOT NULL,
  category TEXT NOT NULL,         -- pull_request | issue | ci | release | repo
  display_name TEXT NOT NULL,
  default_outcome TEXT NOT NULL CHECK(default_outcome IN ('success','failure','neutral')),
  closable INTEGER NOT NULL DEFAULT 0,
  groupable INTEGER NOT NULL DEFAULT 1,
  catalog_version INTEGER NOT NULL
);
```

**Errors** — an unmapped type is recorded with `mapped=0` and raises a metric. A corrupt
`event_types` row today is `JSON.parse`-failed and `continue`d, so it is silently skipped
forever with no way to report it (D12).

**Security** — the catalog is server-owned. Clients send type ids; they never send free-form
strings that become routing keys.

**Tests**
- `catalog_is_closed_and_matches_the_ui`
- `unmapped_upstream_type_is_stored_and_surfaced_not_dropped`
- `every_catalog_entry_has_a_display_name_and_outcome`

**Deps** — F41. **Blocks** F140 (event picker), F136 (filters).

---

## F43 — Identity fields

**Priority** P0 · **Status** not started

**Story** As a filter author, I want to say "not bots", so that I can route real humans'
activity to a chat and machine activity to a ticketing system.

**Acceptance**
- [ ] `data.actor` is always present with `{ login, id, isBot, isGhost }`. Providers that
      do not distinguish bots set `isBot: null` — never `false`, which would be a lie.
- [ ] GitHub `ghost` maps to `isGhost: true`. Renderers must not present a ghost actor as a
      person.
- [ ] `data.actor` is inside `data`, never a context attribute — it is not an ID-only field
      and context attributes must stay log-safe.
- [ ] Filtering on `isBot` and `isGhost` is a first-class capability (F138).

**Errors** — a missing actor is `null`, never an empty object pretending to be a user.

**Security** — actor login is user content. It is not a secret, but it is untrusted and must
be length-capped and treated as plain text in every renderer.

**Tests** — `ghost_user_is_flagged`; `providers_without_bot_data_report_null_not_false`.

**Deps** — F41.

---

## F44 — Outcome and state model

**Priority** P0 · **Status** not started

**Story** As a user, I want CI failures coloured red and successes green everywhere,
including in Slack and Teams, so that I can triage from a glance.

**Acceptance**
- [ ] `data.outcome` is a closed enum: `success | failure | neutral`.
- [ ] Normalized per provider, with the provider's raw conclusion **preserved** in
          `data.rawOutcome` for debugging.
- [ ] Normalization is explicit, not guessed:
      - GitHub `workflow_run.conclusion` → `success` for `success`/`neutral`/`skipped`,
        `failure` for `failure`/`cancelled`/`timed_out`/`action_required`/`startup_failure`/`stale`
      - `check_run` and `check_suite` map the same way
      - `push`/`issues.*`/`pull_request.*` → `neutral`
- [ ] **Close events are modelled as state, not as a message.** `issues.closed`,
          `pull_request.merged`, `workflow_run` completing non-success, and release publication
      are *resolutions* of an earlier open event. This is what makes F156 (correlated state
      updates) and F157 (resolve notifications) possible at all.
- [ ] An event carries `data.closesEventId` when it resolves a known prior open event.

**Design** — This is the difference between a notification firehose and an alerting product.
Today `classifyGithubEvent` produces `workflow_run.failure` and treats it as an isolated fact.
Without a state model, every push of a failing commit re-notifies and nothing ever resolves.

**Errors** — a close event whose prior open event is outside retention still resolves; the
UI shows "resolved (original not retained)" rather than failing.

**Security** — n/a.

**Tests**
- `each_provider_conclusion_maps_to_a_documented_outcome`
- `raw_outcome_is_preserved`
- `merged_pr_resolves_the_corresponding_open_pr_event`
- `unknown_conclusion_maps_to_neutral_and_is_flagged`

**Deps** — F41, F42.

---

## F45 — Envelope size budget

**Priority** P0 · **Status** not started · **Fixes** part of D15

**Story** As an operator, I want bounded envelopes, so that a comment-heavy event cannot
blow up the queue, the database, or a 28 KB Teams limit.

**Acceptance**
- [ ] Normalized `data` is capped at **64 KiB** — the CloudEvents "MUST forward" threshold.
      Exceeding it is `payload_too_large`, not a truncation.
- [ ] The **raw** provider body is never embedded in the envelope. It is stored in R2 under
          `r2://raw/<orgid>/<connectionid>/<eventid>` and referenced by a 128-bit token.
- [ ] The 1 MiB hardcoded cap in `src/index.ts:27,29` becomes a documented per-provider
      policy checked against the provider's own published limit.
- [ ] Truncation is **never** silent: if any field is dropped, the envelope is marked
          `truncated: true` with the dropped field names.

**Design** — Note the asymmetry across our three destinations: Teams Workflows fails at
**28 KB**, Lark custom bot at **20 KB**, Slack at ~40 KB, Discord at 2000 + 6000 embed chars.
The envelope budget must therefore be set by the *tightest* destination, or rendering must be
capability-aware per destination (F89) and the envelope must carry enough structure to render
within each cap. We do **not** solve this by building 28 KB of payload.

**Errors** — `payload_too_large` is a **permanent** error (F13). It must surface to the user
with the field list, not retry forever.

**Security** — the raw body may contain private repository content and PII. It is retained
under the policy in F184 and is never logged.

**Tests**
- `envelope_over_64kib_is_rejected_not_truncated`
- `raw_body_is_never_embedded_in_the_envelope`
- `oversize_raises_payload_too_large_with_field_names`
- `each_destination_renderer_respects_its_documented_cap`

**Deps** — F41, F89.

---

## F46 — Schema versioning and evolution

**Priority** P0 · **Status** not started

**Story** As a customer with a working integration, I want schema changes to be additive, so
that my notifications never break because we renamed a field.

**Acceptance**
- [ ] The asymmetry in the CloudEvents primer is adopted exactly:
      **`type` changes only on breaking changes; `dataschema` changes on every change.**
      > "When a CloudEvent's data changes in a **backwardly-compatible** way, the value of the
      > `type` attribute should generally **stay the same**." / "When a CloudEvent's data changes
      > in a **backwardly-incompatible** way, the value of the `type` attribute should generally
      > **change**. The event producer is encouraged to **produce both the old event and the new
      > event for some time (potentially forever)**."
      > — [CloudEvents Primer v1.0.2](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/primer.md)
- [ ] A JSON Schema is published per `dataschema` URI with `additionalProperties: false` on the
      pinned version, so drift fails in CI rather than in a Slack channel.
- [ ] Breaking changes emit `….v2` alongside `….v1` for a deprecation window.
- [ ] Integrations pinned to `type = ….v1` keep working across the transition. This is the
      entire point.
- [ ] `providerApiVersion` is captured at ingest, so a delivery rendered years later matches
      the payload shape that existed when the event occurred.

**Design** — The primer also states plainly that CloudEvents *"does not mandate any particular
pattern"* for versioning, *"or even the use or consideration of versioning at all."* We are
adopting a policy, not inheriting one — which is why it is an ADR (F14).

**Errors** — an envelope whose `dataschema` is newer than any registered schema is accepted
and marked `schema_unknown`, never rejected. Forward compatibility beats strictness here.

**Security** — n/a.

**Tests**
- `additive_change_bumps_dataschema_and_keeps_type`
- `breaking_change_bumps_type_and_emits_both_versions`
- `consumer_pinned_to_v1_still_parses_a_v2_envelope`
- `generated_envelopes_validate_against_published_schema`

**Deps** — F41.

---

## F47 — Provider delivery ID mapping

**Priority** P0 · **Status** not started

**Story** As an operator, I want provider redelivery to be recognized as the same event, so
that a user clicking "redeliver" in GitHub does not double-notify my team.

**Acceptance**
- [ ] `providerid` maps per provider, recorded in a table so it is auditable rather than
      hard-coded in `if` chains.

| Provider | Source of `providerid` | Stability |
| --- | --- | --- |
| GitHub | `X-GitHub-Delivery` | *"If you request a redelivery, the `X-GitHub-Delivery` header will be the same as in the original delivery."* ✅ |
| Standard Webhooks / Svix | `webhook-id` / `svix-id` | *"remains the same no matter how many times a webhook that has failed is retried"* ✅ |
| Stripe | event `id` in body | Stable per event object |
| Slack | none documented | Synthesized hash of `(type, event_id, event_time)` — ⚠️ confirm against real payloads |
| Lark | `header.event_id` | ⚠️ stability across redelivery **unverified** |

- [ ] **Signature and timestamp are never used as identity.** Stripe: *"Stripe generates the
      timestamp and signature each time we send an event… we generate a new signature and
      timestamp for the new delivery attempt."* A router that dedups on the signature
      double-notifies on every retry — this is pitfall #4 in the anti-pattern list.
- [ ] Two-level dedup where the provider needs it: Stripe additionally dedups on
      `data.object.id + event.type`, because *"two separate Event objects are generated and
      sent"* for one underlying change. This is a **separate table** with a **separate TTL**.

**Errors** — a provider without a delivery GUID gets a synthesized deterministic key, marked
`providerid_synthesized=1` so we know it is weaker.

**Security** — provider delivery ids are not secret, but they are enumerable identifiers;
they are logged, never treated as authorization.

**Tests**
- `github_redelivery_with_same_delivery_id_is_a_duplicate`
- `signature_and_timestamp_are_never_used_as_identity`
- `stripe_semantic_duplicate_is_distinct_from_transport_duplicate`
- `providers_without_delivery_id_use_a_deterministic_synthesized_key`

**Deps** — F41, F170 (dedup).

---

## F48 — Untrusted payload tolerance

**Priority** P0 · **Status** not started

**Story** As an engineer, I want an unexpected upstream change to degrade rather than
break, so that a new GitHub action does not page us at 3am.

**Acceptance**
- [ ] Parsers ignore unknown top-level keys and unknown `action` values without failing.
- [ ] Unknown fields are preserved in `data.extra` for debugging, capped, and never rendered.
- [ ] **GitHub payload cap is a silent-drop, not a truncation.** Payloads are capped at 25 MB
      and *"If an event generates a larger payload, GitHub will not deliver a payload for that
      webhook event."* The router must handle "event with no payload at all" and surface it
      rather than treating it as malformed.
- [ ] A `ghost` sender is never rendered as a person.
- [ ] Payloads are parsed as UTF-8; GitHub: *"Webhook payloads can contain unicode characters."*
- [ ] Renderers are **pure functions** of the envelope. No renderer reads "the previous
      message" or holds state across calls — state belongs in F156.

**Errors** — schema drift raises a metric and appears in the dashboard's "unmapped events"
view. Never a user-visible failure.

**Security** — every string from a provider body is untrusted: length-capped, escaped per
destination, and never interpolated into a template as markup (F92).

**Tests**
- `parser_tolerates_unknown_keys_and_actions`
- `event_with_no_payload_is_surfaced_not_rejected`
- `renderer_is_pure_and_repeatable`
- `unicode_payloads_round_trip`

**Deps** — F41.

---

## F49 — Upstream rate limits and enrichment policy

**Priority** P1 · **Status** not started

**Story** As an operator, I want to know whether enriching an event is safe, so that a
traffic spike does not exhaust our API budget.

**Acceptance**
- [ ] Default is **payload-only**. No outbound API call during ingress.
- [ ] Enrichment is opt-in per integration, per field, with a documented cost, and is
      budgeted per workspace.
- [ ] GitHub REST authenticated rate limit is **5,000 req/hr** and GraphQL **5,000 points/hr**
      — verify current values before hardcoding; secondary rate limits apply on top.
- [ ] Enrichment happens **asynchronously** in the consumer, never in the request handler,
      which must acknowledge GitHub inside **10 seconds**.
- [ ] A failed enrichment degrades the notification; it never fails the delivery.

**Design** — Today `src/index.ts` builds title/url from the webhook body with no enrichment
and no API call, which is the correct default and should stay. The failure mode to avoid is
adding "fetch the PR author" to the hot path and blowing the 10s budget under load.

**Errors** — enrichment failure logs `enrichment_failed` and renders the payload-only version.

**Security** — installation tokens must never appear in an envelope, a log, or a template
variable (F12).

**Tests**
- `ingress_makes_no_outbound_api_calls_by_default`
- `ingress_completes_within_the_provider_ack_deadline`
- `enrichment_failure_degrades_rather_than_fails_delivery`

**Deps** — F41, F66.

---

## F50 — Inbound response codes

**Priority** P0 · **Status** not started

**Story** As an operator, I want our ack codes to match what providers expect, so that a
correct receipt does not cause a provider to retry forever.

**Acceptance** — adopted from the CloudEvents HTTP webhook profile and Stripe's table:

| Situation | Response | Why |
| --- | --- | --- |
| Accepted and durably stored | **`202`** | "accepted but not yet processed or status unknown" |
| Accepted and processed | `200` | |
| Exact duplicate | **`200`** | Stripe: *"skip it and return a 200 response to stop further retries."* |
| Signature invalid / unauthorized | `401` | never 4xx that invites retries — GitHub/Slack do not retry on 4xx anyway, but be explicit |
| Replay / stale timestamp | `401` | |
| Malformed payload | `400` | |
| Body too large | `413` | |
| Rate limited | `429` **+ `Retry-After`** | The profile says MUST; RFC 6585 §4 only says MAY — follow the stricter one |
| Destination retired | `410 Gone` | *"the server is no longer interested… Sender should disable the webhook endpoint"* |
| Unsupported content type | `415` | |

- [ ] Never `3xx` on ingress, and redirects are never followed.
- [ ] A duplicate returns `200`, **never** 4xx — otherwise a provider retries forever on an
      event we already processed.
- [ ] Acknowledge **only after** durable acceptance. The GitHub 10-second deadline is a hard
      budget for the whole request (F09).

**Errors** — every non-2xx emits a `correlation_id` in the response body so a user can quote
it in a support request.

**Security** — error bodies never contain the received signature, secret or payload.

**Tests**
- `duplicate_delivery_returns_200`
- `rate_limited_response_includes_retry_after`
- `ack_happens_after_durable_write_not_before`
- `no_error_response_body_contains_secret_material`

**Deps** — F41, F169 (outbox).

---

## F51 — Event retention and payload storage

**Priority** P1 · **Status** not started

**Story** As a customer, I want my event data deleted on a schedule I can see, so that I can
meet my own retention obligations.

**Acceptance**
- [ ] Split retention: **normalized envelope 30 d**, **raw provider body 30 d**,
      **delivery metadata 90 d**, **audit 1 y**. Raw bodies hold private repository content
      and are the highest-sensitivity asset we store.
- [ ] Raw bodies live in R2, encrypted, addressed by `orgid` so deletion is a prefix delete.
- [ ] Enforcement is a scheduled job (F192), not a read-time filter.
- [ ] Deletion is chunked and resumable; a partial purge is not reported as complete.
- [ ] D1 Time Travel retains up to 30 days and restores are **in-place**
      ([d1/reference/time-travel](https://developers.cloudflare.com/d1/reference/time-travel/)).
      Erase-from-backups cannot be faster than that window and documentation must say so
      rather than implying otherwise.

**Errors** — purge retries safely; a failed chunk is recorded and resumed.

**Security** — purging removes ciphertext and payload blobs, not just metadata. Enforce with
a test that asserts the row is gone, not merely flagged.

**Tests**
- `retention_job_deletes_expired_envelopes_and_raw_bodies`
- `purge_resumes_after_interruption`
- `r2_prefix_delete_is_scoped_to_one_org`

**Deps** — F184, F192.
---

## F52 — Event schema registry

**Priority** P1 · **Status** not started

**Story** As a customer integrating against us programmatically, I want a published schema
I can validate against, so that my consumer breaks in CI rather than in a chat channel.

**Acceptance**
- [ ] Every `dataschema` URI in F41 resolves to a JSON Schema document.
- [ ] Schemas are versioned and served from a stable, documented base
      (e.g. `https://schemas.lumi.run/github/pull_request.opened/v1.json`).
- [ ] Published schemas use `additionalProperties: false` on the pinned version, so an
      unexpected field fails validation rather than passing silently.
- [ ] A schema is published **before** an event type using it is enabled for customers.
- [ ] Schemas are generated from the same definitions the normalizer uses, so the published
      contract cannot drift from the implementation.

**Design** — CloudEvents is explicit that `dataschema` is *"expected to be informational"* and
that the producer decides versioning. Publishing it anyway turns that advisory into a real
contract. The risk to avoid is publishing a schema generated from a hand-written copy of the
types: it will drift within one release.

**Errors** — an envelope whose `dataschema` is unknown is accepted and marked
`schema_unknown` (F46), never rejected. Forward compatibility beats strictness for inbound
traffic.

**Security** — schemas are public. They must never contain internal hostnames, tenant ids or
field names that reveal internal structure beyond what the event already exposes.

**Tests**
- `every_dataschema_uri_resolves_to_a_published_document`
- `published_schema_matches_the_normalizer_output`
- `unknown_dataschema_is_accepted_and_flagged`

**Deps** — F41, F46.

---

## F53 — Ingress coalescing and backpressure

**Priority** P2 · **Status** not started

**Story** As an operator, I want a burst of traffic to be absorbed rather than amplified, so
that one busy repository cannot consume the whole delivery budget.

**Acceptance**
- [ ] Ingress applies a **per-connection** token bucket. A single connection cannot consume
      the shared capacity.
- [ ] When the bucket is exhausted, the response is `429` with `Retry-After` (F50), not a
      silent drop and not a queue-backup that blocks the request handler.
- [ ] ⚠️ **Grouping is the preferred absorber, not rejection.** A burst of comment events is
      legitimate load; it should collapse (F141–F143) rather than be refused. Rejection is a
      last resort for genuinely malformed floods.
- [ ] Coalescing never changes the durable receipt: every event that is accepted is stored,
      even when its delivery is later merged into a group.
- [ ] Per-connection counters are independent of the auth rate limits (F22) and of billing
      meters (F253).

**Design** — The pressure point is the queue, not the request handler. Because ingress must
acknowledge within the provider deadline (F64) and because GitHub does not retry at all
(F65), refusing aggressively is dangerous: a refused event may simply vanish. Coalescing at
ingress preserves the receipt and defers the work.

**Errors** — bucket exhaustion is `429 destination_rate_limited`; it is a throttle, not a
failure, and is never counted as a delivery failure.

**Security** — the bucket key is `connection_id`, which is server-derived. An attacker cannot
choose a key that exempts them.

**Tests**
- `one_connection_cannot_exceed_its_own_budget`
- `burst_is_coalesced_rather_than_refused`
- `refusal_returns_429_with_retry_after`
- `every_accepted_event_is_durably_stored`

**Deps** — F141, F50.

---

## F54 — Normalization versioning and replay compatibility

**Priority** P1 · **Status** not started

**Story** As a customer, I want old notifications to keep rendering correctly after we
improve our parsing, so that my delivery history stays meaningful.

**Acceptance**
- [ ] Every event records the `adapter_version` that produced it.
- [ ] Renderers are **pure functions of the stored envelope** (F48). Re-normalizing an old
      raw payload is never required to render a historical delivery.
- [ ] An adapter may change its mapping in a way that is **render-equivalent** without a
          version bump; any change to the stored envelope shape requires one.
- [ ] Changing a normalizer never mutates already-stored events. Replay re-processes the raw
          body only when explicitly requested, and produces a **new** event rather than
          overwriting the original.
- [ ] A delivery created years ago renders from its stored envelope and its captured
          `providerApiVersion`, not from today's parser.

**Design** — This is the reason F41 puts everything the renderer needs *inside* the envelope.
If a renderer ever re-reads the raw provider payload, then any parser change retroactively
changes history, and a delivery log stops being evidence.

**Errors** — an envelope whose `adapter_version` predates the current minimum supported
version is rendered as best-effort and flagged in the UI, never dropped.

**Security** — raw bodies are retained under the F51 policy; re-processing them requires the
same tenant authorization as reading any event.

**Tests**
- `every_event_records_its_adapter_version`
- `historical_delivery_renders_without_re_normalizing`
- `replay_creates_a_new_event_and_preserves_the_original`
- `renderer_depends_only_on_the_stored_envelope`

**Deps** — F41, F48, F51.
