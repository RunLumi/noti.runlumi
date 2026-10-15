# ADR 0041: Delivery P1s: ack ordering, rollback, settled background tasks, Slack Web API codes

Status: Accepted · Date: 2026-10-15 · Implements slice 2.17 of [`docs/specs/REMAINING.md`](../specs/REMAINING.md) in part: F169 (tests and lint rule), F179 (Slack Web API codes, unwired). F177 and F180 are not changed here. Builds on [ADR 0005](0005-delivery-reliability.md), [ADR 0006](0006-destination-adapter-contract.md) and [ADR 0023](0023-delivery-ledger-depth.md).

## Context

Four P1 gaps were open against the delivery path:

1. **Ack ordering (F169)** had code that looked right (one `db.batch()` before the 202, dispatch through `waitUntil`, consumer acknowledgement after the ledger batch) but no test over the real ingress path that pinned it.
2. **Rollback (F169, F172)**: the outbox-level release after a failed `send()` was tested in isolation. Nothing asserted, end to end, that a failed queue hand-off leaves no delivery `sent` and leaves the row claimable.
3. **Unsettled background work.** Five `waitUntil(...)` call sites in `src/` passed a promise that could reject (the outbox dispatch, and the auth email send). A rejection there is an unhandled promise rejection with no record of which task failed.
4. **Slack error codes (F179).** The Slack adapter sends incoming webhooks only. Its classifier maps the webhook's plain-text tokens. There is no `chat.postMessage` (Web API) send path, so the Web API `{ "ok": false, "error": ... }` tokens had no classifier.

The Slack reference could not be re-read in this session. The egress proxy refused `docs.slack.dev` with HTTP 403 (a policy denial, which we do not route around). The only Slack error-code source is `docs/DESTINATION_API_REFERENCE.md` section 1.3, read from the Slack reference on 2026-10-13.

## Decision

1. **Ack ordering is pinned on the real ingress path** (`tests/pipeline/delivery-path.test.ts`, "ack ordering on the real ingress path"). The tests assert:
   - the dispatch kick is scheduled only after the event is committed (one outbox row exists when `waitUntil` is called);
   - the queue send sees the row `claimed` by this dispatcher, and the `dispatched` mark follows the send;
   - when the durable batch fails, the response is 5xx, nothing is scheduled and nothing reaches the queue.

   **No ordering bug was found.** The batch precedes the 202 on all three source routes, and the consumer acknowledges only after the fenced ledger batch (`applyDecision`, `handleUnclaimable`). A test that asserts "pending at answer time" was tried and removed: the in-memory D1 completes the dispatch within the same microtask turn, so it is not an ordering property. The test asserts the commit count at kick time instead.

2. **Rollback is pinned end to end** (same file, "rollback when the queue send fails"). A rejected `send()` leaves the outbox row `pending` with its lease cleared, `last_error_code` `internal_error` and a 30 s `not_before`. The delivery stays `pending`, not `sent`, and no provider is called. After the back-off, one dispatch hands the row over once, and consuming it marks the delivery `sent`. No code change was needed.

3. **Background promises are settled, and a lint rule enforces it.**
   - `src/platform/background.ts` exports `settleBackground(task, label)`. It returns a promise that never rejects and logs the failure once through `log('error', 'background_task_failed', { task, error })`, so the log is redacted like every other line.
   - `eslint-rules/no-unguarded-waituntil.mjs` is a local ESLint rule, registered in `eslint.config.js` for `src/**/*.ts` only. A `waitUntil(...)` argument passes when it is `<expr>.catch(...)`, `<expr>.then(onFulfilled, onRejected)`, a call to `settleBackground(...)`, or an identifier whose single, never-reassigned declaration is initialised with one of those. Anything else is an error.
   - A local rule is about 60 lines and the flat config supports it directly, so no AST test was written. The rule's own tests are `tests/lint/no-unguarded-waituntil.test.ts` (RuleTester, 14 cases).
   - The rule found five violations: the outbox dispatch at `src/api/test-send.ts`, `provider-route.ts`, `generic/route.ts` and `github/route.ts`, and the auth email send at `src/auth/better-auth.ts`. Each is now wrapped in `settleBackground`. The wrapping changes no status code, no ordering and no retry behaviour.
   - **What the rule does not prove.** It checks that a `waitUntil` promise is settled, not where a send happens. Its limits: it follows identifier aliases only, not other helper functions, so a non-guard helper that returns a rejecting promise is reported (a conservative error, never a silent pass).

4. **Slack Web API error mapping** (`src/connectors/destinations/slack/web-api.ts`, `classifySlackWebApiResponse`). Slack reports most Web API failures as HTTP 200 with `{ "ok": false, "error": "<token>" }`, so the token carries the meaning.
   - Transient, retryable: `ratelimited` and `rate_limited` (`destination_rate_limited`, `Retry-After` honoured), `internal_error`, `fatal_error` and `service_unavailable` (`destination_unavailable`), `request_timeout` (`destination_timeout`). HTTP 429 and 5xx use the generic HTTP classifier.
   - Permanent: credential or access tokens (`invalid_auth`, `token_revoked`, `token_expired`, `account_inactive`, `team_not_found`, `ekm_access_denied`, `missing_scope`, `no_permission`, `not_in_channel`) map to `destination_unauthorized`. `channel_not_found`, `is_archived` and `team_disabled` map to `destination_revoked`. `posting_to_general_channel_denied` and the `restricted_action*` family map to `destination_policy_blocked`. `invalid_blocks`, `invalid_blocks_format` and `no_text` map to `payload_rejected`. `msg_blocks_too_long` maps to `payload_too_large`.
   - Any other token is retryable and flagged `unmapped`. A `providerCode` is only ever a token from these tables, never free text from the body (ADR 0006). `msg_too_long` and `message_limit_exceeded` are deliberately not mapped, because the reference does not classify them.
   - **Not wired.** The adapter has no Web API mode, so nothing calls this classifier. It is covered by `tests/destinations/slack-web-api.test.ts` (34 cases).

## Consequences

- Five call sites change signature only: `waitUntil` receives `settleBackground(...)`. Failures now appear as one `background_task_failed` log line with a task label.
- The ordering and rollback tests make the existing behaviour a pinned contract. A later change that moves the kick before the commit, or marks a row before the send, fails CI.
- The Slack mapping is a claim about the Slack reference as read on 2026-10-13. It is not verified against the live Slack documentation, and not against a real workspace. Every Slack response in the tests is a fixture.
- `eslint.config.js` gains one plugin and one rule for `src/`. Lint runs unchanged otherwise.

## Not done

- **F180 per-connection retry policy.** Storing a policy on each connection needs a column on `integrations` and therefore a migration. This slice does not create migrations, so the policy stays a function parameter (F177's note) and is not stored or editable.
- **Slack Web API send mode.** No `chat.postMessage` adapter, OAuth install or bot token handling exists. The classifier is ready for it.
- **Live re-verification of Slack codes.** Needs `docs.slack.dev` to be reachable from this session, or a real workspace.
- **Real-provider evidence** for every destination. All provider responses in the tests are fixtures.

## Revisit when

- A Slack Web API send mode is built: wire `classifySlackWebApiResponse` into `slack/adapter.ts`, re-read the `chat.postMessage` error list, and add codes only from that page.
- Per-connection retry policy is approved as a migration: store it on `integrations` and read it in `decideRetry`.
- The repo adopts a shared ESLint plugin that already covers settled background promises; the local rule can then be removed.
