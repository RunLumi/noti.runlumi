# ADR 0040: Credential-host binding and no-secret-in-logs proofs; the unmapped flag and the reconnect prompt stay open

Status: Accepted · Date: 2026-10-15 · Implements the remainder of slice 1.19 and slice 1.24 of
[`docs/specs/REMAINING.md`](../specs/REMAINING.md): F228 (the credential-host binding test), F234 (the no-token-in-any-log
test). Leaves open F98 and F229 (the reconnect prompt), and F230 (persisting the unmapped flag). Builds on
[ADR 0026](0026-egress-guards.md), [ADR 0030](0030-sessions-and-device-list.md) and [ADR 0036](0036-credential-destruction-and-boot-hygiene.md).
**No migration.** No real provider or real D1 was used.

## Context

ADR 0026 left the credential-host binding test (`credential_is_never_sent_to_a_host_other_than_its_own`, F228) open, and
ADR 0030 left a no-token-in-any-log test (F234) open. The spec also asked that the unmapped-provider-response flag be persisted
on the ledger when that needs no migration. The brief for this slice was to prove the two invariants over the real code paths
and to fix what a proof found.

## Decisions

1. **The binding invariant is tested over every outbound path, and no path was found that breaks it.**
   `tests/security/credential-host-binding.test.ts` plants a unique marker in each stored credential (the Slack, Teams, Lark and
   Discord URL paths or queries, and the custom webhook URL) and a signing secret (Lark, custom webhook). It records every request
   the code would send and asserts, for each request: a marker that appears anywhere on the wire (URL, header or body) is on a
   request to the host that marker was registered for, and a signing secret never appears on the wire. The paths:
   - `deliver` (render, build, send, classify) for all five kinds, including the Discord path rewrite and the `wait` parameter;
   - `sendRequest` with a URL registered for another kind, for all 12 pairs of the four registry kinds: refused as
     `destination_url_rejected` with zero requests;
   - a redirect: one request, `redirect: 'manual'`, classified `destination_redirected`, the target never contacted;
   - the alert webhook sink (`ALERT_WEBHOOK_URL`, the operator's credential, same policy);
   - the save-time DNS lookup for a custom host (`hostVerificationError`): the resolver receives only `name` and `type`, the
     hostname, and never the path or query that hold the credential;
   - the delivery consumer, with an integration row whose kind says `discord` and whose stored credential is a Slack URL: no
     request, `dead_lettered` with `destination_url_rejected`.
   `tests/github/install-flow.test.ts` gains the same invariant for the GitHub App install flow: the request recorder now keeps
   headers, every request names one of two fixed origins (`https://github.com`, `https://api.github.com`), the user token is sent
   only to the API origin, and the client secret only to those two.

   **Why it holds (read from the code, not assumed):** the URL is the credential for four of the five kinds, and each stored
   URL is validated against the kind of the row that holds it, both when it is written and again in the consumer before any
   request (`validateDestinationConfig` in `resolveTarget`), and again in `sendRequest`. The PATCH path cannot change an
   integration's destination kind (`parseUpdateIntegration` receives the stored kind). The adapters send only `config.webhookUrl`,
   and the Discord rewrite changes the path only. GitHub's hosts are constants in `install.ts`, and the installation id that
   becomes a path segment is matched by `^[1-9][0-9]{0,15}$` at the setup boundary. The DNS lookup carries only the query name.

   **The test has teeth, shown by a mutation:** with the send-time URL check disabled, the cross-kind test fails. The consumer
   test still passes in that mutation because validation refuses the URL one layer earlier; the two layers are independent and
   both are asserted.

   **What it does not prove:** that no other code path can ever send a credential (an alias the AST guard of ADR 0026 does not
   follow, a dependency); DNS rebinding (AR-3); the Teams wildcard (AR-15); anything about a real provider.

2. **The unmapped flag is not persisted: the gap is recorded, no migration is added.** `delivery_attempts` (migration 0025) has
   no column that can carry the flag without changing what an existing column means. `reason` and `error_code` are closed
   taxonomies with length limits; writing the flag into either would overload them. The `unmapped_provider_response` log event
   (ADR 0026) remains the only record, and the SLI list still says so. A column needs a migration, which this slice may not add;
   it belongs with slice 1.6 (see ADR 0026).

3. **No token, password, secret or hash prefix reaches the console on the auth, session and webhook paths.**
   - `tests/security/no-token-in-logs.test.ts` drives the real Worker over real Better Auth (the auth harness of ADR 0030):
     sign-up and verification, a wrong-password sign-in, two more sign-ins, the session list, revoke one, revoke-others, a made-up
     cookie, a raw token presented without its signature, a password reset (which ends every session), the restore script
     (`scripts/revoke-all-sessions.mjs`), and a sign-in with the new password. Every console method is captured. The planted
     values are the auth secret, the three passwords, every session token in the database, every verification value, every token
     in a mail link, every cookie value, and each one's SHA-256 hex and base64url prefixes and its part before the dot.
   - `tests/security/webhook-logs.test.ts` drives the GitHub ingress: a delivery signed with the wrong key, an unsigned delivery,
     an oversized delivery, and an accepted delivery. The planted values are the webhook secret and the presented signature.
   - `tests/support/log-capture.ts` holds the shared capture and the matcher. Each test also proves its capture works (a control
     line is captured) and that the matcher finds a planted value when it is present, so a silent console or a broken matcher cannot
     pass.

   **Result:** no leak was found, so nothing in `src/` changed. **What the result covers, stated plainly:** a successful request
   writes no line of its own. In the auth flows the only captured line is Better Auth's `Invalid password`, and the webhook refusal
   writes nothing; the only webhook-side line that exists is `github_event_too_large`, which the oversized case asserts is written
   and checks for leaks. The no-leak assertions on the refusal paths are therefore a regression tripwire: they fail as soon as a
   refusal starts to write a value. The static guard that forbids console calls which pass bodies or headers (ADR 0036 and
   `tests/security/static-guards.test.ts`) is the other half of the control.

4. **The reconnect prompt when a host is removed (F98, F229) is not built.** It is not a small pure change: the prompt needs an
   integration status on the API, a dashboard state with English and Vietnamese copy, and the DESIGN.md treatment, and each of
   those carries its own ADR and FRONTEND.md obligations. The registry has never removed a host, so there is no case to surface
   yet. What exists today: a removed host makes the send refuse with `destination_url_rejected`, which dead-letters the delivery
   (the existing behaviour, and the one the spec's errors table names). `isAllowedHost(kind, host)` in `provider-registry.ts` is the
   pure check a future prompt would call; it is not wired to anything.

5. **The provider pages are not re-read, and `verifiedOn` is not changed.** Every entry stays at `2026-10-13`, as ADR 0026 records.

## Not done

- Persisting the unmapped flag in the ledger (needs a migration; with slice 1.6).
- The reconnect prompt when a host is removed (F98, F229), per decision 4.
- A human re-read of the provider pages (F229), so `verifiedOn` stays where ADR 0026 put it.
- The restore script run against a real D1 (F234, UNVERIFIED, `docs/RELEASE_GATES.md`). The script was run only against the Node
  SQLite stand-in.
- A staging run of any of this, and real-provider acceptance evidence. Nothing here contacted a provider.
- The credential-host binding for DNS rebinding (AR-3) and the Teams wildcard (AR-15), which the test does not cover.
- The spec status of F228 and F234 is updated in `docs/specs/15-security-and-compliance.md`; `docs/specs/STATUS.md`, the README
  counts and `REMAINING.md` are for the coordinator to regenerate and reconcile. Until then `tests/spec-status.test.ts` reports the
  generated status out of date.

## Verification

- `tests/security/credential-host-binding.test.ts` (16 tests), `tests/security/no-token-in-logs.test.ts` (1 test),
  `tests/security/webhook-logs.test.ts` (3 tests), `tests/github/install-flow.test.ts` (the new invariant in addition to the 44
  existing tests). All pass.
- Mutation: with the send-time URL check disabled in `src/connectors/destinations/send.ts`, the cross-kind test fails (restored
  afterwards; the file is unchanged in the diff).
- Gates run on this branch: see the coordinator's report for the results of `typecheck`, `typecheck:web`, `eslint`, `prettier`,
  `docs:check` and the full unit suite.
- Nothing here exercised a real provider or a real D1.

## Consequences

- No runtime behaviour changed. The new tests are in `tests/`, and one existing test file gains a recorder field (`headers`).
- Two more invariants are now checked by tests that a future change must keep green: a credential's host is its own on every
  request path, and no secret reaches the console on the auth, session and webhook paths.
- The spec and the threat model cite these tests as evidence. `docs/THREAT_MODEL.md` rows for SSRF and for tokens in logs name them.

## Revisit when

- A destination kind starts sending a credential in a header rather than in its URL. The binding test already checks headers and
  bodies for markers, but a new credential needs its own marker in the fixtures.
- A host is removed from the registry for the first time: build the reconnect surface then (decision 4).
- The ledger is next migrated: add the unmapped column and the test that reads it (decision 2).
- The restore script is run against a real D1, or a log line is added on a refusal path that carries request data.
