# ADR 0015: Provider sources (GitLab, Stripe) and the refusal of Sentry

Status: Accepted · Date: 2026-10-13 · Implements slice 10b (spec 06 F81, F83, F84, F86 in part;
F89 as a recorded refusal). Builds on [ADR 0012](0012-generic-source.md).

## Context

Slice 10a shipped the generic Standard Webhooks source. Spec 06 ranks the next sources by
whether their authentication is documented well enough to implement exactly (F73): GitLab and
Stripe pass, Sentry's webhook does not (F89). This slice adds the first two behind one typed
connector contract, and keeps the Sentry decision on record with today's evidence.

Every provider claim below was read from the provider's own documentation on **2026-10-13**:

- GitLab: `docs.gitlab.com/user/project/integrations/webhooks/` and `.../webhook_events/`
- Stripe: `docs.stripe.com/webhooks`, `/api/events/object`, `/api/disputes/object`,
  `/api/invoices/object`, `/api/subscriptions/object`, `/api/payment_intents/object`,
  `/currencies`
- Sentry: `docs.sentry.io/organization/integrations/integration-platform/webhooks/`

## Decisions

1. **A small connector registry, not a switch.** `src/connectors/sources/types.ts` defines
   `SourceConnector`: `verify` (raw bytes, before any parsing), `map` (a pure function to the
   canonical display fields), `parseSecret` (what a person pastes), a closed `eventCatalog`,
   `maxBodyBytes`, `onFlood`, and a `decoy` for dead endpoints. `registry.ts` maps `sources.kind`
   to a connector; one route factory (`provider-route.ts`) serves
   `POST /webhooks/<kind>/:endpointId` for every registered kind. The generic source keeps its own
   route (ADR 0012) and is not refactored; sharing the fan-out code between the two is a
   follow-up, not a risk taken in this change.

2. **Route discipline is the generic route's.** Content type (415) and capped body (413) first;
   the source row is selected by the public endpoint id and is the only origin of the tenant;
   authentication over the raw bytes **before** JSON parsing; one identical `404 Not found` for
   unknown, malformed, disabled and wrong-kind endpoints (a decoy verification runs for bodies up
   to 16 KiB); the per-source flood limit runs only after authentication; `202` only after the
   delivery and outbox rows commit in one D1 batch, with the outbox row conditional on the
   delivery row being new. `webhook-id` reuse detection (409, ADR 0012 section 14) is **not**
   applied: a 4xx counts as a failed delivery to GitLab and Stripe, and both document retries
   that resend the same body.

3. **GitLab (GitLab.com only).** One credential per source, chosen explicitly by the person
   (`auth_mode`), never guessed from its shape:
   - `signing_token`: GitLab follows Standard Webhooks (GA 19.1), so the **generic verifier is
     reused unchanged** (`whsec_` base64-decoded, `id.timestamp.body`, five-minute window,
     constant-time compare). A request with no signature is refused; there is no fallback.
   - `secret_token`: `X-Gitlab-Token` compared in constant time (both sides are hashed, then folded
     without early exit). GitLab calls it weaker and "not recommended for new webhooks": it carries
     no timestamp and no body integrity, so a captured request can be replayed. The dashboard says
     so on the card and in the guidance.
   GitLab's migration advice (both configured, signature preferred, token as fallback) is not
   offered; with one credential per source the spec's "an invalid signature is not rescued by a
   valid token" rule holds by construction. To migrate, replace the credential with the signing
   token. `X-Gitlab-Instance`, when present, must be `gitlab.com` (401 otherwise); it is never an
   authorization input. Self-managed instances are out: spec 06 open item 8 (version matrix) is not
   closed.
   - **Identity**: `webhook-id` (signed), else `Idempotency-Key` (documented equal), else the
     SHA-256 of the body. `X-Gitlab-Event-UUID` is deliberately not used (it is shared by recursive
     webhooks).
   - **Flood policy `absorb`**: when the per-source limit (600/min) is exceeded the route answers
     `200 {accepted:false, dropped:"rate_limited"}` and drops the event, because GitLab disables a
     webhook after four consecutive 4xx/5xx and for good after forty (spec F82). The drop is logged
     with the source id only. A visible counter of dropped events is not built.
   - **Event catalogue** (`GITLAB_EVENT_TYPES`): `push`, `tag_push`, `merge_request.opened|merged|
     closed|reopened`, `issue.opened|closed|reopened`, `pipeline.failed|succeeded`. The header
     classifies the event; the action comes from `object_attributes.action`. Merge request
     `update`, approvals, and pipeline statuses other than `failed` and `success` are
     acknowledged and ignored. A confidential issue's title is never copied into a chat. No email
     address is ever read.

