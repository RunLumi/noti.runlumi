# ADR 0020: The canonical event, the connector contract and the fixture replay suite

Status: Accepted · Date: 2026-10-14 · Implements slice 4b (spec 04 F41–F46 in part, F48 in part;
spec 05 F59, F60, F62, F63, F64, F65 in part, F71, F72; spec 06 F79 in part). Builds on
[ADR 0012](0012-generic-source.md), [ADR 0015](0015-provider-sources.md) and
[ADR 0010](0010-routing-filters.md).

## Context

Four sources (GitHub, generic, GitLab, Stripe) each produced the delivery message in their own way:
GitHub inside its route, generic through `toDisplayFields`, GitLab and Stripe through
`SourceConnector.map`. There was no shared, validated shape between "a verified payload" and
"routing, noise control and rendering", and no test that proved a connector against real payloads.

## Decisions

1. **`CanonicalEvent` (`src/events/canonical.ts`).** CloudEvents-aligned and versioned:
   `specversion "1.0"`, `id`, `source`, `type` (`io.lumi.noti.<provider>.<event type>`), optional
   `subject` and `time`, `dataschema`, and the extensions `provider` and `adapterversion` (names are
   `[a-z0-9]+`). `data` is a small **closed** object: `title`, `summary`, `url`, `repo`,
   `actor {login, type, isBot, isGhost}`, `status`, `severity` and `facts {branch, baseBranch, draft,
   labels}` (`null` = the payload did not say). No payload body, no email, no display name.
   A pragmatic subset of F41; what differs from the spec, on purpose:
   - `id` is the **provider's** delivery or event id (GitHub `X-GitHub-Delivery`, generic and GitLab
     `webhook-id`, Stripe `evt_`), not a ULID. With a repository- or product-scoped `source` that is
     the CloudEvents duplicate rule; the tenant-bound idempotency key stays separate (F170).
   - No `orgid` or `connectionid`: tenancy stays on the queue message and the rows, so an event
     never carries it.
   - `time` is set only when the payload carries one. A mapper is a pure function with no clock, so
     the same input always maps to the same bytes; no mapper sets it yet.
   - `dataschema` is a `urn:lumi:noti:schema:<provider>:<type>:v1` identifier. It does **not**
     resolve to a JSON Schema document (F52 is not built); it is informational.
2. **Mapping before routing.** Each route builds the canonical event from the verified payload,
   validates it, and only then routes: GitHub (`github/map.ts`), generic (`toCanonicalEvent`),
   GitLab and Stripe (the connector's `map` output wrapped by `canonicalFromDisplay`, with
   `adapterVersion` and `canonicalSource` now part of `SourceConnector`). `DeliveryMessage` keeps
   its shape and is derived with `displayOf(event)`. GitHub routing facts are `routingFactsOf(event)`
   (a test proves they equal `extractGithubFacts` for every fixture). Noise facts
   (`githubNoiseFacts`) still read the payload: moving them is follow-up work.
3. **A bounded validator (`src/events/validate.ts`) and one builder (`sources/build.ts`).** Hand-written; rejects unknown keys (top level
   and in `data`), wrong types, over-long fields, control characters, bidirectional controls,
   noncharacters, unpaired surrogates, a non-https link, a bad `time` or `source`, an event type
   outside its source's closed catalogue, and anything over the size budget. An invalid event never reaches a renderer, and errors name the field and a fixed reason, never the value. What the
   caller sees depends on whose fault it is:
   - **Our mapper/validator mismatch** (GitHub, GitLab, Stripe): a 4xx would be counted by GitLab
     toward disabling the hook, retried for days by Stripe, and never retried by GitHub (a silent
     loss). So the event is acknowledged with 2xx `{accepted:false, ignored:'schema_invalid'}`, logged
     at error level (`canonical_event_invalid`, field names only) and, for GitLab and Stripe, counted
     on the source (`dropped_events`, the counter a flood drop already uses). Where safe the field is
     degraded instead: a link that is not plain https is dropped and the event is still delivered.
   - **A sender's own malformed event** (generic): 400, because the sender's contract is ours.
   - A provider id that is too long or unprintable is hashed to `sha256:<hex>` (deterministic), never
     refused.
   `buildCanonical` is the single builder the routes and the test harness both call, so a golden
   covers exactly what the route builds.
4. **Size budget (F45).** The serialised event may not exceed 64 KiB (`CANONICAL_BUDGET_BYTES`), the
   CloudEvents "consumers SHOULD accept" threshold. Over it is `payload_too_large`, never a
   truncation. Field bounds keep the worst case under half of that (a test asserts it). Mappers cut
   text with an ellipsis, as they always did; dropped array entries are not applicable because no
   array of payload content is carried.
5. **Versioning rules (F46, F54).** `type` changes only for a breaking change to `data`;
   `dataschema` (and the `v1` in it) changes with every change; a breaking change emits `...v2`
   beside `...v1` for a deprecation window. Every mapper has a semver `adapterVersion`, recorded on
   each event; a mapping change that alters the stored shape bumps it. Renderers read the event, not
   the payload. Not built: a schema registry, published JSON Schemas, or `schema_unknown`.
6. **One event-type registry (`src/events/catalog.ts`).** Per type: source, label key (resolved by a
   test against the dashboard catalogues), default status and default severity.
   `GITHUB_EVENT_TYPES`, `GITLAB_EVENT_TYPES` and `STRIPE_EVENT_TYPES` are derived from it, and the
   validator checks against it. The generic source has no catalogue (its `type` is a label).
