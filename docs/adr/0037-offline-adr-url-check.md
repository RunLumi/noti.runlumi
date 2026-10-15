# ADR 0037: Offline structural check of external references in ADRs

Status: Accepted · Date: 2026-10-15 · Records the offline half of F14 (spec 01) for slice 2.18. Extends the ADR checks in
[`scripts/check-docs.mjs`](../../scripts/check-docs.mjs); the decisions it guards are [ADR 0031](0031-no-durable-objects-v1.md) to [ADR 0035](0035-at-least-once-delivery-contract.md).
**No code change outside the docs check, no migration.**

## Context

ADRs 0031 to 0035 make claims about Cloudflare limits and standards: Durable Objects, Queues delivery, D1 throughput and size,
and the Secrets Store beta. F14 says an ADR whose referenced limit has no URL is an unverified claim that blocks release
review. Before this change none of the five cited a URL, and nothing checked that a URL in any ADR was well formed.

Checking that a URL still resolves needs the network. On 2026-10-15 the agent sandbox could not reach
developers.cloudflare.com (the proxy refused the tunnel), so a live check could not be run in this change.

## Decision

1. `scripts/check-docs.mjs` checks every `http(s)://` URL in `docs/adr/`, offline: the scheme is https, the URL parses,
   it does not end in punctuation taken from the prose (`.`, `,`, `;`, `:`, `!`, `?`, `*`), and a markdown link destination
   contains no whitespace. A closing parenthesis the URL did not open is markdown syntax, not part of the URL.
2. ADRs 0031 to 0035 (`SOURCED_DECISION_ADRS`) must exist and cite at least one https URL. The set is an explicit list, so
   a new decision ADR joins it by an explicit edit, not by a pattern.
3. The check makes no network request. CI stays offline, with no new network dependency and no flake from a remote host.
4. The five ADRs cite the official URLs that the specs already quote with a read date (2026-10-13). Claims with no recorded
   quote, and the Durable Objects page, are marked **not re-read** in each ADR. ADR 0014's bare URL, which ended in a comma,
   is wrapped in an autolink.

## Consequences

- A plain-http link, a URL that does not parse, or a stray trailing comma fails `npm run docs:check` and therefore
  `npm run check` before merge.
- A passing check does not show that a URL resolves or that the page supports the claim. Both stay a human re-read,
  recorded in each ADR's Sources list and in F14.
- A URL that legitimately ends in one of the flagged characters is written as an autolink (the URL wrapped in angle
  brackets), not by weakening the check.

## Revisit when

- A scheduled job with network access, outside the required CI gate, is approved to verify links; its results would
  carry a date (F14, human re-read).
- The set of decisions that rest on external claims grows past ADRs 0031 to 0035: add the number to
  `SOURCED_DECISION_ADRS`.
- A cited Cloudflare or provider page moves, or a cited URL is found dead.