4. **Stripe (snapshot events).** `Stripe-Signature: t=<s>,v1=<hex>[,v1=...][,v0=<decoy>]`; HMAC-
   SHA-256 over `t.rawBody`; **the `whsec_` secret is the key as a string, not base64-decoded**,
   the opposite of Standard Webhooks; only `v1` is considered (the `v0` decoy is ignored); every
   `v1` entry is checked (a secret roll sends one per active secret); constant-time
   `crypto.subtle.verify`; a five-minute tolerance in both directions that is not configurable.
   A test runs one payload through both verifiers and expects opposite outcomes, so a "shared
   HMAC helper" refactor fails loudly. Neither signature nor timestamp is identity (both change on
   every retry): the key is the event `id` from the body.
   - **Test and live are separate sources** (`livemode` column, chosen at creation). An authentic
     event of the other mode is acknowledged with `200 {ignored:"livemode_mismatch"}` and routed
     nowhere. The spec (F85) says `401`; a 4xx would make Stripe retry for three days an event we
     will never accept, so this is a deliberate deviation.
   - **Catalogue** (`STRIPE_EVENT_TYPES`): `invoice.payment_failed`, `payment_intent.payment_failed`,
     `charge.dispute.created|closed`, `customer.subscription.created|updated|deleted`. A
     subscription update notifies only when `status` or `cancel_at_period_end` changed (per
     `data.previous_attributes`); metadata edits are ignored. Thin events (`v2.core.event`), Connect
     events (`account` present) and every other type are acknowledged and ignored.
   - **No personal data.** A notification carries object ids, the amount and currency, a status or
     reason code and a date. The invoice payload contains `customer_email`, `customer_name` and
     `customer_phone`; none is read (a test asserts their absence from the outbox and the rendered
     message). The only link is `hosted_invoice_url`, kept only if `https` on `stripe.com`.
   - **Amounts** use the platform's ISO 4217 minor-unit data (so JPY has none and KWD three)
     with Stripe's documented exceptions (ISK and UGX are two-decimal in the API). A well-formed
     code the platform does not know is shown with two decimals; this is a guess, listed below.
   - **Flood policy `retry`**: `429` with `Retry-After`; Stripe retries for up to three days.

5. **Credentials are pasted, sealed on write, never shown.** Unlike the generic source, GitLab
   and Stripe generate the secret, so the API accepts it (`secret`, plus `authMode` for GitLab and
   `livemode` for Stripe) and seals it with the same envelope (purpose `source.signing`, AAD
   binding organization, source id and field). The create and rotate responses do not contain it;
   it is absent from list, get, export, audit metadata and logs. Rotation (admin only) asks for the
   new pasted credential and may switch GitLab from `secret_token` to `signing_token`; test or live
   cannot change. Validation messages never echo the value. The KEK rewrap job already covers every
   row of `sources`.

6. **Event selection through the existing mechanism.** `integrations.event_types` already holds a
   JSON list; for an integration bound to a GitLab or Stripe source it now holds a selection from
   that kind's catalogue (empty means every event of the source), validated on create and update
   against `eventCatalogFor(source.kind)`, and applied at ingress. A generic source has no
   catalogue and still refuses any selection; GitHub integrations, their catalogue and the GitHub
   route are untouched. Routing filters (ADR 0010) stay GitHub-only: they need provider facts
   (branches, labels, authors) that are not extracted for these providers.

