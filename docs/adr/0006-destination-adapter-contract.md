# ADR 0006: Destination adapter contract, capability model and response taxonomy

Status: Accepted · Date: 2026-10-13 · Supersedes nothing

## Context

Slice 5 (`docs/PROGRESS.md`) implements F91–F104 from
`docs/specs/07-destination-capabilities.md`. Before this change Lark had a small adapter and
Slack was an inline `{ text }` string in the queue consumer, with every failure collapsed into
`Provider HTTP <status>` (D8, D11). Provider facts come from
`docs/DESTINATION_API_REFERENCE.md` (read 2026-10-13).

## Decision

1. **Pure modules under `src/connectors/destinations/`.** Each destination (`slack/`, `teams/`,
   `lark/`) implements `DestinationAdapter` (`adapter.ts`): `capabilities`, `validateConfig`,
   `render`, `buildRequest`, `classifyResponse`. Rendering is synchronous and deterministic.
   Network I/O lives only in `send.ts`, which takes an injectable `fetch`.
2. **Validated configuration is a sealed type.** `validateDestinationConfig` is the only way to
   obtain a `ValidatedDestinationConfig`. It runs the URL allowlist (`url-policy.ts`): https
   only, no userinfo, no non-default port, no fragment, no IP literal, no whitespace/control
   characters, ≤ 2048 chars, documented host plus path prefix. Teams is host-pattern only
   (`*.logic.azure.com`) because Microsoft documents the trigger URL as opaque. `sendRequest`
   re-checks the policy before every request.
3. **Teams trigger auth:** only `anyone` is accepted; token-requiring modes are rejected at
   save time as `config_unsupported` rather than failing every delivery later.
4. **Closed response taxonomy.** Every classifier returns
   `{ outcome: 'delivered' | 'accepted' | 'retryable' | 'permanent', reason, retryAfterMs?,
   providerCode?, unmapped? }`. `reason` is a closed union (`DELIVERY_REASONS`) whose names
   match F13 where meanings coincide. `providerCode` only ever comes from our own known-code
   tables, never from the response body. Unknown responses are retryable and flagged
   `unmapped` so a metric can be raised (F13). Teams 2xx is always `accepted`.
5. **Degradation ladder** `card → markdown → plain` with a per-destination byte budget. The rung
   used and the rungs skipped are returned on the rendered message; if nothing fits, the result
   is `payload_too_large` (permanent), never a silent drop.
6. **Text handling.** Text is split into indivisible atoms (escaped graphemes and whole links), so
   truncation never splits a surrogate pair, a combining sequence, an escape entity or a link,
   and always ends with a visible `…`. Slack mrkdwn escapes `& < >` (documented). For Lark card
   markdown and Teams Adaptive Card markdown no escape syntax could be verified, so `[ ]` (and,
   for Lark, `< >`) are replaced with their fullwidth forms. Slack untrusted text goes into
   `plain_text` objects; Lark headers use `plain_text`.
7. **Lark DLP.** Lark masks emails and phone-like strings in titles and summaries before render
   (error 230028), and records `redactedFields`. Lark cards now set `config.summary.content`.
8. **Compatibility (retired).** `lark/webhook.ts` kept `larkPayload`, `larkAccepted` and
   `larkCard` for the slice 4 consumer. The consumer now uses the adapters (see "Wiring"
   below), so the file, `larkAccepted` and the legacy test were deleted. `larkSignature`
   remains in `lark/sign.ts`.

## Consequences

- Done in the wiring change below: the consumer calls `prepareDelivery` / `sendRequest` /
  `classifyDeliveryResponse`. Still open: persisting `format`, `degradedFrom`,
  `truncatedFields`, `redactedFields` and the adapter `reason` on the delivery row (only the
  F13 code and a minted diagnostic are stored).
- Status is conveyed as text (`Failed: …`) as well as colour, for accessibility.
- Facts marked `UNVERIFIED` in code are not claims; each names what to check.
- Accepted risk: any Azure tenant can create a Logic App on `*.logic.azure.com`, so the Teams
  allowlist does not stop a workspace member pointing notifications at an endpoint they own.
  That is an exfiltration channel for that workspace's own event data, not SSRF: the host is
  public Microsoft infrastructure, never our network. Workspace roles and audit logs govern who
  may configure destinations.
- Redirects are never followed (`redirect: 'manual'`); a 3xx is a permanent
  `destination_redirected`. This meets the intent of the `redirect: 'error'` requirement in
  specs 09/12/15 (no redirect is ever followed) while letting the outcome be classified; with
  `'error'` a redirect is an indistinguishable network `TypeError` and would be retried.

## Wiring into the delivery path (slice 5 completion)

