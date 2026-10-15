# ADR 0057: GitHub behind the one source connector interface

Status: Accepted · Date: 2026-10-15 · Builds the typed half of F71 (spec 05) for GitHub, GitLab and Stripe; first
half of REMAINING slice 2.9. Builds on [ADR 0015](0015-provider-sources.md) and [ADR 0020](0020-canonical-event.md).

## Context

GitLab and Stripe implement `SourceConnector` (ADR 0015): `verify` over the raw bytes, a pure `map`, a closed
catalogue, a flood policy, a decoy, and one route factory drives them. GitHub did not. Its route called
`verifyGithubSignature`, `classifyGithubEvent`, `handleLifecycle`, `resolveTenant` and `repositoryInScope` directly,
and the conformance suite reached it through `SourceDescriptor`, test-side data in `tests/conformance/descriptors.ts`
(ADR 0020 decision 8). So the contract the suite checked was a copy kept next to the test, not something the
GitHub code had to satisfy, and a fourth source would have had two shapes to choose from.

GitHub does not fit the endpoint shape, and forcing it would weaken the tenant model:

- The webhook secret is App-wide. Every installation of the App signs with it, so a valid signature proves only
  that some installation sent the request. There is no per-tenant credential to look up first.
- The tenant is the installation block inside the signed bytes, looked up scoped to our App id after verification
  (`tenant.ts`). Unknown, foreign-App, missing and suspended installations are all refusals (403).
- Pings and installation lifecycle events (`installation`, `installation_repositories`, `installation_target`,
  `github_app_authorization`) are verified like any event but never route; lifecycle events change installation
  state, are audited, and answer 500 on a storage fault so GitHub's log shows a redeliverable failure.
- `X-GitHub-Delivery` is the identity, and it is outside the signature.

## Decision

1. **One interface, two tenant models.** `SourceConnector` (`src/connectors/sources/connector.ts`) is the union of
   `EndpointSourceConnector` (GitLab, Stripe; the old interface, renamed) and `InstallationSourceConnector`
   (GitHub), discriminated by `tenantResolution`. Both extend `ConnectorCore` (`types.ts`), which extends
   `SourceContract`: kind, label, adapter version, body cap, closed catalogue, `tenantResolution`,
   `credentialScope` (`source` or `app`), replay window, idempotency key and `ack`. `verify(VerifyInput)` has the
   same signature for all three: raw bytes and headers in, a verdict and the identity the verified transport
   carries out. It is still the only member that reads a credential.

2. **GitHub's differences are members, not route branches.** The installation variant declares
   `appCredential(env)` (the App secret and id, `null` means 503), `classify(headers, body)` returning
   `invalid | ping | lifecycle | event` (the event carries its catalogue type or `null`, repository, repository id
   and delivery id), `applyLifecycle`, `resolveTenant` (the App-scoped lookup, returning the existing
   `TenantResolution` union), `repositoryInScope` and `map` to the `CanonicalEvent`. Classification and mapping
   are pure; the lookups are the existing functions, unchanged, bound as members. GitHub's `verify` returns
   `eventId: null` because the delivery id is not signed; it is used only bound to the verified installation and
   organization, as before.

3. **Acknowledgement policy is declared data.** `ack` replaces `onFlood`: `onFlood` is `reject` (429 with
   Retry-After) or `absorb` (2xx and drop), `providerRetries` says whether the provider re-sends a non-2xx on its own
   (GitHub `false`, GitLab and Stripe `true`, generic `null` for sender-defined), and `ignored` is the status of a
   verified event outside the catalogue (GitHub 202, GitLab and Stripe 200, generic none). `onFlood: 'retry'` became
   `'reject'` because GitHub answers 429 too and does not retry. Uniform rules (202 only after the durable write, 200
   for an exact duplicate, 401 for anything unauthenticated) are stated once in the type, not per connector.

