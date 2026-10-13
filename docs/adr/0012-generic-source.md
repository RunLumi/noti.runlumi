# ADR 0012: Generic signed-webhook source

Status: Accepted · Date: 2026-10-13 · Implements slice 10a (F74, F75, F76, F77, F78, F79, F80,
each in part, as listed under "Deliberately not done")

## Context

Until now Noti had one source, GitHub, whose tenant comes from a verified App installation.
Many customers want to send events from their own systems (a deploy tool, a billing job)
without a connector per tool. Spec 06 F73 ranks Standard Webhooks as the generic source with a
documented signature scheme, so it can be implemented exactly rather than approximated.

## Decisions

1. **One endpoint per source, selected by a public random id.** `POST
/webhooks/generic/:endpointId`. `endpoint_id` is 18 CSPRNG bytes as 24 base64url characters
   (144 bits). It is a **routing identifier, not a credential**: a leaked id with no secret
   yields 401, never an event. It is stored in clear (unlike spec 06 F76's hashed key) because
   it is public by design and shown in the dashboard; the HMAC is the authentication. An
   unknown, malformed or disabled endpoint returns one identical `404 Not found`.

2. **Standard Webhooks `v1` verification, nothing invented.** Headers `webhook-id`,
   `webhook-timestamp`, `webhook-signature`; signed content `id.timestamp.body` over the raw
   request bytes; secret `whsec_` + base64, **decoded** to the HMAC key; a space-delimited list
   where any `v1,<base64>` entry may match; other versions (`v1a`, `v2`) are ignored, never
   accepted. Comparison is `crypto.subtle.verify` (constant-time) and every candidate is
   checked, without early exit. A `.` in `webhook-id` is rejected before any HMAC (spec F74).
   Order: content type (415) and size (413, header and bytes) first, then the source lookup,
   then verification, and only then flood limiting, JSON parsing and routing.

3. **Replay and idempotency.** The timestamp must be unix seconds within ±5 minutes (our
   default, not a spec requirement); a millisecond value fails the digits-only pattern rather
   than being divided. `webhook-id` feeds the existing `dedupKey` (org, source row id,
   `generic`, id) and `deliveryId` (dedup key, integration), so a repeat is `INSERT OR
IGNORE`d: the first writer wins, a repeat answers `202 {persisted: 0, duplicate: true}`.
   A replay of a stale event is rejected by the timestamp; a replay inside the window is
   absorbed by idempotency.

4. **Ack discipline.** `202` only after the delivery row and the outbox row commit in one D1
   batch (the GitHub route's pattern). The prompt dispatch is `waitUntil`; the cron
   reconciler remains the recovery path. A secret that cannot be opened is a deployment or row
   fault: `500` with a category-only log line, so a retrying sender recovers once it is fixed.

5. **The signing secret is sealed, shown twice, never read back.** `sources.secret_envelope`
   holds the whole `whsec_…` string sealed under a per-source DEK (ADR 0004): AAD binds the
   organization, the source id, field `signing_secret` and purpose `source.signing`, so a
   sealed secret copied to another row fails to open. Create (201) and rotate (200) return it
   with `Cache-Control: no-store`; no read, list, export, log or audit entry contains it.
   Rotation re-seals under **fresh** key material and replaces the credential columns in one
   UPDATE. The KEK rewrap cron job also rewraps `sources` (`rewrapStaleSourceKeys`), so
   retiring an old KEK cannot strand sources.

6. **Rotation is cutover, with no overlap window.** The old secret is invalid the instant the
   UPDATE commits. Spec 06 F77 asks for up to two active secrets and a confirmation wizard;
   that needs a second sealed field and a dual-secret verification path and is deferred. The
   dashboard says so plainly in the rotate confirmation. A sender can still support its own
   overlap by sending two signatures in `webhook-signature`, which the verifier accepts.

7. **Fixed envelope instead of a mapping engine.** The event body is a documented, strictly
   validated JSON object (`type`, `title`, optional `summary`, `url`, `severity`, `actor`,
   `fields`). Unknown keys are rejected so a typo surfaces. `url` must be absolute `https:`
   without credentials and is only ever rendered as a link. Fields are bounded (10 entries,
   keys 40, values 200). Single-line fields reject controls and bidi characters. It maps onto
   the existing `DeliveryMessage` and therefore the existing adapters: `severity` becomes
   `info`/`warning`/`failure` (error and critical both map to `failure`), `type` becomes
   `eventType`, `fields` are appended to the summary within the shared 280-character budget
   with a visible ellipsis. `DeliveryMessage.status` gained `warning`, which the adapters
   already rendered. The closed GitHub event catalog (F42) does **not** apply: generic types
   are free-form display labels and cannot be filtered on yet.

8. **Routing.** `integrations.source_id` (nullable, migration 0017) marks an integration that
   receives every event of one source instead of a repository. Such rows carry the sentinel
   `repo = 'source:<source id>'`, which no GitHub `owner/name` can equal, so the GitHub query
   `WHERE repo=?` can never select them; the generic query selects on `organization_id` AND
   `source_id`. A database trigger refuses an integration whose `source_id` belongs to another
   organization, and a second trigger makes `source_id` immutable once set (no re-pointing an
   integration at another source). Source integrations have no repository, event types or
   filters to edit (API 422); routing filters (ADR 0010) do not apply to them yet.

9. **Tenant contract and lifecycle.** `sources.organization_id` is NOT NULL, refused when blank,
   immutable, and cascades from the organization; `sources` is also in `TENANT_TABLES` so the
   purge drains it in bounded batches. Workspace export lists sources **without** any
   credential column (explicit column list). Deleting a source deletes the integrations bound
   to it and, with the row, its wrapped DEK. The API refuses (409, with the count) unless the
   caller passes `?cascade=true`, and an `AFTER DELETE` trigger on `sources` guarantees no
   orphan integration survives whichever path removes a source (API, organization cascade,
   manual cleanup). While a deletion is pending, source mutations
   return 409 and (because integrations are disabled) nothing is routed.

10. **Flood limit after verification.** `sourceIngressLimiter` (600 per minute per source row)
    runs after the signature verifies, so an unauthenticated caller cannot burn a source's
    budget. Capabilities: `source.read/create/update/delete/rotate`. Members may read, create,
    rename and pause; **rotate and delete are admin-only** (rotation is an instant outage for
    the sender, deletion destroys the chats bound to it). Create enforces the 25-source quota
    inside the `INSERT`, and rotate applies only if the wrapped key is still the one it read
    (a concurrent rotation or the KEK rewrap job makes it a 409 with nothing changed).

11. **Timing parity for dead endpoints, best effort.** An unknown or disabled endpoint runs the
    same HMAC verification over the same bytes with a fixed decoy key before the identical 404,
    so the extra work of a live endpoint is limited to the (single-row) lookup, the DEK
    unwrap and the secret open. This narrows, and does not eliminate, a timing difference; the
    endpoint id has 144 bits of entropy, so enumeration is not the realistic threat. Shape
    equality (status, body, headers) is tested; timing is not measured.

12. **Bounded body reads (`src/lib/body.ts`).** `request.text()` buffers before any cap can run,
    and `Content-Length` is attacker controlled. `readBodyCapped` counts the bytes it receives
    from the stream and stops at `max + 1`; a declared length is only a fast path (a valid
    integer above the cap is refused unread; missing, empty, negative, fractional or non-numeric
    is "unknown" and the stream is counted; a small declared length is never trusted). Used by
    this route (256 KiB) and the GitHub route (1 MiB).

13. **Pre-authentication cost is bounded and documented, not eliminated.** Before the signature
    is known a request costs one indexed D1 read and one HMAC over at most 256 KiB. The decoy
    HMAC for a dead endpoint is skipped for bodies above 16 KiB, so a stranger's large body
    against a made-up endpoint costs no HMAC. A per-source limit cannot exist before
    verification without becoming an oracle or a way to burn a source's budget, so an edge rate
    rule is the control (docs/RUNBOOK.md, THREAT_MODEL AR-18); that rule is **not yet
    configured** and is unrehearsed.

14. **`webhook-id` must be unique per event.** The delivery row stores the SHA-256 of the raw
    body (`deliveries.body_hash`, migration 0017). The same id with the same body is the
    idempotent `202 duplicate`; the same id with a **different** body is `409
    webhook_id_reused`: nothing is queued, a redacted warning is logged (source id only), and
    `sources.reused_id_rejections` is incremented and shown on the Sources page ("N events were
    rejected because their id was reused"). A source with no integrations records no delivery
    row, so reuse there is not detected (nothing is dropped either). Two concurrent requests
    with one id and different bodies can both pass the pre-check; the second is then absorbed as
    a duplicate by the `INSERT OR IGNORE`. That narrow race is accepted.

15. **A replay never sends twice.** The outbox insert is conditional on the delivery insert
    having added a row (`WHERE changes() > 0` in the same batch). Without it, a repeat of an
    already-delivered id after retention removed the dispatched outbox row (7 days; the
    delivery row is kept 90) would insert a fresh outbox row and send the event again. The same
    defect existed in the GitHub route (a redelivery from GitHub's UI after 7 days) and is
    fixed there with its own test.

## Dashboard

A Sources page (`web/src/sources/`, ADR 0007 conventions): list, create by name, one-time
secret reveal with a persistent warning, copy button and focus move, the endpoint URL with a
copy button, a pause switch, a typed-name delete confirmation that states the chats it also
deletes (confirming it sends `cascade=true`), a rotate confirmation that states the cutover
(rotate and delete are shown to admins only), the reused-id counter, a "Send a test event" disclosure with
shell and Node examples, a plain-language event-format and signing explanation, and a
"Send these events to a chat" form (Lark, Slack, Teams) that reuses the integrations URL
policy and guides. The secret exists only in React state and is dropped on dismissal or
navigation; mutations that return it use `gcTime: 0` and never write the query cache. The
examples contain no secret: they read it from an environment variable.

## Verification and what is not verified

Tests cover signature construction (cross-checked against `node:crypto`), tamper, multiple and
unknown-scheme signatures, malformed headers, replay window edges, size and content type,
verify-before-parse, idempotency (first writer wins, cross-tenant non-collision), unknown /
disabled / malformed endpoint shape equality, tenant isolation (API and trigger), the
authorization, CSRF and quota paths, rotation (old secret dead at once), KEK rewrap, purge,
export, and end-to-end rendering through the real Slack, Lark and Teams adapters over the fake
D1. The shell and Node examples are executed and their output verified by the Worker's
verifier. **Not verified:** the Standard Webhooks spec's own example signature (the spec
publishes no secret, so it cannot be reproduced); behaviour on real D1 and Queues; timing
parity; a browser or 320 px reflow check of the new screens; any real third-party sender.

## Deliberately not done

- Secret overlap and the rotation wizard (F77); `secret_id_used` per verification.
- Per-source configurable mapping, CloudEvents-shaped payload detection, `application/cloudevents+json`,
  `data.extra`, `adapterVersion` (F78); the 1 MiB / 64 KiB policy (this source caps at 256 KiB).
- Hashed endpoint key, two live endpoint keys, endpoint-key rotation (F76); the endpoint id can
  only change by deleting and recreating the source.
- `clock_skew_suspected` operator alert, `providerIdStability` (F75); a stale timestamp is a
  plain 401.
- Fixture corpus and CI gate (F79); setup wizard, send-test step with taxonomy result, and
  stats exclusion (F80); filters and routing by event type (spec 10); a source health
  indicator beyond `last_received_at`.
- GitLab, Stripe, Linear, Sentry and Cloudflare sources (F81–F90).
