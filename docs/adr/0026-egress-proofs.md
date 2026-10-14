# ADR 0026: Egress proofs: one send path, a provider registry with expiry, an unmapped-reply event

Status: Accepted · Date: 2026-10-14 · Implements slice 1.19 of
[`docs/specs/REMAINING.md`](../specs/REMAINING.md): F228, F229 (in part), F230 (the metric gap).
Spec 15 is authoritative. Builds on [ADR 0006](0006-destination-adapter-contract.md) and
[ADR 0014](0014-extended-destinations.md). No migration.

## Context

The mechanism for outbound safety already existed: one URL policy, re-run before every send,
`redirect: 'manual'`, bounded body and time. What did not exist was proof that it stays the only
path (nothing stopped a later change adding a bare `fetch(` elsewhere), a reviewable list of
hosts with provenance and expiry (the hosts were regex-adjacent code with comments), and any
signal when a provider replies with something no mapping covers (the flag was only a field on
the attempt log).

## Decisions

1. **A static test owns the egress surface (F228).** `tests/security/egress.test.ts` strips
   comments and string contents from every file under `src/` and fails on a global `fetch(`
   call or alias, `globalThis.fetch`, `XMLHttpRequest`, `new WebSocket`, `cloudflare:sockets`
   or a Node HTTP client import. Method calls such as `assets.fetch(` and handler definitions
   are not flagged. Three files are listed with a reason and must carry an `EGRESS-ALLOWED:`
   comment: `send.ts` (the only path to a customer-configured URL), `dns-check.ts` (a fixed
   DNS-over-HTTPS endpoint, only the query name varies) and `github/install.ts` (GitHub App
   install verification against two constant hosts). The third was found by the test itself.
   The test also checks that a listed file still makes a call (no stale entries) and that
   `send.ts` runs the URL policy before building the request.
2. **The registry is the host source (F229).** `provider-registry.ts` holds one typed entry per
   provider with exact hosts, path prefixes, `docsUrl`, `verifiedOn`, and a written reason for
   the one wildcard (Teams `logic.azure.com`, AR-15) or an opaque path. `url-policy.ts` takes its
   host match and path prefix from it; shape rules (Slack and Discord path patterns, Discord
   query keys, the customer-host policy) stay in `url-policy.ts`.
3. **Expiry is a test (F229).** A registry test fails when any `verifiedOn` is more than 180 days
   old and when it is in the future. It reads the real clock: it will start failing on its own
   and the fix is to re-read the page and correct the entry, then bump the date.
   - `verifiedOn` is 2026-10-13, the research date of `docs/DESTINATION_API_REFERENCE.md`, which
     cites each page. This change did not re-read the provider pages; the date records when the
     reference was written from them. Entries repeat the reference's UNVERIFIED notes in `caveat`.
4. **Matching is exact and slightly stricter than the spec.** No `endsWith` on a bare string; a
   wildcard needs well-formed subdomain labels. A trailing-dot host is rejected rather than
   normalised: the spec asks for trailing-dot insensitivity, and rejecting cannot widen the list.
5. **An unmapped reply is its own event (F230).** The consumer emits `unmapped_provider_response`
   at `warn` with delivery, workspace, integration, destination kind and status class, and never
   the reply body, status text or URL. It is a log event, not an aggregated or persisted metric:
   the SLI list still says so.

## Not done

Reconnect prompt when a registry host is removed (F98); registry entries for Telegram (not a
destination); human re-verification of the docs pages; persisting the unmapped flag in the ledger
(needs a migration, bundle with 1.6); Gateway egress (a Zero Trust decision, AR-2).

## Verification

Unit tests listed above, all in `npm run check`. Nothing here exercised a real provider.