4. **A mechanical refactor of the GitHub route.** `githubWebhook` now reaches every GitHub step through
   `githubConnector` (`src/connectors/sources/github/index.ts`) and imports none of `events`, `tenant`,
   `lifecycle`, `catalog` or `map`. The order (configuration, content type, capped read, verify, parse, classify,
   ping and lifecycle, tenant, flood, repository scope, catalogue, canonical, fan-out), every status and body, and
   every log event and field are unchanged. The flood key reads the verified installation id from the tenant
   result instead of re-reading the body: the same number, because `readInstallationBlock` accepts only a positive
   safe integer. The GitHub fan-out (repository match, routing filters, resolution notices, legacy ids) stays in
   the route; no other source has it yet. `route-policy.ts` now names `verify` as the GitHub route's guard, like the
   provider route.

5. **The GitHub HMAC input is kept as it was.** The verifier still runs over the UTF-8 re-encoding of the decoded
   body. That equals the raw bytes for every valid UTF-8 body, which is all GitHub sends, but a body that is not
   valid UTF-8, or starts with a byte-order mark, does not verify. Verifying the exact bytes would accept such bodies
   and then parse a lossy decoding, which changes behaviour; it is a follow-up with its own test, not part of a
   refactor that promised the same responses. `tests/github/connector.test.ts` pins today's outcome.

6. **The contract moves into `src/` and the suite reads it from there.** `SOURCE_CONTRACTS`
   (`src/connectors/sources/contracts.ts`) lists GitHub, generic, GitLab and Stripe; `SOURCE_CONNECTORS` lists the
   three with connector objects. `tests/conformance/descriptors.ts` is deleted. The generic source declares a
   `SourceContract` (`generic/contract.ts`, which now owns its 256 KiB cap) but its route is not driven by a connector
   object: it has no catalogue, no pasted credential and its own id-reuse detection (ADR 0012), and refactoring it is
   not in this slice. `connector.ts` and `contracts.ts` are Worker-only (D1); `types.ts` stays free of Worker types,
   because the dashboard imports the provider registry for its credential checks.

7. **Conformance additions.** The suite now checks that every source is listed once and every connector is a
   listed contract, that `installation` pairs with an `app` credential and `endpoint` with a `source` one, that each
   connector's `verify` refuses an unparseable or non-UTF-8 body without a credential header and without throwing,
   that a flood after authentication gets the declared `onFlood` answer (429 with Retry-After, or 200 dropped) and
   writes nothing while a forged request is still 401, and that an event outside the catalogue gets exactly the
   declared `ignored` status. The GitHub connector test checks classification (header, ping, every lifecycle event,
   repository and delivery id, catalogue), `appCredential`, `verify`, and that the route's source text calls
   `appCredential`, `verify`, the verdict check, `JSON.parse`, `classify`, `resolveTenant` and `repositoryInScope`
   in that order.

## Consequences

- A fourth source picks a tenant model and implements one variant; the type checker and the conformance suite say
  what is missing. A source that needs a third tenant model must add a variant here, not a branch in a route.
- The existing GitHub route tests (`tests/github/`, `tests/github.test.ts`), the provider tests and the security
  tests pass unchanged; the assertions were not edited.
- One extra UTF-8 decode of the body per GitHub request (the connector decodes for the HMAC input, the route for
  `JSON.parse`), at most 1 MiB. Not measured.
- `SourceConnector` for the endpoint registry is now `EndpointSourceConnector`; `onFlood` moved under `ack`.

## Not done

- `parse`, `capabilities()` and `health()` of the F71 `SourceAdapter` sketch, and the setup wizard reading
  capabilities (F80).
- The generic route behind a connector object, and one shared fan-out for the three routes (ADR 0015 already lists
  the duplicated fan-out transaction).
- Verifying the exact GitHub bytes (decision 5).
- The second half of slice 2.9 (F47 to F51 event-model details).
- No real-provider delivery was used; the fixtures are documented examples, as before.

## Revisit when

- A source with a third tenant model (an OAuth-bound connection, a polled source) is added.
- The generic route or the fan-out is refactored: drive it from a connector and drop the contract-only entry.
- The wizard (F80) is built: add `capabilities()` to `ConnectorCore` so the steps render from the connector.
