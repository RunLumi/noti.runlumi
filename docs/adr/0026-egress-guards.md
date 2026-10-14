# ADR 0026: Egress guards: a regression test for the outbound surface, a provider registry, an unmapped-reply event

Status: Accepted · Date: 2026-10-14 · Implements slice 1.19 of
[`docs/specs/REMAINING.md`](../specs/REMAINING.md): F228 (regression guard), F229 (in part), F230
(the metric gap). Spec 15 is authoritative. Builds on [ADR 0006](0006-destination-adapter-contract.md)
and [ADR 0014](0014-extended-destinations.md). No migration.

## Context

The mechanism for outbound safety already existed: one URL policy, re-run before every send,
`redirect: 'manual'`, bounded body and time. What did not exist was a guard against a later change
adding another path to the network, a reviewable list of hosts with provenance and expiry, and any
signal when a provider replies with something no mapping covers (the flag was only a field on the
attempt log). None of this is a proof of absence: it is a set of guards that make the common
regression fail a test.

## Decisions

1. **An AST regression guard watches the egress surface (F228).** `tests/security/egress.test.ts`
   parses every file under `src/` with the TypeScript compiler (`tests/support/egress-ast.ts`), so
   comments, strings, template interpolations and regex literals are handled by the parser, not by
   regular expressions. It fails on every reference to the global `fetch` (calls, aliases,
   `.bind`, shorthand, destructuring, default parameters), `fetch` on `globalThis`, `self`,
   `window` or `global`, `globalThis` used as a value, `WebSocket`, `EventSource`,
   `XMLHttpRequest`, `sendBeacon`, `eval` and `Function`, and static or dynamic imports and
   `require` of `cloudflare:sockets`, Node network modules or common HTTP client packages.
   - `X.fetch` is exempt only when `X` is a binding on `env` (`env.ASSETS.fetch`) or a receiver
     listed per file in `IN_PROCESS_FETCH_RECEIVERS` (the Hono app, the TanStack server entry, the
     assets binding, and the injected `options.fetch` of `sendRequest`).
   - **Limits, stated plainly:** it does not follow a value through aliasing (`const g = self;
     g.fetch(...)`), through a helper that receives `fetch` from a caller outside `src/`, or
     through a dependency. It is a regression guard, not a proof.
   - Three files are allowed, each with a reason and an `EGRESS-ALLOWED:` comment: `send.ts` (the
     only path to a customer-configured URL), `dns-check.ts` (a fixed DNS-over-HTTPS endpoint) and
     `github/install.ts` (GitHub App install verification, found by the first run of the test).
     Each is pinned to exactly one reference to the global `fetch`, and by AST to its call sites:
     `send.ts` has one `doFetch(request.url, ...)` after a top-level `if (!checkDestinationUrl(
     request.kind, request.url, ...).ok) return ...` in the same function; `dns-check.ts` has one
     call whose URL starts with the `DOH_ENDPOINT` constant; `install.ts` has three calls, each
     starting with the `GITHUB_API` or `GITHUB_WEB` constant.
2. **The registry is the host source (F229).** `provider-registry.ts` holds one typed entry per
   provider with exact hosts, path prefixes, `docsUrl`, `verifiedOn`, host labels (the Lark
   regional deployment, so there is no second host list) and a written reason for the one wildcard
   (Teams `logic.azure.com`, AR-15) or an opaque path. `url-policy.ts` takes its host match, path
   prefix and Lark domain from it; shape rules stay in `url-policy.ts`.
3. **Staleness is reported weekly, not enforced on pull requests (F229).** A date-driven failure
   in `npm run check` would break every pull request on the same day, so the 180-day test lives in
   `tests/stale/`, excluded from `npm test`, and runs from `npm run check:stale` in the scheduled
   `registry-staleness.yml` workflow (weekly and on demand). The check that a `verifiedOn` is not
   in the future stays in the blocking suite.
   - **`verifiedOn` is an attestation nobody made yet.** For every entry it is 2026-10-13, the
     research date of `docs/DESTINATION_API_REFERENCE.md`, which cites the pages. The pages were
     not re-read when the registry was written. Whoever re-reads a page and bumps the date makes
     the attestation. Entries repeat the reference's UNVERIFIED notes in `caveat`.
4. **Matching is exact and slightly stricter than the spec.** Host equality, or a well-formed
   subdomain of a declared wildcard suffix compared with a dot boundary. A trailing-dot host is
   rejected rather than normalised: the spec asks for trailing-dot insensitivity, and rejecting
   cannot widen the list.
5. **An unmapped reply is its own event (F230).** The consumer emits `unmapped_provider_response`
   at `warn` with delivery, workspace, integration, destination kind, attempt number, numeric HTTP
   status and status class, and never the reply body, status text or URL. It is a log event, not
   an aggregated or persisted metric: the SLI list still says so.

## Not done

Reconnect prompt when a registry host is removed (F98); human re-verification of the docs pages;
persisting the unmapped flag in the ledger (needs a migration, bundle with 1.6); Gateway egress (a
Zero Trust decision, AR-2); following aliased values in the guard.

## Verification

Unit tests above, all in `npm run check` except the weekly staleness test. Nothing here exercised
a real provider.
