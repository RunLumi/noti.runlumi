# 06 — Generic Source & Additional Sources

> Provider documentation read **2026-10-13**. Every external claim below is cited to the
> provider's own documentation. Anything I could not verify from a primary source is marked
> **⚠️ UNVERIFIED** together with what must be checked before it becomes a claim.
>
> **There is no `IETF Webhook Security BCP`.** Datatracker returns 404 for it. The
> normalisation reference for inbound webhooks is
> [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md).
> The existing event model already builds on it (F42, F170); this file makes it the
> **generic source's** verification contract.

> **Implementation status, slice 10a (2026-10-13).** The generic source ships in part; see
> [ADR 0012](../adr/0012-generic-source.md) for decisions and the not-done list.
> Done: F74 (verification core; `webhook-id` cap is 128, not 255), F75 (5-minute window,
> seconds-only, idempotency on `webhook-id`; not done: `clock_skew_suspected`,
> `providerIdStability`), F76 in part (144-bit random path id, tenant from the source row,
> identical 404, per-source revocation by pause or delete; not done: hashed key, two live keys,
> overlap), F77 in part (rotation is **cutover**, no overlap and no wizard), F78 in part (a
> fixed, strictly validated envelope instead of a per-connection mapping; 256 KiB cap and
> `application/json` only, not the 1 MiB/CloudEvents policy), F79 in part (tests with runtime
> secrets, not a captured-fixture corpus), F80 in part (a Sources page, not the wizard with a
> send-test step). F73 and F81 onward are unchanged.

> **Implementation status, slice 10b (2026-10-13).** GitLab and Stripe ship in part behind a typed
> connector registry; see [ADR 0015](../adr/0015-provider-sources.md). Done in part: **F81**
> (GitLab.com only; one credential per source chosen by the person, either the signing token via
> the shared Standard Webhooks verifier or `X-Gitlab-Token` in constant time, no fallback between
> them; instance header checked; `Idempotency-Key`/`webhook-id` as identity, event UUID unused),
> **F83** (a closed 11-type catalogue: push, tag push, merge request opened/merged/closed/reopened,
> issue opened/closed/reopened, pipeline failed/succeeded; action from the body; confidential
> issues never copy the title; no emails), **F84** (Stripe `v1` over the raw body, secret as a
> string, `v0` ignored, several `v1`, five-minute tolerance, test and live as separate sources) and
> the transport half of **F86** (dedup on event id; same id with a new signature is one
> notification). **F82** in part: GitLab floods are absorbed with a 2xx instead of a 429. **F89** is
> resolved as a refusal, re-verified today (the documented recipe still signs `JSON.stringify` of
> the body, with no replay window): no Sentry source, API `422`, test fails if one is registered.
> **Not done:** GitLab self-managed, dual credentials, the F82 health model (72 h prompt, plan
> tiers, disable inference), `Note`/`Job`/`Release`/`Wiki` hooks and `data.extra`; Stripe thin
> events and enrichment (F85), semantic dedup and reconciliation (rest of F86); Linear (F87, F88),
> Cloudflare (F90); fixture capture from real providers (F79). Deviation from F85: a Stripe event
> of the other livemode is acknowledged and ignored (200), not refused with 401.

## The finding that orders this file

