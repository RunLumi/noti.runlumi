# ADR 0004: Destination adapter contract, capability model and response taxonomy

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
8. **Compatibility.** `lark/webhook.ts` keeps `larkPayload`, `larkAccepted`, `larkCard` and
   `larkSignature` for the current consumer in `src/index.ts`, which this slice deliberately
   does not edit (slice 2 is rewriting it).

## Consequences

- The consumer must switch to `prepareDelivery` / `sendRequest` / `classifyDeliveryResponse` (or
  `deliver`) and persist `outcome`, `reason`, `retryAfterMs`, `format`, `degradedFrom`,
  `truncatedFields` and `redactedFields`. Until then Slack still uses the inline string.
- Status is conveyed as text (`Failed: …`) as well as colour, for accessibility.
- Facts marked `UNVERIFIED` in code are not claims; each names what to check.

## Revisit when

- A Slack Web API, Lark app-bot or Teams bot mode ships (new capability entries, not edits).
- Real-tenant tests settle Teams card version, private channels, trigger hosts and error codes.
- Lark publishes a complete error-code table, or Lark/Teams markdown escape syntax is verified.