- **One classification layer.** The adapters classify provider responses.
  `src/delivery/classify.ts` no longer reads responses; it only translates a
  `ClassifiedResponse` into slice 4's vocabulary: `REASON_CODES` maps every adapter `reason`
  onto exactly one F13 `ErrorCode`, and `attemptFromClassification` produces the
  `AttemptOutcome` the retry policy and ledger already consume. The old Lark/HTTP/redirect/
  thrown classifiers and their tests were deleted; the equivalent cases are covered by
  `tests/delivery/classify.test.ts` and `tests/pipeline/destinations.test.ts`. A test asserts
  that, for every reason, the retryable/permanent split agrees with `isRetryable` of the
  mapped code, and the translation refuses to let the two disagree at run time.
- **Mapping choices that are ours** (product decisions, not provider facts):
  `destination_redirected` -> `destination_url_rejected`; `destination_policy_blocked` ->
  `destination_unauthorized`; `content_policy_blocked` and `payload_rejected` ->
  `render_failed`; `signature_rejected` -> `destination_credentials_invalid`;
  `network_error` -> `destination_unavailable`; `unmapped_response` -> `internal_error`
  (retryable, bounded, flagged `unmapped`).
- **Retry-After.** `retryAfterMs` becomes whole seconds (rounded up) and feeds slice 4's
  `decideRetry`, which clamps it and prefers it to computed backoff (F178).
- **Delivered vs accepted.** Teams 2xx is `accepted`; the ledger state machine
  (`claimed` -> `accepted`, terminal) stores `deliveries.state = 'accepted'`, never `sent`.
- **Deliberate deviation from the adapters.** A 2xx the adapter cannot interpret (Slack body
  not `ok`; Lark body without a numeric `code`) is retryable-and-unmapped in the adapter, but
  retrying would re-send a message the provider may already have shown. The consumer records
  it as `accepted` (diagnostic `provider_reply_unreadable`, flagged unmapped) and does not
  retry, preserving slice 4's F100 behaviour. A Lark 2xx carrying an unknown numeric `code`
  stays retryable.
- **Canonical notification.** `DeliveryMessage` gained optional `repo`, `actor`, `status`,
  `eventType` and `summary` (<= 280 characters). The GitHub route fills them from scalar
  fields only, never a PR/issue body or the payload. Messages and outbox rows written before
  this change lack them and deliver with defaults (`eventType` `notification`). Status:
  `workflow_run.failure|timed_out` -> failure; `workflow_run.success` and
  `pull_request.merged` -> success; everything else info.
- **Teams end to end.** `teams` is accepted by the integrations API and the `integrations`
  CHECK (migration `0012_teams_destination.sql`, a table rebuild preserving every column,
  index and trigger). `triggerAuth` is an optional API field validated by
  `validateDestinationConfig`: only `anyone` is accepted, other values are `422`. It is not
  stored, because `anyone` is the only value that can exist.
- **Single validator.** The integrations API calls `validateDestinationConfig`; the
  duplicate allowlist in `src/pipeline/allowlist.ts` is gone (the file only exports the kind
  type). The consumer re-validates the decrypted URL with the same function before every
  send, and `sendRequest` checks it once more. The signing-secret whitespace/control check
  moved into `config.ts`.
- **Not verified against any real provider.** Every response in the tests is a fixture. See
  `docs/PROGRESS.md`, slice 5, for the UNVERIFIED list.

## Revisit when

- A Slack Web API, Lark app-bot or Teams bot mode ships (new capability entries, not edits).
- Real-tenant tests settle Teams card version, private channels, trigger hosts and error codes.
- Lark publishes a complete error-code table, or Lark/Teams markdown escape syntax is verified.

## Unverified provider facts

These are marked `UNVERIFIED` in code. None of them is claimed as fact.

1. GovSlack's hook hostname (`slack-gov.com` family) is not recorded, so GovSlack is rejected.
2. The reference's Slack OAuth `incoming_webhook.url` example omits `/services/`, but the
   allowlist requires it. Confirm with a real OAuth install.
3. Slack decoding `&amp;` inside `<url|label>` link URLs.
4. Slack's header-block 150-character limit is not in the reference doc.
5. Teams trigger URLs may be issued on hosts other than `*.logic.azure.com`.
6. The maximum Adaptive Card version Teams supports is unpublished, so cards are pinned to 1.2.
7. The Logic Apps status codes for a deleted or disabled flow and for an auth mismatch. The
   generic HTTP mapping is applied.
8. Whether Lark card markdown honours backslash or HTML-entity escapes. We neutralise to
   fullwidth instead.
9. The Lark `text` message body shape `{ content: { text } }`.
10. The meaning of Lark code 19001. It is left unmapped.