7. **Migration 0019** rebuilds `sources` (CHECK widened to `generic|gitlab|stripe`, columns
   `auth_mode` and `livemode` added), preserving every column, both indexes and the three
   triggers, and drops and recreates the two triggers on `integrations` that read `sources` so the
   rename is legal. `tests/migration-0019.test.ts` compares columns (type, nullability, default,
   key), indexes and every trigger body before and after, and exercises the rebuilt triggers.
   0018 is reserved by another change; the numbers need not be contiguous.

8. **Sentry is refused, again.** Read today: the Integration Platform page documents
   `Sentry-Hook-Signature` as an HMAC-SHA-256 hex digest "generated by your Client Secret" and the
   recipe hashes `JSON.stringify(request.body)`, a re-serialised parsed body, and compares with
   `===`. No timestamp tolerance, replay or ordering contract is documented, and the page asks for
   a response within one second. That is unchanged from the finding in spec F89, so nothing in the
   evidence moved. Noti will not put a re-serialising verifier (a parser on the authentication
   boundary) or a non-constant-time comparison in front of a tenant. `POST /api/sources` with
   `kind: "sentry"` is `422` with the reason, there is no `/webhooks/sentry` route, and a test
   fails if a connector named `sentry` is registered. Unblocking needs the capture experiment
   spelled out in F89 (a real delivery from a test organization verified over the raw bytes) and a
   documented replay window.

## Verification and what is not verified

Tests: signature vectors built with `node:crypto` (independent of the code) for both providers,
tamper, stale, replay, malformed headers, oversize, wrong content type, unknown and disabled
endpoints, tenant isolation, flood policy per provider, idempotency across retries with new
signatures, mapping of fixtures built from the documented payloads, API validation and
authorization, rotation (old credential dead at once), KEK rewrap, event selection, end-to-end
through the real Slack, Lark and Teams adapters over the fake D1, the migration schema diff, and a
parity test between the dashboard's credential checks and the Worker's parsers.

**Not verified or unverified:**

- No test against a real GitLab or Stripe delivery. The fixtures are the documented examples, with
  values filled where the docs show `null`; they are not captured traffic.
- Stripe's own header example (`t=1492774577,v1=5257a869...`) cannot be reproduced: the docs
  publish no secret or body with it. The vectors are generated.
- UNVERIFIED: the full list of GitLab pipeline `status` values (only `success` is shown; `failed` is
  the documented job counterpart); the exact value of `X-Gitlab-Instance` on GitLab.com ("the
  hostname"); the exact character set of a Stripe signing secret beyond the `whsec_` prefix; the
  keys that appear in `data.previous_attributes` of a subscription update beyond "the names of the
  updated attributes"; whether Stripe's hosted invoice host is always under `stripe.com`.
- Stripe amount formatting for currencies the platform's ISO data does not know.
- No browser, 320 px, keyboard or screen-reader pass of the new Sources screens; checked through
  types, lint, unit tests and server-rendered markup only.

## Deliberately not done

- GitLab: self-managed instances; dual credentials with signature-preferred fallback (F81); the
  `Idempotency-Key` versus `webhook-id` drift metric; `provider_disable_inference`, plan tier,
  namespace limits and the "no deliveries for 72 h, check GitLab" prompt (F82); `Note`, `Job`,
  `Release`, `Wiki`, `Milestone`, `Emoji` and group hooks, merge request `update` and approval
  actions, `changes` and `data.extra`, the push truncation flag (F83); a counter for events dropped
  under flood.
- Stripe: thin events and enrichment (F85); semantic dedup, the `GET /v1/events` reconciliation job
  and the dedup TTL assertion (F86); a configurable tolerance; payloads for Connect; a webhook
  health prompt; event types beyond the seven.
- Linear and Cloudflare Alerts (F87 to F88, F90); Sentry (decision 8).
- The generic route and the provider route still duplicate the fan-out transaction.
- Routing filters for provider events; per-source event selection (selection is per chat).
