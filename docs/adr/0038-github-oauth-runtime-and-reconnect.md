# ADR 0038: Workers-compatible GitHub verification and existing-installation reconnect

Status: Accepted

## Context

A live connection attempt returned `github_unavailable` despite a working signed webhook. A ping tests
only ingress; it never exchanges an OAuth code. An isolated **remote Workers preview**, with the same
compatibility date and no production bindings, reproduced the cause: fetch rejects `redirect: 'error'`
with `Invalid redirect value`. The same invalid-credential OAuth request with `manual` reaches GitHub
and returns its normal OAuth error. Node fetch mocks accepted the unsupported option and missed it.

Browser reproduction exposed a second fault: the App was already installed on RunLumi. The previous
Connect button went to GitHub's installation picker, whose Configure link opens settings and does not
return to Noti unless access is actually changed. Asking users to alter repository permissions merely
to reconnect is neither necessary nor acceptable.

## Decision

- Use `redirect: 'manual'` for OAuth exchange, GitHub API calls and token revocation. Explicitly reject
  every 3xx without following it. Keep credentials in bodies/Authorization headers, never URLs.
- Bound each provider request (10 seconds, revocation 2 seconds) and JSON response bodies (16 KiB for
  OAuth, 2 MiB for API responses). Do not retry a code exchange: a timeout may have consumed its code.
  Emit only an enumerated stage/reason and HTTP status; never an upstream body, URL, token or exception.
- The dashboard starts OAuth discovery (`POST /api/github/install` with `mode: connect`). The empty-body
  legacy installation API and setup URL remain compatible. Zero existing installations starts a fresh,
  single-use installation leg. One existing installation is verified and bound without a settings detour.
- Several installations get an explicit script-free account-choice form, not an arbitrary default. Each
  ticket is a user/workspace-bound, expiring, single-use `verify` state **without** a PKCE verifier. It is
  not an OAuth state: the OAuth callback refuses it. Same-origin form submission consumes that ticket and
  issues fresh PKCE verification for the chosen installation. Authority is verified again against GitHub.
  There is no stored GitHub user access token and no schema migration or new tenant authority source.
- Discovery checks at most ten pages and offers at most twenty matching accounts; an incomplete list is
  refused, never silently truncated. Selected repositories retain their 1,000-row ceiling, with a one-row
  lookahead so exactly 1,000 is accepted and 1,001 is refused. All-repository installations are not enumerated.
- Recheck workspace membership after the provider requests and revocation, immediately before binding.
  Keep existing cross-workspace binding, tombstone, organization-admin and repository-scope guards.
- The temporary account-choice page is opaque paper/navy/blue with a script-free, same-origin form and
  explicit CSP. Its only public resource is a constant stylesheet, documented in the route policy. It
  uses the system sans fallback rather than loading the SPA and its JavaScript for an OAuth handoff.
  English and Vietnamese labels use the browser's Accept-Language on this interstitial.

## Consequences

Connect/reconnect can succeed without changing an existing installation. New accounts still go through
GitHub installation and permission consent. Multiple accounts require a second short OAuth verification
round trip, so the access check cannot become stale between discovery and choice. A failed/expired state
requires a fresh Connect attempt; no exhausted code is retried. No change grants additional GitHub
permissions or connects a different workspace. Signed webhook acceptance is still not destination E2E proof.

## Verification

Regression tests cover the unsupported fetch option, redirects, non-2xx/rate limits, timeout exceptions,
invalid/oversized JSON, malformed repository lists, all/selected repository limits, zero/one/multiple
installations, choice replay/expiry/user isolation/Origin, XSS escaping and lost workspace authority.
The patched **actual install module** was also exercised from remote Workers with intentionally invalid
credentials: it reached GitHub and returned `oauth_failed`, rather than the old local fetch-init failure.
A credentialed live browser connection must be checked after deployment; unit fixtures alone cannot pass
that acceptance step.

## Revisit when

GitHub changes setup/authorization behavior, installation pagination exceeds these bounds, or Workers
reliably supports error-mode redirects under the deployed compatibility settings. Do not remove manual
redirect rejection merely because DOM types or documentation accept the value.