7. **Text hygiene is shared (`src/events/text.ts`).** One definition of unsafe text, used by the
   mappers and the validator; cuts never split a surrogate pair. GitHub text now goes through it
   (before, a title was only length-cut), so a title with a control character is cleaned rather than
   passed through. GitHub links must be `https:` without credentials; anything else is dropped.
8. **Connector contract and conformance (F71).** `SourceDescriptor` (`tests/conformance/descriptors.ts`, test-side data so no route code is
   imported by `src/`) states the cross-cutting contract for all four sources, including the two with their own routes.
   `tests/conformance/conformance.test.ts` runs one suite against every descriptor: verify before
   parse (and a source-order guard), the size cap including a chunked body, the replay window where
   the protocol has one and idempotency where it does not, one identical response for unknown,
   malformed and disabled endpoints (and for a missing, unknown and foreign GitHub installation),
   content type, deterministic mapping, no payload or personal data in the output (markers injected
   into the free-text and personal fields), bounded output under 200 KB fields, and the closed
   catalogue. A new source needs a descriptor, a case and a delivered fixture.
9. **Fixture replay (F72, F79).** `tests/fixtures/` holds documented examples (provenance table and
   rules in its README); `replay.test.ts` pushes each through the real route over the fake D1, signed
   with a run-time secret, and compares outcome, canonical event, per-integration routing and the
   rendered Slack, Lark, Teams and Discord payloads with `golden/*.json`, updated only by
   `UPDATE_GOLDEN=1` (refused when `CI` is set). Canonical event, routing and message goldens exist for
   every fixture; the four rendered destination payloads only for a representative eight (the
   destination suites own rendering). A fixture that stops parsing fails; none is skipped. `hygiene.test.ts` scans
   the tree for secret shapes, bidi controls and emails.

## GitHub specifics settled here

- **F59.** A delivery without `X-GitHub-Event` is now `400` (it was classified as nothing and
  acknowledged). The delivery id is opaque. The action comes from the body. Headers are read
  case-insensitively. `X-Hub-Signature` (SHA-1) alone is refused. The installation-target headers
  are never used. The route does **not** gate on `Content-Type`: a JSON body is accepted whatever the
  header says, and the form-encoded variant (`payload=...`) is refused as unparseable (400) after
  verification.
- **F60.** Attribution is `sender.login` and `sender.type` only. `ghost` is flagged and is **not
  shown** as a person (no actor on the message); a `[bot]` login or `type: Bot` sets `isBot`; unknown
  stays `null`. A display name or profile text is never read. The login is a display hint and never
  an authorization input.
- **F63.** The ingress cap stays 1 MiB (`MAX_BODY_BYTES`), checked against the declared length and
  the bytes read. GitHub drops payloads over 25 MB and delivers nothing; a delivery between the two
  limits reaches us and is refused with 413, which GitHub shows as a failed delivery. The refusal is
  logged with its reason (`github_event_too_large`, constants only), at most once a minute per
  isolate, because the request is not yet authenticated and must not be able to grow the log. We never read commits, so `push.commits` capping and `truncated` do not arise; a
  push with no commits is normal. The silent GitHub drops (more than 5000 branches or 3 tags at
  once) cannot be seen from the webhook stream.
- **F64.** 202 only after the delivery and outbox rows commit; a D1 failure is a 5xx so the failure
  is visible in GitHub's delivery log and can be redelivered (GitHub does not retry on its own).
  The dispatcher kick is `waitUntil` after the commit. A test pins each of these.
- **F65.** Without the App private key the only detectable signal is a redelivery, which keeps
  `X-GitHub-Delivery` and is absorbed. Delivery ids are opaque GUIDs with no sequence, so a gap
  cannot be seen. Detecting a delivery GitHub made and we never stored needs `GET
  /app/hook/deliveries` with an App JWT. That, and the reconciliation that fills the gap (F69), are
  **blocked on the App private key and API access** and are not implemented or claimed.

## Not done

F69 reconciliation and F65 polling; CloudEvents export and the structured `application/cloudevents+json`
ingress; a schema registry and published JSON Schemas (F52); `orgid`/`connectionid`/ULID ids;
`unmapped:<raw>` capture of unknown types and the unmapped-events view (F42); the `event_types`
table; `rawOutcome` and `closesEventId` (F44); the `adapter_version` stored in D1 (it is on the event
and the in-flight message only); R2 raw body storage (F45, F51); noise facts from the canonical
event; real (captured) fixtures, and fixtures for GitLab `Note Hook` and the Stripe thin event.

## Consequences

- A mapping or provider change that moves any output is a red build with a readable golden diff.
- Titles of `push`, `release`, `workflow_run` and `deployment_status` messages are still the event
  type string (the previous behaviour, now visible in the goldens). Richer titles are a mapping
  change and a golden update, not a refactor.
Intended behaviour changes in the mapping (none broke an existing test):

- Text that used to pass through unchanged is cleaned: control characters, bidirectional marks and
  zero-width or tag characters become spaces. ZWJ and ZWNJ stay allowed: emoji sequences and
  Persian or Indic text need them.
- A GitHub link that is not plain https is dropped.
- A GitHub delivery with no `X-GitHub-Event` is 400 (it was acknowledged and ignored).
- A ghost sender is not shown as the actor.
- A `[bot]` login with no `sender.type` is now a bot, so `actor.bots: exclude` excludes it where it
  used to be unknown and pass. A ghost still reaches `bots: exclude` and actor allow-list
  integrations as `ghost_exempt` (tested).
- A branch longer than 255 characters, or a label list holding a label that cannot be carried, is an
  unknown fact (`null`) rather than a truncated or shortened one: an allow-list holds it back.
- An absent status still renders without the status label and `info` with it. This predates the
  slice and only affects queue messages written before slice 5; every message built now has a
  status (tested).