Two sources in this file have a **verified, documented signature scheme** we can implement
exactly (Generic/Standard Webhooks, Stripe, Linear, GitLab's signing token). Two do not
(Sentry's alert-action webhook, Cloudflare Alerts). That distinction — *not* how popular the
tool is — is the admission bar, and F73 makes it explicit.

A second finding governs the whole file: **inbound retry behaviour differs per provider and
several providers silently stop sending.** GitLab auto-disables after 4 consecutive failures
and **permanently** after 40. Linear may disable a webhook and requires manual re-enabling.
Neither has a redelivery API we can poll. GitHub does not retry at all (F05). The consequence
is that *every* source in this file needs F98-style health surfacing plus provider-specific
disablement detection, and no source may claim the inbound at-least-once property that
12-delivery-reliability.md gives our **outbound** path.

---

## F73 — Source ranking and the admission bar

**Priority** P0 · **Status** not started

**Story** As a maintainer, I want every source addition to clear one written bar, so that we
ship fewer connectors and ship them honestly.

**Acceptance**
- [ ] Sources are ranked on four axes, scored in this file and reviewed at each release:

| Axis | Question | Weight |
|---|---|---|
| **Verifiable auth** | Is there a documented signature or documented secret header we can implement exactly? | blocking |
| **Multi-tenant onboarding** | Can a customer connect it themselves, or do we store their credential? | blocking |
| **Event semantics** | Does the event set map onto the closed catalog (F42) without inventing fields? | high |
| **Overlap with the wedge** | Is the information already in a GitHub event? | high |

- [ ] **Blocking axis 1 outcome for each candidate, as verified today:**

| Source | Documented signature | Verdict |
|---|---|---|
| Generic / Standard Webhooks | ✅ `webhook-id` / `webhook-timestamp` / `webhook-signature` | **build** |
| GitLab | ✅ `webhook-signature` (signing token, GA 19.1); `X-Gitlab-Token` fallback | **build** |
| Stripe | ✅ `Stripe-Signature` `t=`/`v1=`, default tolerance 5 minutes | **build** |
| Linear | ✅ `Linear-Signature` hex HMAC-SHA256 of the raw body | **build** |
| Sentry (alert action "custom webhook") | ❌ none documented — see F89 | **pull only** |
| Cloudflare Alerts | ⚠️ static `cf-webhook-auth` bearer, no body integrity — see F90 | **build, labelled** |

- [ ] **Overlap rule.** A source that only re-delivers information already present in a
      GitHub event is P2 or lower regardless of how easy its auth is. This is why an Sentry
      *issue* webhook is not a candidate: a GitHub-failure notification already carries the
      repository, actor and branch.
- [ ] **Anti-aliasing rule.** A source that is already covered by a *managed* destination
      (e.g. adding a Slack Events API source when we already have a Slack destination) is
      rejected on architecture grounds: it doubles the credential surface for zero new
      reach.
- [ ] The ranking is a table in `docs/specs/` and is re-verified against provider docs at
      least twice a year; a stale row is a CI failure.

**Design** — "How many integrations are on the landing page" is the metric AGENTS.md
explicitly rejects. This bar is the enforcement mechanism for that. The four axes are
deliberately ordered so that a source with beautiful auth and no multi-tenant onboarding
(GitLab self-managed webhook *creation*, Linear's admin-only webhook UI) still has to
justify itself on the axes below it.

The honest consequence of the bar: **Cloudflare Alerts ships with weaker auth than anything
else we support**, and F90 requires that weakness to be printed in the UI rather than hidden.
Weakening the bar to make a source look as good as GitHub is the failure mode this feature
exists to prevent.

**Errors**
| Condition | Behaviour |
|---|---|
| A ranked source's docs change its signature scheme | Row is marked stale; the connector's contract test fails until re-verified |
| A source cannot clear a blocking axis | Not built. Recorded here as a decision with the reason. |

**Security** — a source that can only be authenticated by a guessable or static secret with
no body integrity is a **content-injection** risk against the renderer, not just an
authentication risk. That is why Cloudflare Alerts carries an explicit untrusted-payload
requirement (F90), not just a token check.

**Tests**
- `every_registered_source_clears_all_four_admission_axes`
- `a_source_without_documented_auth_is_never_registered_as_push`
- `the_source_ranking_table_is_reviewed_and_stamped`

**Deps** — none. **Blocks** F74–F90.

---

## F74 — Standard Webhooks verification core

**Priority** P0 · **Status** implemented (slice 10a)

**Story** As a security reviewer, I want any standards-compliant webhook to be verifiable with
one code path, so that adding a new producer costs no new crypto.

**Acceptance**
- [ ] The generic source verifies against the
      [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)
      symmetric scheme, and nothing else is invented:
  - Headers read: `webhook-id`, `webhook-timestamp`, `webhook-signature`.
  - Signed content is **`msg_id.timestamp.payload`**, full-stop delimited, over the **raw
    request body bytes**.
  - Secret is base64-encoded and prefixed `whsec_`. **Strip the prefix, then base64-decode,
    and use the decoded bytes as the HMAC key.** HMACing the `whsec_…` string itself is the
    single most common implementation bug here.
  - Signature is `HMAC-SHA256` rendered as base64, prefixed with the scheme id `v1,`.
  - The header is a **space-delimited list**. Split on `' '`, and accept if **any** entry
    matches under **any** active secret. The spec's reason: *"Signing with multiple keys,
    even compromised ones, doesn't diminish the security of the scheme, as the consumer
    still requires a valid signature."*
- [ ] **Unknown schemes are ignored.** Only `v1` is verified; `v1a` (asymmetric/ed25519) is
      recorded as unsupported. Stripe states the same rule for its own header: *"To prevent
      downgrade attacks, ignore all schemes that aren't `v1`."* An unknown scheme must never
      fall through to "accept".
- [ ] **A `webhook-id` or `webhook-timestamp` containing `.` is rejected before any HMAC.**
      The spec: *"It's important that both the message id and the timestamp not be user
      controlled, or at the very least not be allowed to include any `.` to prevent certain
      attacks."* Otherwise an attacker who controls the id can shift bytes across the field
      boundary. The following limits are **ours**, chosen because the spec leaves them open:
      `webhook-id` is capped at 255 chars and `webhook-timestamp` must match `/^[0-9]{1,20}$/`.
- [ ] Comparison is **constant-time** on the decoded 32-byte digest, never `===` on strings.
      The spec: *"Failing to do so can expose consumers to timing-attacks and turn them into
      signing oracles."* Shape-guard the scheme prefix and the decoded length **before**
      comparing, for the same reason F58 guards GitHub's header.
- [ ] **The raw body is never re-serialised.** The spec is explicit: *"it's important to make
      sure that the payload sent is the same as the payload signed… This is a very common
      failure mode as many webhook consumers often accidentally parse the body as json, and
      then serialize it again."* Any test that `JSON.parse` → `JSON.stringify` → compare is
      a bug, and there is a test for it.
- [ ] Missing any of the three headers is a hard `401` (F50), not "skip verification".
- [ ] `v1a` / asymmetric support is **declared unsupported in the UI**, per F92's honest-state
      rule. We do not accept `whsk_`/`whpk_` key material.

**Design** — One verifier for every producer that follows the spec. That is the entire point
of the spec: *"consumers [currently spend effort] handling webhooks differently for every
provider, relearning how to verify webhooks, and encountering gotchas with bespoke
implementations."* F81 (GitLab) reuses this verifier verbatim — GitLab's signing token is the
spec's scheme with a GitLab header name and the same base64 decode.

We deliberately do **not** implement the asymmetric half. ed25519 in Workers means a
dependency or a hand-rolled implementation, and the spec's own guidance is *"Prefer
asymmetric signature schemes over symmetric ones"* **only** when *"you do not control the
security of both the producer and consumer"* — which is not our position: our producers are
SaaS platforms we integrate with, and our consumer is a per-connection secret we generated.

**Errors**
| Condition | Behaviour |
|---|---|
| Missing `webhook-signature` / `-id` / `-timestamp` | `401`, no body detail |
| No signature matches any active secret | `401`, no body detail, audit |
| `webhook-id` or `webhook-timestamp` contains `.` | `401` before any HMAC work |
| Unknown scheme present only | `401` — ignored, never accepted |
| Secret is not `whsec_`-prefixed or is not valid base64 | connection is invalid at **save** time, not at delivery |
| Signature valid, timestamp out of window | `401` (F75) |

**Security** — `whsec_` secrets are 32 random bytes, base64url-encoded, prefixed, per
connection, never reused across connections (the spec: *"Signing keys should be unique per
endpoint… Reusing keys across customers can lead to security issues!"*). Stored encrypted
with the envelope scheme (F36), rendered once, masked thereafter. A verify failure never
echoes the presented signature.

**Tests**
- `standard_webhooks_known_answer_passes`
- `secret_is_base64_decoded_after_stripping_the_whsec_prefix`
- `hmacing_the_whsec_prefixed_string_is_rejected`
- `multiple_space_delimited_signatures_are_accepted_if_any_matches`
- `unknown_signature_scheme_is_ignored_and_never_accepted`
- `webhook_id_containing_a_dot_is_rejected_before_hmac`
- `timestamp_containing_a_dot_is_rejected_before_hmac`
- `json_round_trip_of_the_body_fails_verification`
- `signature_comparison_is_constant_time_and_never_string_equals`
- `missing_any_of_the_three_headers_is_401`

**Deps** — F04, F12, F36.

---

## F75 — Replay window and idempotency key

**Priority** P0 · **Status** partly implemented (slice 10a)

**Story** As a customer, I want a replayed webhook to be ignored, so that a captured request
cannot replay my CI failures into a channel forever.

**Acceptance**
- [ ] `webhook-timestamp` must be within a tolerance of now. The spec requires only *"some
      allowable tolerance"*; **5 minutes is our chosen default**, recorded as a per-connection
      setting and asserted in the UI. It is not presented as a spec requirement.
- [ ] `webhook-timestamp` is **unix seconds** per the spec. A value that looks like
      milliseconds is rejected, not silently divided — a 1000× error here silently disables
      every event.
- [ ] Clock skew is an operational failure, not a signature failure: it produces `401` +
      `clock_skew_suspected` on the connection and an operator alert, so a bad NTP source does
      not look like an attack.
- [ ] `webhook-id` becomes `providerid`. The spec states it *"remains the same no matter how
      many times a webhook that has failed is retried"* and *"is often used as an idempotency
      key"*.
- [ ] ⚠️ **For the generic source we do not control the producer.** Standard Webhooks id
      stability is a *spec obligation on the producer*, not a guarantee to us. Connections may
      declare `providerIdStability: 'spec-guaranteed' | 'observed-only' | 'unknown'`; the
      `'unknown'` case still dedups (a repeat id within TTL is a duplicate) but the delivery
      log records that duplicate suppression is best-effort for that connection.
- [ ] Dedupe is two-level exactly as F171 specifies: transport identity
      (`webhook-id`) and, where the producer emits several Event objects for one underlying
      change, a semantic key. `0x00` separators, full 256-bit digest, `orgid` and
      `connectionid` in the derivation.
- [ ] A duplicate returns **`200`**, never 4xx (F50), so the producer stops retrying.
- [ ] The spec's operational recommendation is adopted verbatim in the source's contract: on a
      sustained 4xx/5xx *"it is important to: notify the consumers using other channels (e.g.
      email), and … disable future delivery to the endpoint."* That is our F98 + F82.

**Design** — Replay protection and duplicate suppression are one mechanism viewed twice: a
replay is a duplicate, and the dedup table with a bounded TTL is the replay window. Building
them separately would mean two stores and two failure modes.

The 5-minute tolerance interacts with the producer's own retry schedule. The spec's example
schedule retries at 0, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 14 h, 20 h, 24 h. A producer
following it and failing our endpoint will be rejected at the 30-minute retry as "replayed"
long before it gives up — which is correct behaviour for a forged request but wrong for a
real retry. The resolution is the **same** one the spec gives: the sender regenerates nothing
(the timestamp is the *attempt* time, not the event time, so each retry carries a fresh
timestamp), and our dedup TTL is measured on `webhook-id`, not on the timestamp. This is
asserted in a test so a future "simplification" cannot break it.

**Errors**
| Condition | Behaviour |
|---|---|
| Timestamp outside tolerance | `401`, `stale_timestamp`, no retry loop |
| Timestamp unit wrong (ms, or non-numeric) | `401`, `timestamp_malformed` |
| Duplicate `webhook-id` within TTL | `200`, `hit_count` incremented, not routed |
| Same `webhook-id` after TTL expiry | Processed again — and that is asserted, not assumed |

**Security** — the tolerance window is the only thing standing between a captured request and
a replay, so `now` is injected (never read from the clock inside the verifier) and the value
is not configurable to 0. Stripe documents the same trap: *"Don't use a tolerance value of
`0`. Using a tolerance value of `0` disables the recency check entirely."*

**Tests**
- `timestamp_outside_tolerance_is_401`
- `timestamp_outside_tolerance_is_distinguished_from_bad_signature`
- `millisecond_timestamp_is_rejected_not_rescaled`
- `retry_with_fresh_timestamp_and_same_id_is_a_duplicate_not_a_replay`
- `same_id_after_ttl_expiry_is_processed_again`
- `zero_tolerance_is_rejected_at_configuration_time`
- `unknown_provider_id_stability_is_recorded_on_the_connection`

**Deps** — F74, F47, F170, F171.

---

## F76 — Unguessable tenant key in the URL path

**Priority** P0 · **Status** partly implemented (slice 10a) · **Fixes** part of D3

**Story** As a customer, I want my webhook URL to be unguessable and rotatable, so that
nobody can inject events into my workspace or discover my endpoint.

**Acceptance**
- [ ] Every non-GitHub source resolves its tenant from a path segment of **≥ 128 bits of
      CSPRNG entropy**, base64url without padding. It is **never** sequential, never a
      workspace id, never an org slug, never derived from the domain.
- [ ] **The key is a bearer credential and is treated as one**: displayed exactly once,
      copy-to-clipboard in the wizard, masked thereafter, never in a URL we log, never in an
      error message, never in analytics, never in a referrer.
- [ ] Lookup is a single indexed equality read. The key is stored as a **hash**, not in
      plaintext, so a D1 dump does not yield working endpoints.
- [ ] ⚠️ **The key is not the whole credential for the generic source.** F74's HMAC is the
      authentication; the path key is the **routing and rate-limiting** identifier. Both are
      required. A leaked path key without the secret yields `401`, not a forged event.
- [ ] An unknown key returns **`404` with an identical body and timing profile to a known key
      with no access** — no distinguishing "no such endpoint" response (F26's cross-tenant
      rule).
- [ ] Rotation: a connection may hold **two** live keys. Rotation creates the new key, shows
      it, and the old key is revoked by an explicit action or after a configurable overlap
      (default 24 h). Both keys map to the same `connectionid`, so rotation is invisible
      upstream.
- [ ] Revocation is immediate and is an audited action (F28).
- [ ] The key is **per connection**, not per workspace. A customer with three Stripe
      endpoints has three keys, so revoking one does not break the others.

**Schema**
```sql
-- F76. One row per live path key. `key_hash` is SHA-256(key) with an orgid-scoped
-- salt so a hash from one workspace cannot be tested against another. The plaintext
-- key exists exactly once, in the wizard response, and is never stored.
CREATE TABLE ingress_keys (
  orgid         TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  connectionid  TEXT NOT NULL,
  source_id     TEXT NOT NULL,                 -- 'generic' | 'cloudflare' | 'stripe' | …
  key_hash      BLOB NOT NULL,                 -- full 256-bit digest, never truncated
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,                       -- overlap window end; NULL = live
  revoked_at    INTEGER,
  PRIMARY KEY (orgid, key_hash)
);
CREATE INDEX ingress_keys_connection ON ingress_keys(orgid, connectionid);
-- Deliberately NOT indexed on a tenant-supplied workspace slug, org name or
-- sequential id: those are guessable and would defeat the entire feature.
```

**Design** — This is the structural fix for D3. Today's code resolves the tenant from
`event.repository.full_name` — a field in the request body, i.e. chosen by the sender. For
sources with no installation model (generic, Cloudflare Alerts) there *is* no verified
identifier in the payload at all, so the endpoint itself must carry the tenant. Putting the
tenant in the path rather than a query string also keeps it out of the `Referer` of any page
linked from the destination side.

A path key is a real capability and we say so in the UI. It is not authentication. Every
source in this file still verifies a secret (F74, F81, F84, F87) or an explicit token (F90).
What the path key buys is that an attacker with no secret cannot even *reach* a tenant lookup
they can flood.

**Errors**
| Condition | Behaviour |
|---|---|
| Unknown or revoked path key | `404`, indistinguishable body |
| Known key, bad signature/token | `401` |
| Known key, connection disabled | `410 Gone` — the spec: *"an indication by the server that it's no longer interested… Sender should disable the webhook endpoint, and stop sending it messages"* |
| Connection deleted | key row deleted; `410` for a further grace period, then `404` |

**Security** — key lookup is constant-work regardless of hit/miss; no timing oracle on key
existence. Keys are redacted by F12's denylist because they are indistinguishable from
secrets to a log scanner. Rate limiting (F29) is keyed on the resolved `connectionid`, so an
unknown key is rate-limited on a bucket keyed by its own hash rather than being unlimited.

**Tests**
- `tenant_is_resolved_from_the_path_key_and_never_from_the_body`
- `path_key_has_at_least_128_bits_of_entropy`
- `path_key_is_stored_hashed_not_plaintext`
- `unknown_key_and_forbidden_access_are_indistinguishable`
- `rotation_keeps_both_keys_routable_during_the_overlap_window`
- `revoked_key_is_rejected_immediately`
- `keys_are_per_connection_not_per_workspace`
- `disabled_connection_returns_410_gone`

**Deps** — F26, F29, F98.

---

## F77 — Zero-downtime secret rotation

**Priority** P0 · **Status** partly implemented: cutover only (slice 10a)

**Story** As a customer whose signing secret leaked, I want to rotate without losing events,
so that I never have to choose between a compromised credential and a broken integration.

**Acceptance**
- [ ] A connection holds a **set** of active secrets, not one. At most two are permitted.
- [ ] Verification tries every active secret and accepts if **any** produces a matching
      signature. The spec's rationale is quoted in F74 and applies here.
- [ ] The rotation wizard: generate → show once → "the producer is now signing with the new
      secret" confirmation → customer updates the producer → confirm a delivery verifies with
      the new secret → revoke the old secret. The wizard **cannot** revoke before the
      confirmation step.
- [ ] Revocation is explicit, audited and immediate; it affects **the next request**, not the
      next event batch (F97's rule, applied to sources).
- [ ] ⚠️ **Not every producer supports multi-signature output.**
      - Standard Webhooks producers: yes by design.
      - GitLab: the header *"might contain multiple space-separated signatures. GitLab
        currently sends one signature, but this might change in the future."* → GitLab
        rotation is therefore **cutover, not zero-downtime**, and the wizard must say so.
      - Stripe: yes, but only during a secret roll. *"Stripe generates one signature per
        secret until expiration"*, and expiry can be delayed *"up to 24 hours"*. → Stripe
        rotation **is** zero-downtime for up to 24 h.
      - Linear: one secret per webhook; the docs describe no dual-secret window. ⚠️
        **UNVERIFIED — check whether Linear supports an overlap.** Until confirmed, Linear
        rotation is cutover and the wizard says *"expect a brief delivery gap"*.
- [ ] Every verification attempt records `secret_id_used` (an opaque row id, never the secret)
      so a rotation can be verified after the fact.
- [ ] The spec's warning against key reuse applies: secrets are never shared across
      connections, even for the same customer.

**Schema**
```ts
// F77. Ciphertext is bound to its row via AAD (F36) so a secret cannot be moved
// between connections. `supports_dual_signature` is a property of the PRODUCER,
// read from the connector's own verification, and it decides whether the wizard
// offers zero-downtime rotation or an honest cutover.
export type SourceSecretRow = {
  readonly id: string;
  readonly orgid: string;
  readonly connectionid: string;
  readonly ciphertext: string;      // whsec_-prefixed, base64 — encrypted before D1
  readonly keyVersion: number;
  readonly createdAt: number;
  readonly revokedAt: number | null;
  readonly state: 'active' | 'overlap' | 'revoked';
};
export type SourceAuthMode =
  | 'standard_webhooks_v1'   // F74 — base64-decode the whsec_ key
  | 'standard_webhooks_v1a'  // declared unsupported, never accepted
  | 'gitlab_signing_token'   // F81 — same core as standard_webhooks_v1
  | 'gitlab_secret_token'    // F81 — weaker, constant-time plaintext compare
  | 'stripe'                 // F84 — whsec_ used as a string, NOT base64-decoded
  | 'linear'                 // F87 — hex HMAC over the body only
  | 'static_bearer';         // F90 — cf-webhook-auth, no body integrity
export type SourceConnection = {
  readonly authMode: SourceAuthMode;
  readonly supportsDualSignature: boolean;
  readonly toleranceSeconds: number;   // 300 generic/gitlab/stripe, 60 linear
  readonly providerIdStability: 'spec-guaranteed' | 'observed-only' | 'unknown';
};
```

**Design** — The distinction between *multi-signature producers* and *single-signature
producers* is the difference between a zero-downtime rotation and a service incident, and it
is not visible anywhere in the provider's UI. Making it an explicit property of the connection
(`supportsDualSignature: boolean`) lets the wizard set the customer's expectation before they
generate anything, rather than after the gap.

We never rotate on the customer's behalf. A rotation is a customer-initiated action with a
generated value, because a secret we generated and re-displayed after compromise is not a
rotation.

**Errors**
| Condition | Behaviour |
|---|---|
| No active secret | Connection is `unverified`; nothing is routed |
| Verification fails against all active secrets | `401` + audit, secret ids never logged |
| Second rotation attempted while two are active | Rejected: revoke first |
| Producer sends a single signature during a dual-secret window | Fails until the producer is updated; the wizard warns in advance |

**Security** — secrets are encrypted at rest with `key_version` and AAD bound to the
connection row (F36, F97), so a ciphertext cannot be moved between connections. Old secret
material is destroyed on revoke, not merely disabled.

**Tests**
- `any_active_secret_can_verify_a_delivery`
- `revocation_takes_effect_on_the_next_request`
- `rotation_wizard_blocks_revocation_before_producer_confirmation`
- `single_signature_producers_are_labelled_cutover_in_the_wizard`
- `verification_records_secret_id_and_never_the_secret`
- `secrets_are_never_shared_between_connections`

**Deps** — F74, F76, F97, F36.

---

## F78 — Generic source mapping and schema contract

**Priority** P0 · **Status** partly implemented: fixed envelope, no mapping (slice 10a)

**Story** As a user with an internal system, I want to map a JSON payload onto Noti's event
model without writing code, so that my deploy tool can page my team.

**Acceptance**
- [ ] The generic source normalizes to the canonical envelope (F41) with **no provider-specific
      passthrough**. The customer maps fields; we never render a raw provider body.
- [ ] The mapping is a **declared, validated mapping** stored per connection (see **Schema**).
- [ ] A path that resolves to a non-scalar, exceeds the depth limit (8 segments) or exceeds
  the total mapped bytes (8 KiB of the envelope budget, F45) is a **save-time** rejection, not
  a delivery-time surprise.
- [ ] The payload must be a JSON **object** at the top level. Arrays and scalars are rejected
      with an explanation.
- [ ] The spec's own guidance is adopted as the size policy: *"it's recommended to keep the
      size of payloads small, usually smaller than 20kb"* — our ingress cap for this source is
      **1 MiB hard** (F63's replacement for the D15 magic number) with a **64 KiB** soft
      warning, and over-cap is `413` → `payload_too_large`, permanent.
- [ ] ⚠️ **Non-JSON and form-encoded bodies are not supported.** The spec says JSON *"for
      maximum compatibility, but other content types can be used as well"* — we accept only
      `application/json` and `application/cloudevents+json`, and return `415` otherwise.
      Supporting arbitrary content types would put an XML/XXE surface in front of a routing
      decision.
- [ ] Unknown fields are preserved in `data.extra`, capped, and **never rendered** (F48).
- [ ] A CloudEvents-shaped Standard Webhooks payload (`type` / `timestamp` / `data`) is
      **detected and used directly** when present — the spec's recommended payload structure —
      so a producer already following the spec needs no mapping at all. `type` is
      full-stop delimited per the spec and is resolved against the closed catalog (F42).
- [ ] `adapterVersion` is recorded per event (F62's rule) so a mapping change is replayable.

**Schema**
```ts
// F78 — the generic source's ONLY configuration surface.
// Stored as validated JSON on the connection row; re-validated on every update and
// at delivery. Adding an expression evaluator to this type would require changing
// it, not extending it — that is the design intent, not an accident.
export interface GenericMapping {
  readonly version: 1;
  readonly fields: {
    /** Required. A notification with no title is not sendable. */
    readonly title: string;        // dotted path, e.g. "data.repository.full_name"
    readonly url?: string;         // https: only, length-capped at render time
    readonly actor?: string;
    readonly branch?: string;
    readonly labels?: string[];    // max 20 entries, each ≤ 64 chars
    readonly body?: string;        // ≤ 2000 chars after truncation
  };
  /** Resolves to a single value and selects one canonical event type (F42). */
  readonly eventTypePath: string;
  readonly outcomePath?: string;   // mapped into the closed outcome enum (F44)
}

export interface GenericSourceLimits {
  readonly maxBodyBytes: 1048576;      // 1 MiB hard; 413 beyond, permanent (F63)
  readonly softWarnBodyBytes: 65536;  // Standard Webhooks recommends "smaller than 20kb"
  readonly maxPathDepth: 8;
  readonly maxMappedBytes: 8192;       // of the envelope budget (F45)
  readonly allowedContentTypes: readonly ['application/json', 'application/cloudevents+json'];
}
```

**Design** — A generic source with a free-form template language would be a Zapier clone and
is out of scope per `AGENTS.md`. A **declarative, bounded, validated field mapping** is not:
it has no evaluation, no loops and no code, and its output is schema-checked before it can be
stored. That is the entire line between "configurable" and "arbitrary code execution", and the
mapping type above is written so that adding an expression evaluator to it would require
changing the type, not extending it.The CloudEvents-shape detection matters for a product reason: a producer that already follows
Standard Webhooks has already made the decisions we would otherwise ask the customer to make
(type naming, timestamp semantics). Honouring it means zero-configuration onboarding for the
customers who are most likely to have the volume to care.

**Errors**
| Condition | Behaviour |
|---|---|
| Title path missing or resolves to empty | `400` at save; `schema_invalid` at delivery if it drifts |
| Non-object top level | `400`, explanation names the requirement |
| Unsupported content type | `415` |
| Path depth > 8 or mapped bytes > 8 KiB | `400` at save with the offending path named |
| Path crosses into `data.extra` | `400` at save |
| Unknown `type` from a CloudEvents-shaped payload | Stored as `unmapped:<raw>`, visible in the dashboard (F42) |
| Body over 1 MiB | `413`, permanent |

**Security** — mapped values are untrusted provider content and are length-capped,
control-character-rejected (F41) and escaped per destination (F94). A URL field is validated
as `https:` before it reaches a card link. No mapping field can name a destination, a
credential, or an organisation.

**Tests**
- `mapping_is_validated_at_save_time_not_at_delivery`
- `path_depth_and_byte_budget_are_enforced`
- `non_object_payloads_are_rejected_with_an_explanation`
- `unsupported_content_type_returns_415`
- `cloudevents_shaped_payload_requires_no_mapping`
- `unknown_cloudevents_type_is_stored_as_unmapped_and_surfaced`
- `mapped_values_are_length_capped_and_never_rendered_raw`
- `oversize_body_returns_413_and_is_never_retried`

**Deps** — F41, F42, F44, F45, F48, F63.

---

## F79 — Fixture corpus gate

**Priority** P0 · **Status** partly implemented (slice 10a) · **Fixes** part of D13

**Story** As a maintainer, I want a real captured payload per source and per event type, so
that an upstream change breaks a test instead of a customer's channel.

**Acceptance**
- [ ] One fixture **per source per event type**, captured from a real delivery, sanitized,
      committed, and stamped with its capture date and the adapter version that parsed it.
- [ ] This extends F72 (GitHub fixtures) to every source; the GitHub machinery is reused, not
      rebuilt.
- [ ] Replay asserts the full chain: `verify` → `parse` → `normalize` → `render`, for **every
      registered destination** (F91). A source is not "supported" until a fixture exists for
      every destination it claims to render to.
- [ ] **Signature fixtures must include the secret and the exact headers**, or the fixture
      cannot exercise the verifier. Secrets are the *only* thing in the repo that may be a
      literal, and they are the fixture's own synthetic secret, never a provider-issued one.
- [ ] A fixture that no longer parses is a **CI failure**, never a skip.
- [ ] Minimum fixture set per source:

| Source | Minimum fixtures |
|---|---|
| Generic | CloudEvents-shaped; flat object; deeply nested; array-at-root (rejected); empty object; unicode; `webhook-id` containing `.`; dual-signature header; body over cap |
| GitLab | `Push Hook`, `Tag Push Hook`, `Merge Request Hook` (open/update/merge), `Issue Hook`, `Note Hook`, `Pipeline Hook`; `[REDACTED]` email case; 20-commit cap case |
| Stripe | snapshot `payment_intent.succeeded`; thin `v1.core.account.updated`; rolled-secret header with two `v1=` entries; `v0=` decoy present |
| Linear | `Issue` create/update/remove; `Comment`; `OAuthApp revoked`; deleted-actor (`actor: null`) |
| Sentry | **no webhook fixtures** — pull-based; fixtures are API response bodies captured from `docs.sentry.io`-documented endpoints (F89) |
| Cloudflare Alerts | `ALERT_STATE_EVENT_START`; `ALERT_STATE_EVENT_END`; payload with `account_id`/`policy_id`/`alert_type` absent; `data` shapes for two alert types |

- [ ] A CI check greps the fixture tree for the F12 denylist. Real emails, real repository
      names, real tokens and real webhook URLs are all rejected at commit time.
- [ ] Capture is a documented manual procedure with a sanitization checklist, because these
      files contain real content and PII by construction.

**Design** — This is the only mechanism that converts "the provider changed" from a customer
incident into a red build. The provider-facing risk is documented for every provider in this
industry; GitHub's own words are *"GitHub continues to add new event types and new actions to
existing event types"* and the Standard Webhooks payload section makes the same point about
event types being a compatibility surface.

The failure mode this prevents is subtle and worth naming: a fixture suite that **skips**
fixtures it cannot parse degrades from a safety net into decoration within one release cycle.
Skips are a CI failure here, not a warning.

**Errors**
| Condition | Behaviour |
|---|---|
| Fixture fails to verify against the documented scheme | CI failure, named fixture in the log |
| Fixture normalizes differently from the recorded expectation | CI failure with a canonical-envelope diff |
| Fixture file contains a denylisted pattern | CI failure, file and line named |
| Source registered without a fixture per destination | Registration fails its conformance suite |

**Security** — fixtures are sanitized before commit, not before test. A raw capture that
reaches `git` is already leaked, so the guard is a pre-commit/CI grep, and the procedure
documents that the working copy is as sensitive as the repository.

**Tests**
- `every_source_has_a_fixture_per_event_type`
- `every_source_renders_to_every_registered_destination_in_fixtures`
- `skipped_fixtures_fail_ci_rather_than_being_tolerated`
- `fixtures_contain_no_denylisted_secrets_or_pii`
- `fixtures_record_capture_date_and_adapter_version`

**Deps** — F12, F71, F72, F91.

---

## F80 — Source onboarding wizard

**Priority** P0 · **Status** partly implemented: Sources page only (slice 10a)

**Story** As a non-technical administrator, I want a wizard that gets me from "connect
GitLab" to a working notification in minutes, so that I never have to read a webhook
provider's documentation.

**Acceptance**
- [ ] Steps, in order, for **every** source: connect → authorise → configure → select events
      → choose destinations → **send a test** → done.
- [ ] **Send a test is a step, not an afterthought.** It runs the real renderer and the real
      `send` through the real pipeline (F98), is excluded from statistics and billing, and
      reports the classified taxonomy code in plain language.
- [ ] Each step renders from `capabilities()` (F71). A source cannot show a step it cannot
      perform.
- [ ] Provider-specific instructions carry the provider's own wording, including the
      uncomfortable parts:
      - GitLab: *"For new webhooks, use a signing token instead of a secret token… The secret
        token is not recommended for new webhooks."* The wizard's **default** is the signing
        token; `X-Gitlab-Token` is offered as a labelled fallback with its weaker guarantee
        stated inline.
      - GitLab: creating a webhook requires **Maintainer or Owner** for a project and
        **Owner** for a group. The wizard says so before the user is sent to GitLab.
      - Linear: *"Only workspace admins, or OAuth applications with the `admin` scope, can
        create or read webhooks."*
      - Cloudflare Alerts: the secret is a **static bearer token with no body integrity**, and
        the wizard says exactly that (F90).
      - Sentry: the wizard does not offer a webhook at all (F89).
- [ ] Every wizard step is keyboard-navigable, has visible focus, meets WCAG 2.2 AA contrast,
      and reflows to 320 px. Control hit targets ≥ 44 px, body text ≥ 16 px.
- [ ] Every string is translatable from day one; no user-facing string is concatenated into
      a sentence from a provider's error message.
- [ ] Abandoning the wizard leaves **no** half-created credential. The connection row, its
      secret and its path key are created only at the final commit, or are cleaned up by a
      scheduled job with a documented TTL.
- [ ] The wizard shows, in the customer's own words, what we hold: the signing secret is
      stored encrypted, shown once, rotatable, and revokable; the path key is a capability.

**Design** — `docs/PRODUCT.md` sets a ≥80% first-delivery-without-help target, and the only
lever that moves it is removing decisions from the user. The wizard's job is to make the
correct choice the default and to state the trade-off in one sentence rather than hiding it.

The GitLab case is the template for the whole file: GitLab itself documents that the secret
token *"offers weaker guarantees"* and is *"not recommended for new webhooks"*. Most tools
present both options neutrally and let the customer pick the weaker one. Ours defaults to the
stronger one, shows the weaker one as a labelled fallback with the reason, and records which
one the customer chose on the connection so the delivery log can later say *"this connection
is authenticated with the weaker scheme"*.

Abandonment cleanup is the feature most wizards skip and most support tickets are about. A
user who copies a secret, closes the tab, and comes back in a week must not find a live
credential they cannot see.

**Errors**
| Condition | Behaviour |
|---|---|
| Test delivery fails | Wizard stops at that step with the taxonomy code and a plain-language cause; the connection is saved `unverified` |
| Customer lacks the provider role | Stated up front; the wizard does not dead-end silently |
| Customer selects a weaker auth scheme | Allowed, recorded on the connection, and labelled in the delivery log |
| Wizard abandoned | No credential exists; any provisional row expires on the documented TTL |
| Provider capability changes | Wizard step becomes unavailable with an explanation, never a broken control |

**Security** — secrets are revealed exactly once, in a focus-managed dialog with an explicit
user action; they are never placed in the clipboard automatically, never logged, never sent to
analytics, and never included in a support-bundle export (F30's export omits credentials).

**Tests**
- `wizard_produces_a_first_delivery_without_leaving_the_flow`
- `test_delivery_uses_the_real_renderer_and_send_path`
- `wizard_step_availability_is_derived_from_capabilities`
- `gitlab_secret_token_is_offered_as_a_labelled_fallback_not_the_default`
- `weaker_auth_choice_is_recorded_and_surfaced_in_the_delivery_log`
- `abandoned_wizard_leaves_no_live_credential`
- `wizard_is_keyboard_navigable_and_reflows_to_320px`
- `provider_role_requirements_are_stated_before_the_user_leaves_the_app`

**Deps** — F71, F91, F98, F216.

---

## F81 — GitLab signature verification

**Priority** P1 · **Status** partly implemented: GitLab.com, one credential per source (slice 10b)

**Story** As a GitLab customer, I want my GitLab webhook verified against the documented
scheme, so that a forged event cannot enter my workspace.

**Acceptance**
- [ ] **Primary: the signing token.** GA in GitLab 19.1 (introduced 19.0 behind
      `webhook_signing_token`, feature flag removed in 19.1). Headers `webhook-id`,
      `webhook-timestamp`, `webhook-signature`. The signature is
      `HMAC-SHA256` over `{message_id}.{timestamp}.{body}`, base64-encoded, scheme `v1`,
      space-separated list — *"GitLab delivery follows the Standard Webhooks
      specification."*
  - **This is F74's verifier with a different header name.** One implementation, two header
      maps. The `whsec_` → base64-decode rule, the `.`-in-id rejection, the unknown-scheme
      rule and the constant-time compare are identical and shared.
- [ ] **Fallback: `X-Gitlab-Token`**, a plain-text secret compared in constant time. GitLab's
      own text: it *"is sent as plain text in the `X-Gitlab-Token` HTTP header and provides
      weaker security guarantees than a signing token."* When both are configured we
      **require the signature and ignore the token**; we only fall back when
      `webhook-signature` is absent.
- [ ] ⚠️ **Order matters and is asserted in a test.** GitLab documents the migration path as
      *"verify the signature when `webhook-signature` is present and fall back to the secret
      token otherwise"*. Accepting the token when a signature is present lets an attacker who
      learns only the token bypass the stronger scheme.
- [ ] **`X-Gitlab-Instance` is recorded and, for connections marked `gitlab.com`, enforced.**
      A self-managed GitLab is a separate connection with its own secret and its own key; an
      instance hostname is attacker-controlled on a self-managed deployment, so it is
      **recorded for diagnostics and used for routing only as a connection-level match, never
      as an authorization input**.
- [ ] `Idempotency-Key` and `webhook-id` are documented as equal. We read `webhook-id` and
      treat `Idempotency-Key` as a corroborating value; if they disagree on a given delivery
      we record a drift metric, because that would mean a producer-side change.
- [ ] `X-Gitlab-Event-UUID` is stored but **not used for dedup**: it is documented as
      *"Unique ID for non-recursive webhooks. Recursive webhooks (triggered by earlier
      webhooks) share the same value"*, so it is not a per-event identity.
- [ ] The 5-minute tolerance (F75) applies.
- [ ] GitLab's own receiver guidance is adopted as our send policy: *"Respond quickly with a
      `200` or `201` status… Avoid processing webhooks in the same request… Respond before the
      timeout limit to prevent automatic disabling on GitLab.com."* GitLab.com's documented
      webhook timeout is **10 seconds**, identical to GitHub's, so F64's ack discipline
      applies unchanged.

**Design** — GitLab is the strongest case for a single verification core: its scheme *is*
Standard Webhooks, so F74 is reused verbatim and there is no bespoke GitLab crypto to
maintain. The only GitLab-specific surface is the `X-Gitlab-Token` fallback, which exists
because webhooks created before 19.0 have no signing token and customers cannot always
recreate them.

That fallback is also the reason for the ordering rule above. A naive implementation that
accepts either credential "when both are present" is strictly weaker than either credential
alone.

**Errors**
| Condition | Behaviour |
|---|---|
| Signature present, invalid | `401` — the token is **not** tried |
| Signature absent, token present and matching | Accepted, connection flagged `auth: secret_token` |
| Signature absent, token absent | `401` |
| `X-Gitlab-Event` missing or unrecognised | `400` `schema_invalid` (F50) |
| `X-Gitlab-Instance` mismatches the connection's instance | `401` + audit |
| Non-JSON body | `400` |

**Security** — the signing token is *"never returned by the API"* per GitLab, so it can only
be captured at creation; the wizard therefore **collects it from the customer** and never
tries to fetch it. It is encrypted at rest and revealed once. The secret-token connection mode
is surfaced in the delivery log as a standing security note, so a customer who has never
migrated knows why their integration is weaker than the one next to it.

**Tests**
- `gitlab_signing_token_verifies_with_the_shared_standard_webhooks_core`
- `gitlab_secret_token_fallback_only_applies_when_the_signature_is_absent`
- `invalid_signature_is_not_rescued_by_a_valid_secret_token`
- `whsec_prefixed_token_is_base64_decoded_before_hmac`
- `gitlab_event_uuid_is_not_used_as_dedup_identity`
- `idempotency_key_disagreement_raises_a_drift_metric`
- `gitlab_receiver_acknowledges_within_the_10s_timeout`
- `secret_token_mode_is_surfaced_in_the_delivery_log`

**Deps** — F74, F75, F80.

---

## F82 — GitLab lifecycle, auto-disable and limits

**Priority** P1 · **Status** partly implemented: floods absorbed with 2xx; no health model (slice 10b)

**Story** As a GitLab customer, I want to know when GitLab has stopped sending me events, so
that a silent outage does not look like "nothing happened".

**Acceptance**
- [ ] ⚠️ **GitLab auto-disables. This is documented, and it is the reason this source needs its
      own health model.**
  - *"GitLab automatically disables project or group webhooks that fail four consecutive
    times."*
  - **4 consecutive failures → Temporarily disabled**: *"initially disabled for one minute,
    with the duration extending on subsequent failures up to 24 hours. After this period has
    elapsed, these webhooks are automatically re-enabled."*
  - **40 consecutive failures → permanently Disabled**: *"Unlike temporarily disabled
    webhooks, these webhooks are not automatically re-enabled."*
  - Re-enable is **customer action**: *"To re-enable a disabled webhook, send a test request.
    The webhook is re-enabled if the test request returns a response code in the `2xx` range."*
- [ ] A failure is counted when *"The webhook receiver returns a response code in the `4xx` or
      `5xx` range"* or on connect timeout or other HTTP error.
- [ ] ⚠️ **Consequence for our response codes, and a real conflict.** F50 specifies `429` +
      `Retry-After` for rate limiting. For GitLab, a `429` **counts toward the four
      consecutive failures that disable the webhook.** The connection therefore defaults to
      **`202`/`200` with durable acceptance** and only returns `429` under a connection-level
      setting the customer must explicitly enable, with the consequence stated in the UI.
- [ ] **Namespace rate limits (GitLab.com, verified).** *"The number of times each minute that
      webhooks in a top-level namespace can be called. All project and group webhooks in the
      namespace share this limit."*

| Plan | Calls/min |
|---|---|
| GitLab Free | **500** |
| GitLab Premium, ≤99 seats | 1,600 |
| GitLab Premium, 100–399 seats | 2,800 |
| GitLab Premium, 400+ seats | 4,000 |
| GitLab Ultimate / open source, ≤999 seats | 6,000 |
| GitLab Ultimate / open source, 1,000–4,999 seats | 9,000 |
| GitLab Ultimate / open source, 5,000+ seats | 13,000 |

  - *"When the rate limit is reached, all webhooks in the namespace are temporarily disabled
    and automatically re-enabled in the next minute."* → **one noisy project can starve every
    other project in the same namespace**, and we cannot observe it from the webhook stream.
  - The connection stores the customer's plan tier and shows the applicable ceiling. Where
    the namespace rate limit has been hit (detectable only by the customer's GitLab UI, which
    we do not poll), the dashboard carries a standing note.
- [ ] Other GitLab.com limits recorded and displayed: **100 webhooks per project, 50 per
      group** (subgroup webhooks do not count against the parent), **maximum payload size
      25 MB**, **timeout 10 seconds**.
- [ ] Connection health surfaces the disabled states **even though we cannot observe them**:
      the UI shows a prominent "GitLab may have disabled this webhook — check GitLab" prompt
      whenever the connection has had no successful delivery for a configurable window
      (default 72 h), because that is the only signal available.
- [ ] A delivery **audit event** (F28) is written when we permanently stop retrying a
      connection for auth reasons, because after 40 failures GitLab has already stopped and
      retrying on our side achieves nothing.
- [ ] The 10-second GitLab timeout is a hard budget: the handler performs verify → resolve →
      dedup → one D1 batch → ack. No outbound calls, ever (F64).

**Schema**
```sql
-- F82. We cannot observe GitLab's disable state, so we model the two states we CAN
-- infer and always show the one we cannot. `provider_state_known` is the honest bit.
ALTER TABLE ingress_connections ADD COLUMN gitlab_plan_tier TEXT;   -- free|premium|ultimate
ALTER TABLE ingress_connections ADD COLUMN namespace_rate_limit_per_min INTEGER;
ALTER TABLE ingress_connections ADD COLUMN last_success_at INTEGER;

CREATE TABLE provider_disable_inference (
  connectionid  TEXT PRIMARY KEY REFERENCES ingress_connections(id) ON DELETE CASCADE,
  provider_state_known INTEGER NOT NULL DEFAULT 0,  -- 0 for GitLab: we cannot observe it
  consecutive_permanent_failures INTEGER NOT NULL DEFAULT 0,
  idle_threshold_seconds INTEGER NOT NULL DEFAULT 259200, -- 72 h, the only signal available
  last_prompted_at INTEGER
);
```

**Design** — GitLab is the clearest illustration of why a source cannot simply inherit F50's
response table. The generic advice "return 429 when rate limited" is actively harmful here,
because GitLab counts 4xx as a delivery failure and disables the endpoint after four of them.
The safe default for a provider with auto-disable is **absorb and buffer**, and to tell the
customer we are absorbing.

The second consequence is that **GitLab can lose our events permanently and tell nobody**.
Unlike GitHub, which at least records failed deliveries for three days, GitLab's disable is
silent to us: there is no delivery log API on a customer-managed project webhook. The only
defence is (a) never fail the endpoint, and (b) tell the human when deliveries go quiet. That
is why the "no successful delivery in 72 h" prompt is a required feature rather than a
nice-to-have, even though it is inferential.

**Errors**
| Condition | Behaviour |
|---|---|
| Our response would be 4xx/5xx | Design the handler so this cannot happen under load; `429` is opt-in per connection |
| Connection idle beyond the threshold | Dashboard prompt naming the GitLab disable behaviour |
| Auth failing repeatedly | Stop retrying, audit, surface "GitLab has likely disabled this webhook" |
| Namespace rate limit hit | Standing note with the applicable plan ceiling |
| GitLab sends a body over 25 MB | Impossible in practice; the 1 MiB ingress cap rejects first with `413` |

**Security** — the connection stores the GitLab instance hostname and distinguishes
gitlab.com from self-managed, because a self-managed instance is a different trust domain
with different egress and different rate limits. No GitLab credential is a *write* credential:
webhook configuration requires Maintainer/Owner on the customer's side, and we never request
a GitLab personal access token for this source.

**Tests**
- `gitlab_four_consecutive_failures_disable_the_webhook_and_the_ui_says_so`
- `four_one_consecutive_failures_permanently_disable_and_are_not_auto_reenabled`
- `a_429_from_us_counts_toward_gitlas_disable_threshold`
- `rate_limited_ingress_defaults_to_accepting_for_gitlab`
- `namespace_rate_limit_ceiling_is_stored_and_displayed_per_plan`
- `idle_connection_surfaces_a_gitlab_disable_warning`
- `handler_acknowledges_within_the_10_second_gitlab_timeout`
- `self_managed_gitlab_is_a_distinct_connection_from_gitlab_com`

**Deps** — F64, F65, F80, F98.

---

## F83 — GitLab event catalog and silent drops

**Priority** P1 · **Status** partly implemented: 11-type catalogue (slice 10b)

**Story** As a GitLab customer, I want a finite list of GitLab events mapped onto Noti's
model, so that my filter list is the same shape as my GitHub one.

**Acceptance**
- [ ] V1 subscribes to the GitLab event set that maps cleanly onto the closed catalog (F42):
      `Push Hook`, `Tag Push Hook`, `Merge Request Hook`, `Issue Hook`, `Note Hook`,
      `Pipeline Hook`, `Job Hook`, `Release Hook`, `Wiki Page Hook`, `Milestone Hook`,
      `Emoji Hook`. Group-only events (`Group Member Hook`, `Project Hook`, `Subgroup Hook`)
      are **P2** and are declared as such rather than silently absent.
- [ ] `X-Gitlab-Event` (`"<EVENT> Hook"`) is the classification input; the **action** comes
      from the **body** (`object_attributes.action`), never from the header. GitLab's MR
      actions are `open | close | reopen | update | approval | approved | unapproval |
      unapproved | merge`, and they map onto F44's state model with `merge` as the
      resolution of the earlier `open`.
- [ ] ⚠️ **The action is not always the interesting fact.** GitLab documents that *"Merge
      request events can be triggered even if the `changes` field is empty"* and *"Webhook
      receivers should always inspect the content of the `changes` field for the actual
      changes"*. `update` therefore has **no single canonical type**; it is normalized as
      `pull_request.updated` with `changes` keys preserved in `data.extra`, and rules may
      filter on them.
- [ ] ⚠️ **Silent-drop semantics — these are invisible to us and must be documented as such:**

| Condition | GitLab behaviour | Ours |
|---|---|---|
| Push touching more than **3** branches or tags (default `push_event_hooks_limit`) | *"Behavior when exceeded: No webhooks are triggered for the entire push event."* | We receive nothing. Reconciliation is impossible from the webhook stream. Surfaced as a standing connection note when pushes are quiet but events are expected. |
| Push of more than **20** commits at once | `commits` contains the newest 20 only; `total_commits_count` holds the real number | `data.extra.truncated = true` with the dropped count (F63's rule) |
| Push with no new commits | `commits: []` | Normal, not an error |
| Push of tags | *"Push events are triggered… except when: You push tags."* | Delivered as `Tag Push Hook` |
| Author without a public email | `"email": "[REDACTED]"` | Preserved verbatim; never treated as a missing field |
| Webhooks triggered by **blocked users** | *"Pipeline webhooks triggered by blocked users are not processed."* | Documented gap; cannot be detected |

- [ ] ⚠️ `object_attributes.assignee_id` and `assignee_ids` are documented as **deprecated**
      (first assignee only) and `work_in_processing` is deprecated in favour of `draft`. The
      normalizer reads the documented replacements and preserves the deprecated fields in
      `data.extra` for customers who still filter on them.
- [ ] `[REDACTED]` is a **literal GitLab value**, not our redaction. It is preserved so that
      F102's Lark DLP redaction is distinguishable from GitLab's own privacy behaviour in the
      delivery log.
- [ ] Every payload field is length-capped and escaped per destination (F94).
- [ ] `adapterVersion` recorded per event (F62).

**Design** — GitLab's push limits are the same class of problem as GitHub's 25 MB silent drop
(F63): the event simply does not exist at our end, and no amount of correctness downstream
recovers it. The honest engineering response is not a workaround but a **visible statement**:
the connection carries a note explaining the 3-branch limit and pointing at
`push_event_hooks_limit`, so a customer whose notifications go quiet can find the cause in
our product rather than filing a ticket.

Normalizing `update` without inventing a type is deliberate. F42's closed catalog exists so
the UI is enumerable; a payload that legitimately carries a heterogeneous change set must be
represented, not forced into a fake type that a customer then has to special-case.

**Errors**
| Condition | Behaviour |
|---|---|
| Unknown `X-Gitlab-Event` | Stored as `unmapped:<raw>`, visible in the dashboard, never rejected |
| Unknown `object_attributes.action` | Preserved; `data.outcome` stays `neutral` |
| `changes` empty on an `update` | Normal, not an error |
| `[REDACTED]` email | Preserved literally |
| Body over cap | `413`, permanent |

**Security** — GitLab payloads contain `user_email` and commit author emails. These are
personal data; F51's raw-body retention applies, F102's Lark DLP redaction applies, and the
normalizer never places a raw email into `data.actor` — it goes to `data.extra`, which is
never rendered.

**Tests**
- `gitlab_event_catalog_normalizes_deterministically`
- `gitlab_merge_is_a_resolution_of_the_open_pull_request`
- `gitlab_update_action_preserves_the_changes_key_set`
- `gitlab_deprecated_assignee_fields_are_preserved_in_extra`
- `gitlab_redacted_email_is_preserved_verbatim`
- `gitlab_push_commit_cap_sets_truncated_with_the_dropped_count`
- `gitlab_push_with_zero_commits_is_not_an_error`
- `gitlab_silent_drop_limit_is_documented_on_the_connection`
- `unknown_gitlab_event_is_surfaced_not_rejected`

**Deps** — F42, F44, F48, F62, F63, F94, F102.

---

## F84 — Stripe signature verification

**Priority** P1 · **Status** partly implemented: snapshot events (slice 10b)

**Story** As a Stripe customer, I want Stripe events verified exactly as Stripe documents
them, so that a forged `invoice.paid` cannot mark an invoice as settled.

**Acceptance**
- [ ] `Stripe-Signature` is parsed as comma-separated `prefix=value` elements. `t` is the
      unix-seconds timestamp; each `v1` is a hex HMAC-SHA256.
- [ ] **All schemes other than `v1` are ignored.** Stripe's exact instruction: *"To prevent
      downgrade attacks, ignore all schemes that aren't `v1`."* Stripe deliberately sends a
      `v0` decoy on test events — a verifier that accepts any scheme accepts the decoy.
- [ ] `signed_payload = t + "." + rawBody`. The raw body is used **verbatim**; Stripe: *"Stripe
      requires the raw body of the request to perform signature verification… Any
      manipulation to the raw body of the request causes the verification to fail."*
- [ ] The `whsec_` signing secret is used as the HMAC key **as a string**, not base64-decoded.
      ⚠️ **This is the opposite of the Standard Webhooks rule (F74) and the difference is
      real.** Stripe and Standard Webhooks both prefix `whsec_`, and a shared verifier that
      base64-decodes for both will fail every Stripe delivery. This is asserted by a test that
      runs the *same* payload through both verifiers and expects opposite key treatment.
- [ ] Tolerance is **5 minutes**, Stripe's library default. Stripe documents the value *and*
      the footgun: *"Don't use a tolerance value of `0`."* Configurable per connection, not
      to zero.
- [ ] Comparison is constant-time against each candidate signature in the header.
- [ ] **Multiple `v1` entries are supported.** Stripe: *"You can have multiple signatures with
      the same scheme-secret pair when you roll an endpoint's secret… keep the previous secret
      active for up to 24 hours… Stripe generates one signature for each secret."* Our
      multi-secret verifier (F77) is therefore directly usable, with a 24-hour ceiling on the
      overlap window.
- [ ] **The signature and timestamp are never identity.** Stripe: *"Stripe generates the
      timestamp and signature each time we send an event to your endpoint. If Stripe retries an
      event… then we generate a new signature and timestamp for the new delivery attempt."*
      A retry is a duplicate by `id` (F86) and **not** a new event because the signature
      differs.
- [ ] Secrets are **per endpoint, and per livemode**: *"If you use the same endpoint for both
      test and live API keys, the secret is different for each one."* Test and live are
      therefore separate connections with separate keys and separate vaults, never one
      connection with a mode toggle.
- [ ] `3xx` from our endpoint is a **failure** to Stripe: *"We consider redirect responses to
      webhook requests as failures."* Ingress therefore never redirects (F50).

**Design** — Stripe is the one source whose signing secret shares a prefix with
Standard Webhooks and behaves differently. That is worth stating bluntly in the code as well
as here, because the natural refactor — "extract a shared HMAC helper" — silently breaks every
Stripe delivery while breaking nothing in the generic source. The test in the acceptance list
exists specifically to make that refactor fail loudly.

The other Stripe-specific property that changes our data model is that **signature ≠
identity**, which F47 already flags and F86 turns into the two-level dedup design.

**Errors**
| Condition | Behaviour |
|---|---|
| No `Stripe-Signature` header | `401` |
| No `v1` element (only `v0`, or only `t`) | `401` |
| Signature mismatch on all candidates | `401` |
| `t` outside the 5-minute tolerance | `401`, `stale_timestamp` |
| `t` not `/^[0-9]{1,20}$/` | `401`, `timestamp_malformed` |
| Body is not JSON | `400` after verification succeeds |

**Security** — the signing secret is a **restricted or secret API key's** companion and is
treated at the same level as the GitHub App private key: encrypted, `key_version`-tagged,
never logged, never in an error, never in a test payload. Stripe recommends rolling
periodically *"or… when you suspect a compromised secret"*, which the wizard surfaces as a
reminder with a direct link to the rotation action.

**Tests**
- `stripe_signature_verifies_with_the_raw_body`
- `stripe_secret_is_used_as_a_string_not_base64_decoded`
- `same_payload_treated_differently_by_stripe_and_standard_webhooks_verifiers`
- `v0_decoy_scheme_is_ignored`
- `multiple_v1_entries_verify_during_a_secret_roll`
- `stale_timestamp_beyond_five_minutes_is_rejected`
- `zero_tolerance_is_rejected_at_configuration_time`
- `retried_delivery_with_new_signature_is_a_duplicate_by_event_id`
- `test_and_live_endpoints_are_separate_connections`
- `json_round_trip_of_the_body_fails_verification`

**Deps** — F04, F12, F36, F77.

---

## F85 — Stripe snapshot vs thin, and the enrichment budget

**Priority** P1 · **Status** not started

**Story** As a Stripe customer, I want to receive the event format I chose, so that a thin
payload does not silently arrive as an empty notification.

**Acceptance**
- [ ] The connection records `event_payload: 'snapshot' | 'thin'`, and the UI states the
      consequence in plain language *before* the customer configures it.
- [ ] **A thin notification carries only identifiers.** Stripe: the notification contains the
      event type, the event id, a timestamp and `related_object {id, type, url}` — and
      *"Changes"* and *"Data"* are explicitly **unsupported** in the notification.
- [ ] ⚠️ **A thin event without enrichment produces a notification with no title and no
      description.** A notification whose entire content is `payment_intent.succeeded` is not
      deliverable. Therefore a thin connection is **rejected at save time** unless enrichment
      is enabled (below).
- [ ] Enrichment is an explicit, budgeted, asynchronous read: `GET` the related object, run
      the renderer, deliver. It happens in the **consumer**, never in the ingress handler,
      which must acknowledge inside the provider's deadline.
- [ ] **The snapshot-staleness caveat is shown to the customer, not buried.** Stripe: *"The
      object in the event payload might be outdated by the time you process it"* and *"it can
      be stale by the time your application processes it."* A snapshot connection therefore
      carries a standing note: *"the payload reflects Stripe's state at event time, not now."*
- [ ] **`livemode` is a routing input.** The payload carries `"livemode": false`; a test-mode
      event must never be rendered into a customer's production channel. Test-mode events are
      routed to a connection flagged `livemode: false` and are excluded from statistics and
      billing.
- [ ] ⚠️ **Enrichment is rate-limited and can fail.** Stripe API calls are per-account; the
      budget is per connection, defaults to a small number, and is shown in the UI. A failed
      enrichment **degrades the notification** (renders the identifier-only form, flagged
      `enrichment_failed`) and never fails the delivery.
- [ ] Enrichment results are cached with a short TTL so a retry storm cannot fan out into an
      API storm. ⚠️ **UNVERIFIED — Stripe's REST API rate-limit headers and their exact
      semantics.** Check `docs.stripe.com/api/rate-limits` and record the actual headers
      before implementing the limiter; do not assume `X-RateLimit-*`.
- [ ] **Prefer thin, per Stripe's own recommendation** — *"For new integrations, use thin
      events"* — because they are unversioned and typed. Our default in the wizard is thin +
      enrichment; snapshot is offered as the "no extra API calls" option with its staleness
      caveat attached.
- [ ] **Event ordering is not assumed.** Stripe: *"Stripe doesn't guarantee the delivery of
      events in the order that they're generated."* Renderers and grouping must be
      order-independent, and F44's state model must tolerate an `invoice.paid` arriving before
      `invoice.created`.

**Design** — The thin-vs-snapshot decision is the only source-level decision in this file
that changes our architecture rather than our configuration. A thin connection **cannot** be
served by the default payload-only ingress path, because the ingress path has a hard rule
(F49): no outbound API calls. Rather than weakening that rule for one provider, thin events
are supported by making enrichment an explicit, budgeted, asynchronous stage. The consequence
is that a thin customer gets a notification whose *content* is fetched after acknowledgement —
which is also the only honest reading of Stripe's own warning that the payload is minimal.

Stripe's "out of order" guarantee interacts with the wedge: `workflow_run` → `check_run` on
GitHub is naturally ordered because GitHub redelivers nothing and our grouping window handles
it, but a Stripe `invoice.paid` followed by `invoice.payment_failed` arriving reversed would
produce two contradictory messages unless the state model (F44) is authoritative rather than
the arrival order. That assertion belongs in the Stripe fixture suite.

**Errors**
| Condition | Behaviour |
|---|---|
| Thin connection saved without enrichment enabled | `400` at save with the reason |
| Enrichment API call fails / rate limited | `enrichment_failed`, identifier-only render, delivery still attempted |
| Enrichment budget exhausted | Same as above, recorded |
| A `livemode: false` event arrives on a live connection | `401` — the connection's livemode must match the event's |
| Unknown `type` | `unmapped:<raw>`, visible, never rejected |
| Snapshot payload exceeds the envelope budget | `payload_too_large`, permanent |

**Security** — enrichment requests carry a restricted API key with `Read` on exactly the
resource families the customer selected; Stripe's own guidance is that a restricted key *"can
be granted `Read` access enabled for the specific event type's resource"*. The key is
encrypted, never enters an envelope or a queue body (F175/D5), and the enriched response is
treated as untrusted content like any payload. `livemode` mismatch is refused rather than
silently re-routed.

**Tests**
- `thin_event_without_enrichment_is_rejected_at_save_time`
- `enrichment_happens_in_the_consumer_never_in_ingress`
- `enrichment_failure_degrades_the_render_and_does_not_fail_delivery`
- `livemode_mismatch_is_refused_not_rerouted`
- `snapshot_connection_displays_the_staleness_caveat`
- `out_of_order_events_produce_order_independent_renders`
- `ingress_makes_no_stripe_api_calls`
- `enrichment_budget_is_enforced_and_surfaced`

**Deps** — F41, F45, F49, F50, F64.

---

## F86 — Stripe deduplication and retry horizon

**Priority** P1 · **Status** partly implemented: transport dedup only (slice 10b)

**Story** As a Stripe customer, I want Stripe's three-day retry window covered exactly once,
so that I get one `invoice.paid` notification and not five.

**Acceptance**
- [ ] **Transport dedup key = `id` from the payload** (`evt_…`). Per F170, with `orgid` and
      `connectionid` in the derivation. Stripe event ids are stable across redelivery.
- [ ] **Semantic dedup key = `data.object.id + event.type`**, in a **separate table with a
      separate TTL** (F171). Stripe's own words: *"In some cases, two separate Event objects
      are generated and sent. To identify these duplicates, use the ID of the object in
      `data.object` along with the `event.type`."*
- [ ] Semantic dedup is **enableable per connection and is documented as lossy before it is
      turned on**: two genuinely distinct charges on the same object with the same type inside
      the TTL collapse into one notification. The UI states this. Stripe itself says *"in
      some cases"*, which is not a guarantee we can rely on to be either rare or common.
- [ ] ⌛ **The retry horizon sets the TTL, and the relationship is asserted in a test.**
      Stripe: *"Stripe attempts to deliver events to your destination for up to three days
      with an exponential back off in live mode."* → `dedup TTL > 3 days`; we keep 7 days
      (F171). Sandbox is 3 attempts over a few hours; live is the binding case.
- [ ] Manual redelivery is also covered by the same key. Stripe's Dashboard resend works
      *"up to 15 days after the event creation"* and the CLI resend *"up to 30 days"*. ⚠️
      **These exceed our 7-day TTL.** A customer who clicks "Resend" on a 20-day-old event in
      the Stripe Dashboard will get a second notification from us. This is surfaced as a known,
      documented consequence rather than papered over by an unbounded table.
- [ ] ⚠️ **Reconciliation exists for Stripe — this is unusual and valuable.** Stripe exposes
      `GET /v1/events` with `ending_before`, `types` and `delivery_success=false`, returning
      events created in the last **30 days**, with `delivery_success` false meaning *"return
      only events that failed delivery to at least one of your endpoints"*. That is a
      **gap-detection mechanism GitLab, Linear and Cloudflare Alerts do not offer**, and it is
      the model for F82's honest "we cannot detect this" admission.
      - The job is bounded, low-frequency, budgeted, and produces envelopes flagged
        `reconciled: true` with a synthetic `providerid` so a reconstructed event is never
        mistaken for a live one (F69).
      - ⚠️ Reconciliation requires a Stripe API key with event `Read`; it is opt-in per
        connection and off by default on the free tier.
- [ ] A manually replayed event that we already processed returns `200` and stops Stripe's
      retries. Stripe: *"skip it and return a `200` response to stop further retries."*

**Schema**
```sql
-- F86. Stripe is the ONLY source in this file with two distinct notions of "the same
-- event", so it is the only one needing a second, separately-TTL'd table (F171).
-- Transport dedup lives in event_dedup (F170); this is the semantic layer, opt-in.
CREATE TABLE semantic_dedup (
  orgid        TEXT NOT NULL,
  dedup_key    BLOB NOT NULL,   -- SHA-256(0x00‖orgid‖0x00‖connid‖0x00‖object_id‖0x00‖type)
  connectionid TEXT NOT NULL,
  object_id    TEXT NOT NULL,   -- data.object.id
  event_type   TEXT NOT NULL,   -- event.type
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  suppressed_count INTEGER NOT NULL DEFAULT 0, -- how often the trade-off actually bit
  PRIMARY KEY (orgid, dedup_key)
);
-- TTL must exceed Stripe's documented 3-day live retry horizon. Asserted in a test.
-- Reconciled envelopes reuse event_dedup with providerid_synthesized = 1 (F69).
```

**Design** — Two-level dedup exists because Stripe has two distinct notions of "the same
event" and conflating them either double-notifies (one key) or drops real events (one key
with the wrong composition). The transport key is free and safe; the semantic key is a
trade-off and is therefore opt-in with its cost stated.

The reconciliation job is the payoff of choosing Stripe as a source at all. Every other
non-GitHub provider in this file silently stops or silently loses events with no API to find
out; Stripe is the only one where a gap is *detectable*. That materially changes the
reliability story for Stripe customers and is the reason F73 scores auth and semantics
separately from operational recoverability.

**Errors**
| Condition | Behaviour |
|---|---|
| Same `id`, new signature and timestamp | Duplicate — suppressed, `200` |
| Different `id`, same `data.object.id + type`, inside TTL | Suppressed only if semantic dedup is enabled |
| Reconciliation finds an event we never received | Synthesized envelope, `reconciled: true`, routed normally |
| Reconciliation budget exhausted | `reconciliation_incomplete`, surfaced — never a silent partial |
| Reconciliation requires a key the customer did not grant | Job disabled with an explanation in the UI |

**Security** — the reconciliation key is a Stripe secret key or a restricted key with event
read; it is the same class of secret as the signing secret and follows the same storage and
logging rules. Retrieved events are untrusted payloads like any other and pass through the
same normalizer and renderer.

**Tests**
- `stripe_redelivery_with_the_same_event_id_is_one_notification`
- `stripe_new_signature_on_retry_does_not_create_a_second_event`
- `semantic_dedup_collapses_two_events_for_one_object_and_type`
- `semantic_dedup_is_opt_in_and_its_lossiness_is_disclosed`
- `dedup_ttl_exceeds_the_stripe_three_day_retry_horizon`
- `dashboard_resend_beyond_our_ttl_produces_a_second_notification_and_is_documented`
- `reconciliation_detects_and_fills_a_known_gap`
- `reconciled_events_are_labelled_and_flagged`
- `duplicate_delivery_returns_200`

**Deps** — F69, F70, F85, F170, F171, F192.

---

## F87 — Linear signature verification and replay window

**Priority** P1 · **Status** not started

**Story** As a Linear customer, I want my Linear webhook verified and its timestamp checked,
so that a captured request cannot replay issue notifications into my channel.

**Acceptance**
- [ ] `Linear-Signature` is a **hex-encoded HMAC-SHA256 of the raw body**, keyed with the
      webhook's **signing secret**. Linear: *"This header contains a hex-encoded HMAC-SHA256
      signature of the raw body contents, signed using the webhook's signing secret."*
  - This is **not** Standard Webhooks: no `whsec_` prefix, no `msg_id.timestamp.payload`
    composition, no base64. Hex, body only.
- [ ] The raw body is used verbatim. Linear: *"It's strongly recommended to use raw request
      body rather than restringifying a parsed JSON body, otherwise the signature may differ."*
- [ ] Comparison is constant-time on the decoded 32 bytes, with a `^[a-f0-9]{64}$` shape guard
      **before** the compare, so the fixed-length compare is sound.
- [ ] ⚠️ **The replay timestamp lives in the body, not a header.** The body carries
      `webhookTimestamp` — *"UNIX timestamp when the webhook was sent"*, in **milliseconds**.
      A `Linear-Timestamp` header exists and is *"The Unix timestamp, in milliseconds, when
      the webhook was sent"*, but Linear's own recommended verification reads the **body
      field**. We verify the **body field** and treat the header as corroboration; a
      disagreement is a drift metric.
- [ ] The window is **60 seconds**, and 60 seconds is Linear's own recommendation, not our
      invention: *"We recommend that you verify it's within a minute of the time your system
      sees it to guard against replay attacks."* It is **not configurable downward** — the
      spec-equivalent advice for Linear is fixed at one minute, and a longer window would
      weaken replay protection for no operational gain.
  - ⚠️ A 60-second window is tighter than every other source in this file (5 minutes for
      Generic, GitLab and Stripe). Clock skew on our side therefore produces `401`s that look
      like attacks. Skew is detected and alerted separately (F75).
- [ ] `Linear-Delivery` is a **UUID v4** and becomes `providerid`. ⚠️ **UNVERIFIED — whether
      `Linear-Delivery` is stable across Linear's own retries.** A retry re-POSTs the payload;
      if Linear regenerates the delivery id we cannot transport-dedup it and rely on the
      semantic key. Check by triggering a failing endpoint through all three retries and
      comparing `Linear-Delivery` before shipping the source.
- [ ] `Linear-Event` (`Issue`, `Comment`, …) is the classification input; `action`
      (`create | update | remove`) comes from the body, per F59's rule.
- [ ] **`webhookId`** in the body is the **webhook registration's** id, not the delivery's. It
      is recorded for diagnostics and is **never** used for dedup.
- [ ] Actor may be **null**: *"Could be a User, OAuth client, or `Integration`. May be null if
      the user or integration that triggered the action has since been deleted."* A null actor
      normalizes to `isActorKnown: false`, **not** to a bot and **not** to a ghost (F60's rule
      against guessing identity).
- [ ] `updatedFrom` gives previous values on `update`, which feeds F156's correlated state
      updates rather than being rendered as a diff by default.

**Design** — Linear is a good test of whether the source layer is genuinely provider-agnostic
or just Standard-Webhooks-agnostic. Its signature is a *third* shape (hex, body-only), its
timestamp is in the body in milliseconds, its window is 60 seconds, and its delivery-id
stability is unverified. Each of those is a separate place a copy-paste of the GitHub or
Standard Webhooks verifier would be wrong.

The 60-second window deserves an explicit note: it is materially tighter than Stripe's 5
minutes, so a customer running both sources on the same Worker must understand that the
tolerances differ. We do not unify them, because unifying upward weakens the source whose
provider recommends the tight value.

**Errors**
| Condition | Behaviour |
|---|---|
| Missing `Linear-Signature` | `401` |
| Signature length ≠ 64 hex chars | `401` before comparison |
| Signature mismatch | `401` |
| `webhookTimestamp` missing | `401`, `timestamp_malformed` — the field is inside the signed body, so its absence is a payload problem |
| `webhookTimestamp` older/newer than 60 s | `401`, `stale_timestamp` |
| `webhookTimestamp` in seconds (a customer's sender bug) | `401` — a ~1.7-million-second delta is detected and reported as a unit error, not as skew |
| `Linear-Event` unknown | `unmapped:<raw>`, surfaced |
| `actor: null` | `isActorKnown: false`, rendered as "via Linear", never as a person |

**Security** — the signing secret is shown once on the webhook detail page and stored
encrypted; it is not an OAuth token and grants no API access. Because Linear's retries are
1 minute / 1 hour / 6 hours and its *"webhook might be disabled by Linear"* if unresponsive,
our handler must answer `200` inside Linear's documented **5-second** timeout, which is
tighter than GitHub's 10 seconds and tighter than GitLab's 10 seconds.

**Tests**
- `linear_hex_signature_verifies_against_the_raw_body`
- `linear_signature_is_not_base64_and_has_no_whsec_prefix`
- `linear_replay_window_is_exactly_sixty_seconds`
- `linear_window_is_not_configurable_beyond_sixty_seconds`
- `second_precision_timestamp_is_reported_as_a_unit_error_not_skew`
- `linear_delivery_id_is_used_for_dedup_and_webhook_id_is_not`
- `linear_delivery_id_stability_across_retries_is_asserted_by_a_live_capture_test`
- `null_actor_renders_as_an_unknown_actor_not_a_person`
- `handler_acknowledges_within_the_five_second_linear_timeout`

**Deps** — F04, F12, F36, F60, F75.

---

## F88 — Linear OAuth programmatic onboarding

**Priority** P2 · **Status** not started

**Story** As a Linear workspace admin, I want to install Noti from Linear without pasting a
URL, so that setup is one click instead of a configuration exercise.

**Acceptance**
- [ ] Linear documents the mechanism precisely and we implement exactly it: *"OAuth
      applications can configure webhook settings. Once those settings are configured, each
      time a new organization authorizes the given application, a webhook will be created for
      that organization that posts to the provided webhook URL."*
- [ ] On install, we call `webhookCreate` with our per-organization URL and the customer's
      selected `resourceTypes` (or `allPublicTeams: true`). The mutation returns
      `{success, webhook{id, enabled}}`; `id` is stored for the de-authorization path.
- [ ] **The required scope is `admin`**, and Linear states the constraint plainly: *"Only
      workspace admins, or OAuth applications with the `admin` scope, can create or read
      webhooks."* The install screen explains that Noti needs admin-level webhook
      configuration, and denies nothing else. ⚠️ **UNVERIFIED — the exact scope string and
      whether Linear still supports granting `admin` to third-party public apps.** Check
      `linear.app/developers/oauth-2-0-authentication` before building the install screen; do
      not guess a scope name.
- [ ] **De-authorization is handled as a security event.** Linear: *"If your application is
      de-authorized from an organization the `OAuthApp revoked` event will be sent"*, carrying
      `oauthClientId` and `organizationId`. On receipt we stop delivery immediately, revoke
      our OAuth token, write an audit event (F28) and notify the workspace — the same handling
      as GitHub's `installation.deleted` (F68).
- [ ] `OAuthApp revoked` **carries no signature exception**: it is verified by the same F87
      path. A de-authorization is a credential-revocation signal and must not be a path where
      verification is relaxed.
- [ ] The webhook is created per organization at authorization time, so **the tenant key is
      our per-connection URL**, not a body field (F76).
- [ ] Teams can be scoped: `teamId` for one team, or `allPublicTeams: true`. The customer's
      choice is recorded and shown, because "all public teams" is broader than it sounds and
      the connection UI states it.
- [ ] ⚠️ **Token lifecycle is unverified for this scope.** Linear OAuth access tokens and their
      expiry are documented on the OAuth page; record the actual grant/expiry/refresh
      behaviour in the connection schema and cache accordingly (F66's pattern for GitHub).
      Do not mint a token per webhook — Linear's API rate limits apply and the GitHub lesson
      (F66) is that OAuth-request limits are per-integration and getting it wrong affects every
      tenant at once.
- [ ] Re-install after de-authorization creates a **new** connection id; the old one stays in
      the audit trail as `revoked`.
- [ ] Manual webhook creation remains available for customers who cannot grant admin, with
      the `admin`-scope requirement stated up front (F80).

**Design** — Linear is the cheapest possible onboarding win in this file and the easiest to
get wrong by over-building. The webhook is created *for us* at authorization time; we do not
poll, we do not discover teams, we do not manage the credential lifecycle of a customer bot.
The whole feature is: an OAuth install, one `webhookCreate` mutation, and a
de-authorization handler.

`OAuthApp revoked` is the reason this source is worth doing properly. It is Linear's only
notification that a customer has withdrawn access, and handling it as an ordinary event type
means a revoked customer keeps receiving notifications until the token expires. That is the
same class of bug as F68 and is why this feature cannot be deferred to "notifications later".

**Errors**
| Condition | Behaviour |
|---|---|
| Admin consent refused | Install aborts with the scope explained; no partial connection |
| `webhookCreate` fails | Install fails loudly; no connection row is created (F80's abandonment rule) |
| `OAuthApp revoked` received | Stop delivery, revoke token, audit, notify — as F68 |
| `OAuthApp revoked` arrives for an unknown organization | Recorded as `unclaimed`, never used to route |
| Webhook later deleted in Linear | Detected only by the idle-connection prompt (F82's pattern); surfaced to the customer |

**Security** — the OAuth token is encrypted with `key_version` and is **never** placed in a
queue body or an envelope (D5). Least privilege is requested for exactly what Linear needs to
create and read webhooks and nothing more. Revocation actually calls Linear's API, not just
the local flag, or a leaked token stays valid at Linear.

**Tests**
- `oauth_authorize_creates_one_webhook_per_organization`
- `webhook_create_records_the_linear_webhook_id`
- `oauth_app_revoked_stops_delivery_immediately`
- `oauth_app_revoked_writes_an_audit_event_and_notifies_the_workspace`
- `revoked_verification_is_never_relaxed`
- `admin_scope_requirement_is_explained_before_the_customer_leaves`
- `reinstall_creates_a_new_connection_and_preserves_the_old_audit_trail`
- `oauth_token_is_never_placed_in_a_queue_body_or_envelope`

**Deps** — F66, F68, F76, F87, F216.

---

## F89 — Sentry: pull-based, and honest about the webhook

**Priority** P2 · **Status** resolved as a refusal, re-verified 2026-10-13 (slice 10b) · **Decision: no push source without real evidence**

**Story** As a security reviewer, I want us to refuse to ship a webhook source whose
authentication we cannot verify, so that no Sentry customer has an unverified endpoint
pointed at their workspace.

**Acceptance**
- [ ] ⚠️ **The alert-action "custom webhook" has no documented authentication.** Sentry's
      alert documentation lists the action only as *"Take action via a third party integration
      that supports Alert actions or trigger a custom webhook"* — with **no signature scheme,
      no delivery identifier, no retry schedule, no response contract and no payload schema**
      published on `docs.sentry.io`.
  - **There is no `X-Sentry-Auth` header.** That header name appears in no Sentry
      documentation and must not appear in ours.
  - Consequence: a Sentry alert webhook cannot satisfy F73's blocking auth axis, and is **not
      built as a push source**.
- [ ] ⚠️ **The Integration Platform webhook does document a signature — and it is not safely
      implementable as written.** `docs.sentry.io/integrations/integration-platform/webhooks/`
      documents `Sentry-Hook-Signature` as *"a cryptographic hash generated by your Client
      Secret"*, alongside `Sentry-Hook-Resource`, `Sentry-Hook-Timestamp` and `Request-ID`.
      But the documented verification recipe computes the HMAC over
      `JSON.stringify(request.body)` — that is, over a **re-serialised object, not the raw
      bytes** — and compares with `===`.
      - This is the exact failure mode Standard Webhooks names: *"it is important to make sure
        that the payload sent is the same as the payload signed… many webhook consumers
        accidentally parse the body as json, and then serialize it again."*
      - The comparison is **not constant-time**.
      - **No tolerance or replay window is documented for `Sentry-Hook-Timestamp`.**
      - **No replay, ordering or dedup contract is documented for `Request-ID`.**
      - The documented timeout is aggressive: *"Webhooks should respond within 1 second.
        Otherwise, the response is considered a timeout."*
      - ⚠️ **UNVERIFIED — whether Sentry signs the raw bytes and the published recipe is simply
        wrong.** Resolve by capturing a real delivery from a test org and checking whether the
        raw-bytes HMAC also verifies. **Until that capture test exists and passes, this path
        is not implemented.** Do not implement a verifier that matches their recipe; a
        verifier that re-serialises a body in a Workers runtime would be a payload-parsing
        dependency on the authentication boundary, which is unacceptable.
- [ ] **What we build instead: a pull-based source over Sentry's documented REST API.**
      - `GET /api/0/organizations/{org}/issues/` and the event endpoints documented under
        **API Reference → Events & Issues** are the authoritative surface.
      - Authentication is a Sentry auth token — a real credential with real permissions, which
        we encrypt and never log, exactly as F66 handles the GitHub App key.
      - Polling is scheduled (F192), **budgeted**, **stale-tolerant** (store a high-water mark
        on the issue's `lastSeen()`/updated cursor rather than assuming ordering), and
        deduplicated on the issue id.
      - ⚠️ **UNVERIFIED — the exact pagination cursor semantics and the rate-limit headers for
        the Sentry REST API.** Retrieve `docs.sentry.io/api/` (**Rate Limits**, **Paginating
        Results**) before implementing the poller and record the actual header names and
        numbers. Do not infer them from another provider.
      - This is an **explicit deviation from F71's `SourceAdapter` shape**, which assumes a
        verified inbound request. It is declared as a `PollSource` variant with a documented
        reason, so the conformance suite has something to assert rather than a hole to skip.
- [ ] Because Sentry's value overlaps the GitHub wedge (F73's overlap rule — a production
      failure is already a GitHub event), the Sentry source is **P2 by construction** and is
      scoped to `new issue`, `regression`, and `issue resolved`, the three triggers Sentry
      documents as distinct from one another.
- [ ] The UI states the trade-off explicitly: **Sentry cannot be push-integrated today; this
      connection polls, and polling is slower and consumes Sentry API quota.**
- [ ] Nothing about Sentry appears in the source catalogue as a signed push source.

**Design** — This is the feature that records a refusal, and refusals are worth as much as
decisions. Sentry is a popular alert source, it would be easy to ship, and shipping it on an
undocumented auth contract would put an unauthenticated internet-facing endpoint in front of
a customer workspace — the exact failure F73's blocking axis exists to prevent. There is
defensible middle ground only when we can point at a verified primary source for every claim;
here we cannot, for four separate fields.

Two of the four are *recoverable* — a raw-bytes signature capture test and a documented
timestamp window could both be established with one real Sentry org and a public web host. That
is written into the feature so the next person does the experiment instead of re-litigating
the decision.

The pull-based source is the honest alternative: it uses a credential we fully understand,
under permissions the customer grants explicitly, at the cost of latency and quota.

**Errors**
| Condition | Behaviour |
|---|---|
| A Sentry push connection is requested | Refused with the reason and the pull alternative offered |
| Sentry API returns 401/403 | Stop polling that connection, notify the workspace, audit |
| Sentry API rate limit reached | Honour the documented mechanism, back off, surface `poll_deferred` |
| Cursor gap detected (issue updated behind the high-water mark) | Re-read the window and record `reconciliation_gap` — never silently skip |
| A capture test contradicts the published Sentry recipe | The push path stays unimplemented; the finding is recorded here |

**Security** — the Sentry auth token is a full-account-capability credential. Requested
permissions are the minimum that reads issues and events, stored with envelope encryption and
`key_version`, never logged, never placed in a queue body, rotatable, and revocable from the
UI. Polling is per-connection and budgeted so one tenant's Sentry org cannot consume the
fleet's scheduled-job budget.

**Tests**
- `no_push_sentry_source_is_registered`
- `sentry_wizard_offers_pull_only_and_says_why`
- `sentry_poller_authenticates_with_a_rotatable_encrypted_token`
- `sentry_poller_respects_a_documented_rate_limit_mechanism`
- `sentry_poller_detects_and_repairs_cursor_gaps`
- `sentry_push_verifier_is_absent_until_a_capture_test_exists`
- `sentry_poller_never_appears_in_ingress_request_paths`

**Deps** — F49, F66, F71, F192.

---

## F90 — Cloudflare Alerts: the weakest auth we ship

**Priority** P2 · **Status** not started

**Story** As a Cloudflare customer, I want to receive my alerts in Noti, so that I know about a
DDoS without living in the Cloudflare dashboard.

**Acceptance**
- [ ] The connection is authenticated by **`cf-webhook-auth`**, which Cloudflare documents as
      the secret value the customer configured, sent on every request: *"Cloudflare will send
      your secret in the `cf-webhook-auth` header of every request made. If this header is not
      present, or is not your specified value, you should reject the webhook."*
  - Comparison is constant-time on equal-length values.
  - The header is redacted in every log (F12).
- [ ] ⚠️ **State the weakness, do not bury it. This is a static shared bearer token with no
      signature, no timestamp, no nonce and no body integrity.** The request body is fully
      attacker-controllable by anyone who learns the secret, and the secret is a single string
      with no rotation semantics beyond the customer regenerating it in their dashboard.
      Nothing in Cloudflare's documentation mitigates this.
- [ ] ⚠️ **IP allowlisting is documented by Cloudflare but unavailable to us.** Cloudflare
      instructs receivers to *"allowlist these IP addresses"*, and in the same repo we have
      already recorded that Workers egress IPs are not a fixed, customer-pre-allowable set.
      Therefore the documented defence in depth is **not available** and is stated as such.
- [ ] Payload handling follows the documented schema — `name`, `text`, `data`, `ts`,
      `account_id`, `policy_id`, `policy_name`, `alert_type`, `alert_correlation_id`,
      `alert_event` — with `ts` in **unix seconds** and `alert_event` being
      `ALERT_STATE_EVENT_START` or `ALERT_STATE_EVENT_END`.
- [ ] ⚠️ **`account_id`, `policy_id` and `alert_type` *"may not be present in all
      notifications"*.** The normalizer requires `alert_event` and `alert_correlation_id`,
      tolerates the rest, and never routes on a body field (F26's rule).
- [ ] **`alert_correlation_id` is the grouping key.** Cloudflare: it is *"The UUID that groups
      related alerts together"*, and paired with `alert_event` START/END it is the
      start/resolution pair that F152's resolution notices and F156's correlated updates
      consume.
- [ ] **The whole body is untrusted content.** `text` is a free-form human-readable string and
      `data` varies by alert type; both are attacker-controllable if the secret leaks. The
      renderer treats them as data, never as instructions, never as markup, and never as a
      source of a link target without `https:` validation (F94). This is the single highest
      injection surface among the sources in this file.
- [ ] **There is no documented delivery id.** `providerid` is **synthesized** from
      `(alert_correlation_id, alert_type, alert_event, ts)` and marked
      `providerid_synthesized = 1` so duplicate suppression is honestly weaker (F47). ⚠️
      **UNVERIFIED — whether Cloudflare provides a stable per-notification identifier in any
      header.** Capture real deliveries from a test notification policy and inspect the full
      header set before finalising the synthesized key.
- [ ] ⚠️ **No retry schedule is documented** on the pages we verified. Treat repeat `START`
      events as legitimate unless the correlation id says otherwise, and make the duplicate
      window configurable.
- [ ] **`ts` is a freshness hint only**, and is labelled as one: an attacker with the secret
      can set any value. It is never treated as authentication. A `ts` more than 24 h in the
      future or 7 d in the past is recorded as suspicious and surfaced, but does not by itself
      reject — because Cloudflare does not document a clock-skew allowance and a hard reject
      would silently drop real alerts.
- [ ] The UI states, on the connection card: *"Authenticated with a static secret Cloudflare
      sends on every request. There is no signature and no replay protection. Rotate the secret
      in Cloudflare and here together if you suspect it is exposed."*
- [ ] Destination: notification policies are configured by the customer in Cloudflare's UI;
      we document the step and provide the test notification path (F98).

**Design** — Cloudflare Alerts is the source where honesty has to be structural rather than
editorial. The auth model is weaker than every other source we support, the body is entirely
attacker-controlled if the secret leaks, and the documented mitigation (IP allowlisting) is
one we cannot implement. Shipping it without saying so would be the "fake universal
capability" failure in its source-side form.

The second-order risk is worse than the authentication weakness: `text` is a free-text string
that a renderer will put in a chat message in a channel full of engineers. That is a
social-engineering payload, not an authentication payload, and it is why the rendering rules
here are strict even though the source is P2.

What the source is genuinely good for is `alert_correlation_id` + START/END. Cloudflare groups
related alerts and fires a start and an end for the same correlation id, which is exactly the
shape F152's resolution notices need — and Cloudflare customers are already Cloudflare
customers, so the setup is a dashboard configuration rather than a code change.

**Errors**
| Condition | Behaviour |
|---|---|
| `cf-webhook-auth` missing or mismatched | `401`, no body detail |
| Body is not a JSON object | `400` |
| `alert_event` missing or not `START`/`END` | `400` `schema_invalid` |
| `account_id` / `policy_id` / `alert_type` absent | Accepted; recorded as absent, never used for routing |
| `ts` implausible | Accepted, flagged `timestamp_suspect`, surfaced |
| `data` shape unknown for the `alert_type` | Stored in `data.extra`, capped, **never rendered** |
| Duplicate synthetic key inside the window | Suppressed, recorded as synthesized dedup |
| Connection idle beyond the threshold | Dashboard prompt: Cloudflare may have stopped or the policy may be off |

**Security** — this is the one source in the file where a leaked credential yields **content
injection**, not just event injection. Three controls follow: the `cf-webhook-auth` value is
treated as a high-entropy secret (we generate it, the customer pastes it into Cloudflare, and
it is ≥ 128 bits), it is redacted everywhere, and the renderer applies the strictest escaping
and the default-off mention policy (F94) with **no** links constructed from `data` unless the
customer has explicitly enabled link rendering for this destination.

**Tests**
- `cf_webhook_auth_is_compared_in_constant_time_and_never_logged`
- `missing_cf_webhook_auth_is_401`
- `whole_body_is_treated_as_untrusted_content_and_never_interpreted`
- `freeform_text_field_is_escaped_and_never_rendered_as_markup`
- `no_link_target_is_constructed_from_data_without_https_validation`
- `absent_optional_fields_do_not_fail_normalization`
- `alert_correlation_id_with_start_and_end_maps_to_a_resolution`
- `provider_id_is_synthesized_and_marked_as_such`
- `timestamp_is_a_hint_and_never_authentication`
- `ui_discloses_the_static_bearer_token_weakness_on_the_connection_card`

**Deps** — F12, F26, F47, F76, F94, F98.

---

## Open items this file did not close

1. **Standard Webhooks tolerance** — the spec says only *"some allowable tolerance"*. Our
   5-minute default is a decision, not a spec value. Revisit if a provider's documented
   schedule requires more.
2. **Linear `Linear-Delivery` stability across retries** — unresolved. Requires a live capture
   through all three documented retry intervals (1 min / 1 h / 6 h).
3. **Linear `admin` OAuth scope for third-party apps** — scope string and current support
   unverified. Check `linear.app/developers/oauth-2-0-authentication` before F88.
4. **Stripe REST API rate-limit headers** — not retrieved. Do not assume `X-RateLimit-*`;
   read `docs.stripe.com/api/rate-limits`.
5. **Sentry REST API pagination cursor and rate limits** — not retrieved. Blocks the F89
   poller.
6. **Sentry webhook signature over raw bytes** — the published recipe re-serialises the body.
   Only a real capture resolves it.
7. **Cloudflare Alerts header set and retry schedule** — only the documented `cf-webhook-auth`
   was verified. Capture real deliveries before finalising the synthesized `providerid`.
8. **GitLab self-managed** — signing token availability is a *GitLab version* property
   (19.0/19.1). Self-managed instances below 19.0 have no signing token and rely on the
   secret-token path. Confirm the minimum-version matrix before enabling self-managed
   connections.

**Deps** — F71, F72. **Blocks** nothing; is blocked by F71.
