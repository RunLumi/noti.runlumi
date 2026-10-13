# Implementation progress

This is the running record of how far the code has moved through the
[F01–F262 spec catalog](specs/README.md). It is updated in every PR that changes behaviour.
The specs say what to build. This file says what has been built, what is verified, and what
is not yet started.

Status legend: ✅ shipped and covered by tests · 🟡 partly shipped (the gap is named) ·
⬜ not started. "Shipped" means merged to `main` and passing CI. It does **not** mean
production-ready. Per `AGENTS.md`, that also needs real-provider end-to-end validation, a
tenant-isolation and secret-handling review, and a rollback rehearsal. None of those has
happened yet.

## Delivery slices

Work ships as vertical slices in dependency order (see
[`specs/00-current-state.md` §4](specs/00-current-state.md#4-distance-to-a-launchable-v1)).
Each slice is one PR. A PR is merged only once CI passes.

| # | Slice | Specs | Defects | State | PR |
| --- | --- | --- | --- | --- | --- |
| 1 | Inbound tenant resolution from verified GitHub installation; multi-workspace membership | F15, F25 (expand), F59 | D2 (expand), D3, N6 (inbound) | ✅ | #6 |
| 2 | Worker modularisation, envelope encryption with AAD and key version, queue messages carry ids not secrets, delivery-path integration tests | F33, F35–F37 (F34 tier 2) | D5, D6, D13 | ✅ | #7 |
| 3a | Tenant-scoped integrations API; domain capabilities; audit log; closed GitHub event catalog; write-time allowlist; DB-enforced tenant contract | F24, F26, F28, F61 (catalog), F72 (write-time) | D9, D12, D16, D2 (contract for new writes) | ✅ | #9 |
| 3b | GitHub App install flow (verified installation binding), lifecycle events, repository-selection enforcement | F55–F57, F67, F68 | N6 | ✅ | #11 |
| 4 | Delivery reliability: atomic claim, error taxonomy, bounded retries, dead letter, manual redelivery | F11–F13, F170, F172–F180, F182, F184, F189 (partial; see section) | D4, D10, D11 (partial) | 🟡 | #10 |
| 5 | Destination capability model; Slack, Teams and Lark adapters, wired into the delivery consumer; Teams as a destination kind | F91–F104 | D8 | ✅ (no real-provider test) | #8, wiring PR |
| 6 | Dashboard: setup wizard, integrations, delivery log, test send | F205–F226 | — | ⬜ | — |
| 5 | Destination capability model; Slack and Teams adapters (adapters shipped as pure modules; consumer wiring pending slice 4) | F91–F104 | D8 | 🟡 | — |
| 6a | Dashboard: integrations list, guided create wizard, settings (edit, pause, rotate, delete), GitHub connection panel and repository picker | F206 (partial), F210 (partial), F211, F216 (partial), F217 (partial), F220 (partial), F221, F223, F224 (structure), F225 | — | 🟡 | #13 |
| 6b | Dashboard: delivery log and manual redelivery (API and UI; migration 0013 indexes), workspace export and deletion screens, Teams in the create wizard. Test send and the setup-progress model remain | F181 (part), F182 (part), F213 (part), F218 (part), F211 (Teams) | D11 (surface) | 🟡 | #16 |
| 7 | Per-integration routing filters with provenance (backend, API, dashboard); the F121 rule engine is not started | F124, F125, F127, F128, F136–F140 (each in part) | — | 🟡 | #25 |
| 8 | Grouping, digests and noise control | F141–F168 | — | ⬜ | — |
| 9 | Observability and runbook: correlation id, D1-derived SLIs and summary API, stall detection, retention, operator runbook | F193 (partial), F194 (partial), F197 (partial), F198 (partial), F200 (partial), F201 (partial) | — | 🟡 | #16 |
| 10 | Additional sources and destinations, gated on demand evidence | F73–F90, F105–F120 | — | ⬜ | — |
| W | Workspace export and two-phase deletion; retired-schema guard; single destination allowlist | F30, F31 | N3 | ✅ | #12 |
| S | Security hardening: response headers and CSP, ingress limiter helper, CI supply chain, threat model, static guards | F29 (wired), F227 (partly), F231 (partly), F239 (partly), F240 (checklist), F241 (register), F242 (disclosure policy only) | — | 🟡 | #16 |

AI features (F243–F262) stay out of scope until the delivery ledger is trustworthy. See
[`specs/00-current-state.md` §5](specs/00-current-state.md#5-non-goals-this-audit-implies).

## Slice 1 — inbound tenant resolution (PR #6)

**What changed**

- `migrations/0006_multi_org_and_tenant_scoping.sql`
  - Drops `member_one_org_per_user`, the index that actually blocked a second workspace.
  - Adds `member_user_org_unique`, so a user still cannot hold two memberships in the *same*
    workspace.
  - Adds a nullable, indexed `organization_id` to `integrations`, `deliveries` and
    `notification_outbox`. This is the expand phase.
  - Adds `github_installations`, unique per `(installation_id, app_id)`, with
    `ON DELETE CASCADE` to `organization`.
- `src/index.ts`
  - `readInstallationBlock()` is the pure parser. It requires a positive safe-integer
    `installation.id` and rejects any `app_id` that is present but is not our App's.
  - `resolveTenant()` looks up the installation scoped to `GITHUB_APP_ID`. An unknown, foreign,
    missing, suspended or uninstalled installation returns `403`. There is no fallback.
  - Integration lookup is now `WHERE organization_id=? AND repo=?`. `organization_id` is
    written to both the delivery row and the outbox row in one D1 batch.
- `GITHUB_APP_ID` is a declared var. It ships as a placeholder, which makes ingress fail
  closed until a real App is configured.

**Verified by**

- `tests/tenant-resolution.test.ts`: 9 cases. They cover a missing block, a non-object block,
  a non-integer, string, negative or zero id, a foreign App, a non-numeric `app_id`, an absent
  `app_id`, and a guarantee that a `repository` field never resolves a tenant.
- `scripts/test_auth_schema.py`: cross-workspace membership is allowed, a duplicate
  membership in the same workspace is rejected, and one installation cannot be claimed by two
  workspaces.

**Known gaps, carried to slice 3**

- No install flow writes `github_installations` yet, so production ingress returns `403` for
  every event. This is intentional: it fails closed.
- Existing `integrations` rows have `organization_id = NULL`, so nothing routes to them. They
  need a backfill before the NOT NULL contract migration.
- The queue consumer does not yet re-check `organization_id` against the integration. That
  arrives with slice 2, when messages carry ids instead of ciphertext.

## Slice 2 — envelope encryption and id-only queue messages (PR #7)

**What changed**

- `src/index.ts` is now a thin entry point. Responsibilities moved to:
  - `connectors/sources/github/{route,tenant}.ts`
  - `pipeline/{outbox,consumer,credentials}.ts`
  - `crypto/{envelope,keyring-env}.ts`
  - `env.ts` and `lib/json.ts`
- Envelope encryption follows [ADR 0004](adr/0004-envelope-encryption.md): an HKDF tenant key
  wraps a per-connection DEK, the DEK seals each field, and the AAD binds every ciphertext to
  org, connection, field and purpose. The envelope format is versioned and stored as a `BLOB`.
- `migrations/0007` adds the envelope and quarantine columns. It also rebuilds
  `notification_outbox` to allow `state='invalid'`.
- The cron job re-seals v0 rows and rewraps DEKs that are on an old KEK. Each new envelope is
  verified by re-opening it before it is written. Every `UPDATE` is guarded on the tenant and
  on the exact values read. Only a defect in a row's own bytes quarantines it. A key fault
  aborts the job, and a circuit breaker stops a bad key from quarantining a whole batch. v0
  columns are kept so a Worker rollback still works.
- Queue messages are `{id, integrationId, organizationId, title, url}`. The consumer re-reads
  the row scoped to the organization. A crypto failure, a missing row or a disallowed host is
  a permanent `failed` delivery and no provider call is made. `last_error` only holds codes we
  minted.
- `/health` returns `503` and names the misconfigured key binding.

**Verified by**

- `tests/crypto/envelope.test.ts` (24 cases). They cover byte layout, strict parsing, a fresh IV
  per seal, the size cap, AAD row binding, url/secret non-interchangeability, DEK unwrap
  refused across tenant or connection, version pinning, rewrap, and the legacy v0 reader.
- `tests/pipeline/delivery-path.test.ts` (23 cases, plus a security review whose 2 HIGH and
  7 MEDIUM findings are all fixed and covered). These are end-to-end tests over the real
  migrations, using a `node:sqlite` D1 fake (`tests/support/d1.ts`). They cover cross-tenant
  routing with the same repo name, a credential-free queue, idempotent redelivery, delivery
  for v0 and then v1, refusal of a row-swap attack, the consumer's tenant re-check, the
  allowlist, provider 5xx, URL-echo redaction, quarantine, and full KEK rotation with the old
  KEK removed. They also cover duplicate suppression for deliveries already `sent`, retry
  rather than drop when keys are misconfigured, the circuit breaker, config-fault abort, and
  a concurrent-edit race.
- `tests/migrations.test.ts`: 0007 strips legacy ciphertext from every outbox row and keeps
  the rows.

**Known gaps**

- The KEK is a Worker secret, which is F34 tier 2. The Secrets Store binding (tier 1),
  environment-mismatch detection, audited key destruction and crypto-shredding (F40) are
  still open.

## Slice 3a — integrations API, capabilities and audit (PR #9)

**What changed**

- `src/auth/permissions.ts` adds domain capabilities (`integration.*`, `delivery.read|replay`,
  `audit.read`) to the same Better Auth access-control definition. `can(role, capability)` is
  the pure check.
- `authorize(c, capability)` in `src/auth/workspace.ts` is the single gate. It audits every
  denial itself. A not-a-member probe is recorded against the target workspace when that
  workspace exists.
- `src/api/integrations.ts` adds `GET`, `POST`, `PATCH` and `DELETE` on `/api/integrations`.
  Every query is scoped to the resolved workspace. Credentials are sealed on write
  (ADR 0004), and responses show only the destination host. Mutations require our `Origin`
  and a JSON body (CSRF). The contract is in [`API.md`](API.md).
- `src/api/integration-input.ts` validates everything before anything is sealed: the
  destination allowlist (D9), the closed event catalog (D12, D16), the repository format, the
  Lark-only signing secret, and immutable fields. Error messages never echo input.
- `src/connectors/sources/github/catalog.ts` is the closed set of 18 subscribable GitHub
  events. Ingress returns early for anything outside it.
- `migrations/0008`:
  - Integration metadata columns.
  - Triggers that refuse an integration without `organization_id` and refuse moving one to
    another workspace. This is the contract step for every new write.
  - An append-only `audit_events` table.
- `src/audit/audit.ts` writes audit rows as batch statements, so the audit row commits with
  the change it describes.

**Verified by**

- `tests/auth/permissions.test.ts`: role × capability table, plus unknown roles.
- `tests/api/integration-input.test.ts`: allowlist bypass attempts (look-alike host, http,
  userinfo, port, IP literal, wrong path), catalog bounds, repository format, no echo of
  input, rules for immutable fields.
- `tests/api/integrations.test.ts`: runs over the real migrations, with only the Better Auth
  session lookup stubbed. It covers:
  - sealed create that never returns the URL;
  - cross-tenant 404 on every verb;
  - an audited not-a-member probe;
  - CSRF origin and content-type refusal;
  - 401 without a session;
  - credential rotation with fresh DEK and quarantine cleared;
  - audit rows for each change;
  - DB triggers;
  - an append-only audit log;
  - an API-created integration delivering end to end through the consumer.

**Review.** A security review found no CRITICAL or HIGH issues. All 5 MEDIUM findings are
fixed and covered by tests:

- denial-audit flooding, handled by dedupe, a cap on `?org=` and a write that can never fail
  the request;
- case-sensitive repo matching;
- false "success" audits on a concurrent delete, handled by guarded audit rows and a 404;
- buffering before the size check;
- audit failures turning a 404 into a 500.

The LOW findings are also handled:

- bidi and C1 controls in names;
- an empty-string `organization_id`;
- a `truncated` flag on the list;
- quarantine-cleared in the rotation audit;
- a 100-integration workspace quota;
- 30 mutations per user per minute, with `Retry-After`.

**Known gaps**

- `repo` is checked for format, not against the installation's repositories. That arrives
  with F67 in slice 3b.
- There is no audit-log read API yet. The `audit.read` capability exists.
- Legacy rows without `organization_id` still need a backfill before the triggers can be
  replaced by `NOT NULL` + `FOREIGN KEY`.

## Slice 3b — GitHub App install flow, lifecycle and repository scope (PR #11)

**What changed** ([ADR 0008](adr/0008-github-install-verification.md),
[`GITHUB_APP.md`](GITHUB_APP.md))

- The `install` → setup URL → OAuth (PKCE) → callback flow is in
  `src/connectors/sources/github/install.ts`. The setup URL's `installation_id` is treated
  only as a claim. The callback proves the installer can access our App's installation via
  `GET /user/installations`, then revokes the user token.
- States are single-use, expire after 10 minutes, are bound to the user, and are stored as
  SHA-256.
- An installation bound to another workspace is refused and audited, and a database trigger
  forbids a rebind.
- `src/connectors/sources/github/lifecycle.ts` turns suspend, unsuspend, delete, create,
  permission and repository add/remove events into immediate state changes, each with an
  audit row. They never route a notification. A signed `ping` is acknowledged.
- Ingress refuses and audits a repository outside a `selected` installation (F67). The
  integrations API accepts only repositories an active installation covers, and stores
  GitHub's canonical casing.
- New endpoints:
  - `POST /api/github/install`
  - `GET /api/github/installations`
  - `GET /github/setup`
  - `GET /github/callback`
- `migrations/0010` adds `github_auth_states` and `github_installation_repositories`, the
  installation timestamp columns, and the no-rebind trigger.

**Verified by** — `tests/github/install-flow.test.ts`, over the real migrations with GitHub's
HTTP endpoints mocked:

- binding and auditing;
- the PKCE challenge matching the verifier;
- token revocation;
- states that are hashed, single-use, user-bound, expiring and purpose-checked;
- refusal of a spoofed installation id and of a foreign App;
- refusal of a rebind (API and trigger);
- refusal of a malformed id before any GitHub call;
- a failed code exchange, a missing session, an unconfigured App and a missing Origin;
- installation listing scoped to the workspace;
- in-scope and out-of-scope routing;
- suspend, unsuspend and delete stopping and resuming delivery immediately;
- repository add and remove;
- unbound or foreign lifecycle events being ignored;
- unsigned lifecycle events being rejected;
- `ping`.

The integrations API tests also cover the new repository-scope rule.

**Review.** A security review found 1 HIGH, 5 MEDIUM and 6 LOW issues. All are fixed and
covered by tests:

- An installation could be claimed by anyone able to *see* it. Binding now requires an
  active org admin or the account holder, matched by numeric id.
- Membership and role are re-checked at every step.
- Repository sync is chunked and bounded: `all` installations skip it, and an oversized
  installation is refused rather than silently truncated.
- A switch from `all` to `selected` fails closed and sets `needsResync`.
- Lifecycle transitions are guarded and replay-safe. `uninstalled` is terminal, and a delete
  that arrives before the bind is tombstoned.
- Account renames are followed by numeric id.
- The client secret moves to the form body, and the PKCE verifier is cleared after use.
- Unexpected failures redirect instead of returning a 500.
- Refused binds record the claimed id for correlation.

**Known gaps**

- No real GitHub App has been registered or exercised.
- ⚠️ UNVERIFIED: whether `GET /user/memberships/orgs/{org}` needs the **Members: Read**
  permission for an App user token. If it returns 403, the flow fails closed.
- Reconciliation (F69), permission reads (F61), the unbind action, and the dashboard's
  "Connect GitHub" button. The button belongs to the UI slice.

## Slice 5 — destination capability model and adapters (✅, no real-provider test)

The adapters shipped in #8 as pure modules; the wiring change puts them in the slice 4
delivery path. **Nothing here has been run against a real Slack, Teams or Lark endpoint**:
every provider response in the tests is a fixture written from
`docs/DESTINATION_API_REFERENCE.md`. Per the release rule, slice 5 is complete in code, not
production-ready.

**Wiring (completion)**

- `src/pipeline/consumer.ts` renders with `prepareDelivery`, sends with `sendRequest` and
  classifies with `classifyDeliveryResponse`. The inline Slack `{text}` and the legacy Lark
  builder are gone, along with `lark/webhook.ts`.
- One classification layer: `src/delivery/classify.ts` now only maps adapter reasons onto F13
  codes (`REASON_CODES`) and the retry policy's `AttemptOutcome`. Teams `accepted` is stored
  as ledger state `accepted`. See ADR 0006, "Wiring".
- `DeliveryMessage` carries optional `repo`, `actor`, `status`, `eventType`, `summary`
  (<= 280 characters, no payload); the GitHub route populates them. Legacy messages deliver.
- Teams is a destination kind in the API, `DestinationKind` and the `integrations` CHECK
  (migration `0012_teams_destination.sql`). `triggerAuth` is an optional validated field
  (`anyone` only).
- The integrations API uses `validateDestinationConfig` as its only URL/secret validator.

**Verified by (wiring)**

- `tests/pipeline/destinations.test.ts`: Slack, Teams and Lark over the fake D1 through the
  real consumer: delivered vs accepted, truncation, Retry-After to queue delay, permanent
  classifications to `dead_lettered`, redirects, the unmapped flag in the log, legacy messages.
- `tests/delivery/classify.test.ts`, `tests/api/*.test.ts` (Teams create, 422 shape, no echo),
  `tests/pipeline/delivery-path.test.ts` (ingress fields, privacy) and
  `tests/migrations.test.ts` (0012 preserves every row, column, index and trigger).

**UNVERIFIED (wiring)**

- Real-provider behaviour for all three destinations (no real-provider test was run).
- That Teams, Slack and Lark accept our rendered payloads in a real tenant (Adaptive Card 1.2,
  Block Kit, Lark card 2.0).
- Our reason -> F13 code mapping for destination policy and content blocks (ADR 0006); it is
  a product decision, not a provider fact.
- Treating an unreadable 2xx as `accepted` rather than retrying (ADR 0006).
- Migration 0012 ran on the Node SQLite fake, not on a real D1 database or a copy of
  production data; rehearse it with `wrangler d1 migrations apply` against staging.
- Teams trigger hosts other than `*.logic.azure.com` and Logic Apps error codes (ADR 0006).

**What changed**

- `src/connectors/destinations/` follows [ADR 0006](adr/0006-destination-adapter-contract.md):
  - `adapter.ts`, `types.ts` and `capabilities.ts` hold the adapter contract and the
    per-destination capability matrix. Teams Workflows is `accepted`, never `delivered`.
  - `config.ts` and `url-policy.ts` do write-time validation behind a sealed config type, plus
    the allowlist: https only, no userinfo, port, fragment or IP literal, and the documented
    host and path prefix. Teams matches on host pattern only.
  - `render.ts`, `markup.ts` and `redact.ts` hold the `card → markdown → plain` ladder with
    byte budgets, truncation that respects graphemes and links, per-dialect escaping and Lark
    DLP masking.
  - `classify.ts` and `retry-after.ts` hold the closed `outcome`/`reason` taxonomy and the
    RFC 9110 `Retry-After` parser.
  - `send.ts` is the only I/O. It re-checks the URL, never follows redirects (`redirect: 'manual'`, 3xx is a permanent
    `destination_redirected`), applies a
    timeout and reads a bounded body.
  - `slack/`, `teams/` and `lark/` hold the renderer, classifier and adapter for each
    destination. `lark/webhook.ts` keeps `larkPayload`/`larkAccepted` for the current consumer.
- Public entry points are `prepareDelivery`, `sendRequest`, `classifyDeliveryResponse` and
  `deliver`, all in `src/connectors/destinations/index.ts`.

**Verified by**

- `tests/destinations/*.test.ts`. These cover:
  - allowlist accept and reject cases, including `hooks.slack.com.evil.com`, userinfo, http,
    IP literals and wrong paths
  - truncation edge cases (surrogate pairs, ZWJ, flags, Vietnamese combining marks, entities,
    links)
  - escaping and mention suppression
  - every renderer rung and every classifier branch
  - a conformance suite for render determinism and classification totality
  - send-time re-validation with an injected `fetch`

**Known gaps**

- The delivery row stores the F13 code and a minted diagnostic, but not `format`,
  `degradedFrom`, `truncatedFields`, `redactedFields` or the adapter `reason`.
- `triggerAuth` is validated but not stored, and no UI exists for it.
- Slack OAuth install (F103), test delivery (F98), the UI capability surface (F92/F93) and the
  Lark app-bot mode (F101) are not started.
- Several provider facts are `UNVERIFIED` and listed in ADR 0006. They need real-tenant checks.

## Slice 4 — delivery reliability (PR #10)

Decisions and their rationale are in [ADR 0005](adr/0005-delivery-reliability.md).

**What changed**

- `src/platform/`
  - `errors.ts` holds the closed F13 taxonomy (plus `timestamp_out_of_tolerance`). Each code
    carries a retryable/permanent class, an API status and a user message key.
  - `redact.ts` is the F12 redactor.
  - `log.ts` writes structured lines, and every line is redacted first. The consumer, the
    outbox and the credential cron log only through it.
- `src/delivery/`
  - `retry.ts`: the F177 two-tier ladder with an injected RNG, F178 `Retry-After`, and the
    ack/retry/dead-letter decision.
  - `state.ts`: the ledger state machine.
  - `ids.ts`: F170 dedup key and F184 delivery id.
  - `claim.ts`: lease-fenced, tenant-scoped outbox SQL.
  - `classify.ts`: generic HTTP mapping plus the F179 Lark codes.
  - `ledger.ts`: consumer claim and outcome writes.
  - `redeliver.ts`: the F182 replay service.
- `migrations/0009_delivery_reliability.sql` rebuilds `notification_outbox` (adds `claimed`,
  lease columns and `not_before`) and `deliveries` (new state set, attempt and schedule
  timestamps, `last_error_code`, `dedup_key`, `replay_of`, `replay_count`). Every row is
  copied and every index recreated. Legacy `failed` becomes `dead_lettered`, with a taxonomy
  code derived from `last_error`.
- Ingress derives the delivery id from `(dedup_key, integration)`. It will not re-accept a
  GitHub redelivery that is already stored under a legacy id.
- The dispatcher claims each row before sending. The every-minute cron is the reconciler: due
  rows, expired leases, and parked retries. The ingress kick dispatches only its own
  workspace.
- The consumer:
  - claims the ledger row before calling the provider;
  - classifies every failure onto the taxonomy and applies `decideRetry`;
  - retries short waits through `msg.retry({ delaySeconds })` and parks long ones on the
    outbox;
  - dead-letters permanent failures and exhausted retries to a terminal state;
  - keeps the tenant re-check on every read and write, the crypto split (row defect → dead
    letter, key fault → retry) and duplicate suppression for terminal rows.
- Outbound calls have a 10 s `AbortSignal.timeout`.
- `src/pipeline/dead-letter.ts` consumes `noti-dead-letters` and moves stranded ledger rows
  to `dead_lettered` (F180). `wrangler.jsonc` sets the delivery queue `max_batch_size` to 5
  (F176) and declares the DLQ consumer.

**Verified by**

- Unit tests:
  - `tests/platform/{errors,redact,log}.test.ts`
  - `tests/delivery/{retry,state,ids,claim,classify}.test.ts`
  - These cover the whole taxonomy table, redaction with no secret prefix, the ladder and
    its distribution, `Retry-After` in both forms, every state transition, injective ids and
    the SQL tenant predicates.
- `tests/pipeline/reliability.test.ts`, end to end over the real migrations:
  - claim race (two dispatchers, each row sent once), and lease-expiry reclaim with a fenced
    stale holder;
  - invalid and foreign payloads, and tenantless rows never routed;
  - the Tier 1 ladder under an injected RNG, a park-and-redispatch once queue retries are
    spent, and the Tier 2 schedule;
  - `Retry-After` overriding backoff, exhaustion → `dead_lettered`, and permanent 404/410/403/413
    → `dead_lettered` with no second call;
  - Lark codes, timeouts, a live versus an abandoned consumer claim, and a ledger outage
    retried rather than lost;
  - no URL in any log line;
  - hashed ids at ingress, legacy-id rows dispatched and updated, and no re-acceptance of a
    legacy-stored event;
  - replay: one row under concurrent requests, refused for a sent delivery, refused across
    tenants, refused without a stored message;
  - the DLQ consumer: never-attempted, retrying, terminal, live-claim, stale-claim and
    cross-tenant cases, plus a ledger failure retried;
  - `QUEUE_MAX_RETRIES`, the batch size and the DLQ consumer match `wrangler.jsonc`.
- `tests/pipeline/delivery-path.test.ts`: the slice 2 cases still pass. Permanent crypto
  failures now end in `dead_lettered`.
- `tests/migrations.test.ts`: 0009 keeps every row, maps legacy states, recreates the
  indexes and enforces the new CHECKs.
- `tests/support/d1.ts` now expands D1's ordered `?NNN` parameters, which `node:sqlite` will
  not bind positionally.

**Known gaps**

- No health check asserts the DLQ consumer is attached. There is no `delivery_attempts`
  table, no `event_dedup` table and no TTL purge.
- No replay route, capability check or audit record.
- No circuit breaker, client-side dedup window or per-destination rate limiting.
- No `outbox_stalled` or reconciler-failure alert, and no metric for unmapped provider
  errors.
- Per-provider classification for Slack, Teams and Lark now comes from the slice 5 adapters (wired); Slack API and Discord remain out of scope.
- No real-provider validation.

**Review fixes (PR #10 review of 5d7d5cb)**

All HIGH, MEDIUM and LOW findings are fixed, each with a regression test in
`tests/pipeline/reliability.test.ts`, `tests/migrations.test.ts` or the unit suites:
- no claim can be stranded (H1): release on throw, a cron backstop, the DLQ dead-letters any
  non-terminal row, and a capped claim-busy retry;
- fenced and conditional outcome writes (H2);
- due-time claims (M1) and attempt numbers taken from `RETURNING` (M2);
- per-row clock, oldest-first workspaces and send back-off (M3);
- `failed` kept legal for rollback (M4);
- tenantless rows retired (M5);
- indexes and a bounded retention purge (M6);
- invalid payloads dead-letter their delivery (M7);
- manual redirects, unconfirmed Lark bodies, a claim-token fence, a 60 s key-ring back-off,
  and a 24 h queue delay maximum.

See [ADR 0005](adr/0005-delivery-reliability.md) §12.
## Slice W — workspace export and deletion (PR #12)

**What changed**

- `GET /api/workspace/export` (admin) returns a JSON archive: members, integrations,
  installations, delivery states and the audit log. No credential column is ever selected.
- `POST /api/workspace/deletion` (admin, confirmed by typing the workspace name):
  - It disables every integration at once. Nothing is routed or delivered from that moment,
    and it records which integrations were on.
  - It blocks new integrations and GitHub installs.
  - The purge is scheduled 7 days out.
- `DELETE /api/workspace/deletion` cancels the request and restores exactly the
  integrations that had been enabled. It is refused once the purge has started.
- `src/pipeline/purge.ts` runs from cron. It is bounded at 500 rows per table per tick and
  resumable. It deletes the outbox, delivery and integration rows (deleting the wrapped DEKs
  crypto-shreds every credential). Then it deletes the organization, which cascades members,
  invitations, installations, auth states and audit events, and it stamps the ledger.
- `migrations/0011`:
  - The `workspace_deletions` ledger. It deliberately has no foreign key, so it can outlive
    the organization as evidence.
  - The last-admin trigger is recreated with a single exemption, for a purge in progress.
    Without that exemption it blocked the cascade.
- The integrations API's allowlist now delegates to the single strict destination URL policy
  from ADR 0006: Slack `/services/T…/B…/<token>`, and no fragment or IP literal.
- `tests/retired-schema.test.ts` fails if any source file references the retired identity
  tables (F31).

**Verified by** — `tests/api/workspace-lifecycle.test.ts` covers:

- admin-only access;
- typed confirmation;
- immediate soft stop and blocked mutations;
- an exact restore on cancel;
- a full purge that leaves other tenants intact and keeps the ledger;
- bounded, resumable ticks;
- no cancel after the purge starts;
- the last admin still protected outside a purge;
- an export with no credential material, scoped to the caller's workspace.

**Review.** A security review found no CRITICAL or HIGH issues. The two races and two
MEDIUM gaps are fixed with regression tests:

- A cancel racing the purge start. The purge now claims the row with one guarded `UPDATE`
  and deletes nothing if it loses.
- A double-click overwriting the restore snapshot. Scheduling is one atomic upsert that also
  takes the snapshot, and it matches nothing while a request is pending.
- An unbounded cascade. Audit events, auth states and synced repositories are drained in
  bounded ticks before the organization is deleted.
- A cancel batch that could exceed 100 statements. It is now one `json_each` update.

Also fixed:

- The deletion-pending guard now covers integration delete and the GitHub callback.
- The purge writes a `workspace.purged` audit row with no organization, so the trail survives.
- The export orders its rows, exports the most recent ones, and reports `truncated` per table
  (2,000-row cap).

**Known gaps**

- In-flight deliveries for a workspace pending deletion fail permanently
  (`integration_unavailable`); cancelling does not requeue them.
- Existing stored Slack URLs that do not match the strict `/services/T…/B…/<token>` shape are
  rejected at send time as permanent failures. A one-off re-check job that quarantines them
  visibly is not built.
- The GitHub installation stays installed on GitHub's side after a purge; admins should
  uninstall it there.
- D1 Time Travel keeps restorable history for up to 30 days, so erasure from backups is not
  faster than that. `SECURITY.md` says so.
- The dashboard has no deletion or export screen yet.
- Deleting individual member accounts is Better Auth's job and is not covered here.

## Slice 6a — integrations dashboard (this PR)

**What changed**

- `/integrations` replaces the placeholder catalogue with the real list from
  `GET /api/integrations`: name, repository, destination and host, subscribed updates in plain
  language, a pause/resume switch, and the credential state. A failed query renders an error
  with a retry, never an empty list (F225). `truncated` lists say so.
- **GitHub connection panel** (`GET /api/github/installations`, `POST /api/github/install`):
  each installation with account, all vs selected repositories, status (suspended and
  uninstalled explained) and a reconnect action when `needsResync`. An unconfigured server
  shows "GitHub App not configured on this server" and **no button**. The
  `?github=<status>` return shows a plain-language message for all 15 codes and is stripped
  with `history.replaceState`.
- **Create wizard** at `/integrations/new`, five steps: repository (a picker over the
  connection: listed repositories for `selected`, owner-fixed typed name for `all`),
  destination, webhook URL (with where-to-find-it steps and the provider's official guide),
  updates (grouped catalog, failures-only default), review. With no active installation, step
  1 is "Connect GitHub". Client checks mirror the server; the server's 422 field errors are
  shown inline and send the person back to the step that owns the field.
- **Settings** at `/integrations/:id`: status (pause/resume), repository and updates (explicit
  save, unsaved-changes guard), destination and webhook URL (write-only; a separate
  **Replace** action that clears quarantine), and delete with a typed confirmation in a Base
  UI `AlertDialog` that focuses *Keep integration* first.
- Overview's integrations figure is read from the API; the two delivery figures stay `—` with
  their reason.
- `web/src/lib/api.ts` has typed, runtime-checked clients; every mutation sends
  `Content-Type: application/json` (DELETE sends none, matching the server's Origin-only
  check). 409 (quota) and 429 (`Retry-After`) have their own messages.
- Strings for these screens live in `web/src/i18n/messages.en.ts` with `t()`/`tp()`
  (`Intl.PluralRules`); event labels are keyed by the server's closed catalog, so a new event
  type without a label fails the web type check.

**Verified by**

- `web/src/integrations/integrations.test.ts` (69 cases): client URL, repository, name and
  secret checks compared case by case against the real server parser; catalog label and
  grouping coverage; repository coverage rules; wizard step routing for server errors; every
  `?github=` code; 409/429 copy; response parsing never carries a URL.
- A browser pass against `wrangler dev` with local D1 and the real Worker, recorded in
  [ADR 0007](adr/0007-integrations-ux.md): create, edit, pause/resume, rotate, delete, the
  real 422 path, keyboard focus, and 320/375/1280 px reflow.

**Known gaps**

- Not exercised against a real GitHub App, Slack or Lark. The local GitHub App settings were
  placeholders and the installation rows were inserted into the local database; the
  **Connect GitHub** button's redirect to github.com was not followed.
- Test send and the setup-progress model (F207, F215) are still open; the delivery log landed in slice 6b (ADR 0009).
- No automated axe scan or screen-reader pass yet; only the strings on these screens are in
  the catalogue.

## Slice S — security hardening (PR #16)

**What changed**

- `src/security/headers.ts` and a one-line `app.use` in `src/index.ts`: HSTS, `nosniff`,
  `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`, COOP and a `default-src 'none'`
  CSP on every Worker response. The SPA is not served by the Worker (no assets binding), so
  its headers ship as `web/public/_headers`, rendered from the same module and drift-tested.
  The SPA CSP is nonce-free: `script-src 'self'`, `style-src 'self'`, `connect-src 'self'`.
  The build has no inline script or style, so nothing needed `'unsafe-inline'`.
- `src/security/rate-limit.ts`: `hit()` (D1 fixed-window UPSERT, shared with the existing
  `api_rate_limits` table), `ingressLimiter(env, installationId)` (600 per minute per
  installation, keyed `ingress:github:<id>`), and `pruneRateLimits()`.
- CI: actions pinned to commit SHAs, `concurrency` cancel for PRs, per-job read-only
  permissions, `npm run audit:gate`, a dependency-review job, Dependabot (npm and Actions,
  weekly, grouped). Root `SECURITY.md`.
- `scripts/audit-gate.mjs`: the `npm audit --omit=dev --audit-level=high` policy with a short
  dated exception list. Today it excepts two tinypool advisories that reach the production
  tree only because `better-auth` lists vitest as an optional peer (documented in
  `docs/SECURITY.md`).
- `docs/THREAT_MODEL.md` (STRIDE per entry point, risk register AR-1 to AR-16) and a
  restructured `docs/RELEASE_GATES.md`.
- `tests/security/`: headers and CSP parsing, limiter, audit gate, static guards (no
  `console.log`, no console call passing bodies or headers, Origin check present in every
  route file with mutating verbs, no secrets in `wrangler.jsonc` vars or
  `.dev.vars.example`, no HTML-injection sinks, `cookieCache` stays off), CI hygiene, risk
  register consistency.

**Verified by**

- The unit tests above, `npm run format && npm run check`.
- The built SPA served with the exact `_headers` CSP by a local static server and opened in
  the in-app browser: `/` and `/integrations` (which redirects to `/signin` when signed out)
  rendered, the self-hosted font loaded, no `<style>` tags and no CSP violation messages in
  the console. The only console errors were 401s from the stub API.

**Not done / follow-ups**

- **Wire the ingress limiter.** `src/connectors/sources/github/route.ts` was owned by another
  slice. The integration is one call, placed after signature verification, after the
  `ping` and lifecycle early returns, and before `resolveTenant`:
  `const limit = await ingressLimiter(c.env, Number(asRecord(event.installation)?.id));`
  then `if (limit.limited) return c.text('Too many requests', 429, { 'retry-after': String(limit.retryAfterSeconds) });`
  It must stay off the lifecycle branch so a revocation is never delayed. Add a route test
  asserting 429 with `Retry-After` and that a lifecycle event is never limited. Until this
  lands, F29 is not met.
- Call `pruneRateLimits(env.DB, Date.now() - 3_600_000)` from `scheduled()` (AR-16).
- Signed-in SPA screens have not been checked under the CSP (no backend with a session was
  available). Run a pass against `wrangler dev` and watch for violations.
- Confirm the static host applies `web/public/_headers` and that GitHub private vulnerability
  reporting is enabled in repository settings; neither could be verified from here.
- F239: `npm audit signatures` on release builds, install-script review, OIDC deploy.
- F231 abuse alerting, F233 audit rows for unknown-installation 403s and the staging
  isolation drill, F237 retention matrix, F242 runbooks and `security.txt`.
- The dependency-review job is `continue-on-error` until it has run green once.

**Review.** A security review found no HIGH issues and five MEDIUM ones, all fixed:

- Rate-limit rows are now pruned from `scheduled()` and indexed on `window_start`
  (migration 0014). The register entry that understated the risk is reworded (AR-16, AR-17).
- HSTS no longer sends `preload`, because eligibility is judged on the apex domain, and the
  max-age is one year.
- The `dependency-review` job runs only when the repository variable `DEPENDENCY_REVIEW` is
  `true`. Until the dependency graph is enabled it is skipped instead of showing as a failing
  check.
- Origin enforcement for every state-changing `/api/*` request is now central middleware
  (`src/security/csrf.ts`), with its own tests, so a new route cannot forget it.
- The CI guard now covers every workflow file and refuses any write or `id-token` permission.
- The `ingressLimiter` call still has to be added to `route.ts`, wrapped so a D1 error fails
  open and logs a redacted event.
- The `tinypool` exception's stated fix was corrected. Upgrading to vitest 4 removes it.

## Slice 9 — observability core (this PR)

**What changed**

- `src/platform/correlation.ts` and one `app.use` in `src/index.ts`: our own v4 correlation id
  per request, echoed as `x-request-id`, attached (with a sane caller `x-request-id` as
  `external_request_id`, and `cf-ray`) to every log line inside the request through
  `AsyncLocalStorage`. A caller-supplied id is never adopted (spec 13 F193).
- `src/observability/slis.ts` and `GET /api/observability/summary` (`delivery.read`,
  `?window=` 1h to 30d): counts by state, success ratio, retry rate, dead letters by error
  code, exact p50/p95 end-to-end and queue-delay latency, backlog ages, a per-destination
  breakdown (Teams as `accepted`), and an explicit `notMeasurable` list. Empty windows are
  `null`, never 0 or 1.
- `src/observability/stall.ts`: cron stall detection with transition-based logging; state in
  the new `ops_state` table (migration 0016).
- `src/observability/cron.ts`: isolated cron jobs with a heartbeat; one failing job no longer skips stall detection or retention.
- `src/pipeline/retention.ts`: hourly-throttled, index-seeking, bounded age-based purge of terminal deliveries, orphan outbox
  rows and audit events; `DELIVERY_RETENTION_DAYS` (90) and `AUDIT_RETENTION_DAYS` (365).
- `docs/RUNBOOK.md`, ADR 0011, API and release-gate rows.

**Verified by**

- Unit and integration tests over the real migrations in `tests/platform/correlation.test.ts`,
  `tests/observability/`, `tests/pipeline/retention.test.ts` and `tests/api/observability.test.ts`
  (SLI arithmetic, tenant isolation, window bounds, stall transitions, retention safety rules,
  header echo), and `npm run format && npm run check`.
- Not verified: anything against a real D1 database, Cloudflare Queues, Workers Logs or a
  deployed cron. The SQL is exercised only through the Node SQLite fake.

**Not done / follow-ups**

- Correlation id on the queue message, `deliveries`/outbox rows and consumer log lines
  (needs `src/pipeline/consumer.ts` and the GitHub route); `X-Noti-Correlation-Id`; lookup by
  id.
- Acceptance, routing and duplicate rates, ack and attempt latency, persisted unmapped-error
  flag (no events table or attempt table); Analytics Engine; `job_runs`; `alert_state` and
  paging; evidence bundle; the SLI publication gate; any dashboard view of the summary.
- The runbook has not been rehearsed. Several Cloudflare behaviours in it are marked
  UNVERIFIED.
- Retention has not run against real data volumes; the per-tick bound is 2,500 rows per table, and real-D1 `meta.changes` semantics for the drain loops are unverified.

## Slice 7 — per-integration routing filters (ADR 0010)

**What changed**

- `migrations/0015_routing_filters.sql`: `integrations.filters_json` (`ADD COLUMN`, no rebuild;
  `CHECK` for valid JSON up to 8 KiB) and `routing_decisions`, with an index per tenant and
  integration and one on `decided_at` for retention.
- `src/routing/`: `glob.ts` (linear `*`/`**` matcher, no RegExp from input), `filters.ts` (the
  registry: `branch`, `baseBranch`, `actor`, `draft`, `labels`, each versioned with a pure
  `evaluate`), `filter-input.ts` (validation, normalisation, storage, sample-facts parser),
  `provenance.ts` (decision rows, retention, keyset log). `connectors/sources/github/facts.ts`
  extracts the seven facts from a verified payload.
- Ingress (`github/route.ts`): each subscribed, enabled integration is evaluated; a filtered
  event creates no delivery and records a reason, a delivered one records `delivered` in the
  a best-effort batch after (never inside) the delivery transaction; integrations without filters
  write no row. Unreadable stored filters fail closed (a newer-version document, i.e. a rollback,
  fails open). Unknown facts hold an update back for every filter. Releases and deployments carry
  a branch where GitHub names one, and an "only" list that cannot be enforced on a subscribed
  event is refused at save.
- API: `filters` on create and update, strict validation, audit with filter ids only,
  `GET /api/integrations/:id/routing-log`, `POST /api/integrations/:id/filters/preview`
  ([API.md](API.md#routing-filters)). `purge.ts` lists the new table; the cron job applies a
  30-day retention; the workspace export includes `filters_json`.
- Dashboard: "Filters" section in settings (editor, "Try it", recent decisions) and an optional
  wizard step; copy in `web/src/i18n/messages.filters.en.ts`
  ([FRONTEND.md](FRONTEND.md)).

**Verified by**

- `tests/routing/*.test.ts`: glob syntax and adversarial inputs (under 1 s), table-driven filter
  cases, validation and fact extraction, and the ingress path end to end over the real
  migrations (filtered vs delivered, fan-out per integration, redelivery, fail-open,
  cross-tenant, no payload in the table, retention, workspace purge).
- `tests/api/routing.test.ts`: create/update/clear, audit ids only, dry run (pure, CSRF, authz,
  rate limit), routing log (paging, tenant scoping). `tests/migration-0015.test.ts`.
- `web/src/integrations/filters/*.test.*`: draft model, error mapping, parity with the server
  parser and evaluator, wizard step, API parsing, server-rendered markup of the editor.

**Security review follow-up (this PR)**

- Fail closed on corrupt/invalid stored filters (`filtersInvalid`, blocking dashboard state,
  explicit "Replace invalid filters"), open only for a newer `v`; canary and limits-tightening
  tests. Unknown facts hold back for deny rules too. Branch facts for releases and deployments,
  and coverage refusal/warnings at save. Decision rows deleted with the integration, none for
  unfiltered integrations, bounded multi-round retention. Provenance moved out of the delivery
  transaction (best effort, redacted warning). Filters compiled once per document and facts
  folded once per request. Documented: case-insensitivity, `bots: exclude` is the sender,
  events held back are not stored, and the pre-0015 redelivery edge.

**Not done (named, not hidden)**

- The F121 rule object, priority and fan-out (F132), `all`/`any` groups (F123), path and number
  filters (F129, F130), outcome conditions (F131), format overrides (F133), default rules and
  templates (F134, F135), history-based impact preview, versioning and rollback (F139),
  `deliveries.rule_id` and the evaluation trace (F137), the critical-event lock (F148), an
  observed-label picker (F128), the "don't know" bot choice (F138).
- Filters apply to GitHub events only.
- No browser pass of the new screens (320 px reflow, keyboard order, contrast, Vietnamese
  diacritics), no axe or screen-reader pass, and no test against real GitHub deliveries.
- The routing log is not yet on the activity page; the deliveries API was not on this
  branch's base.

## Slice S2 — ingress flood control wired (F29)

`POST /webhooks/github` now calls `ingressLimiter` after signature verification and tenant
resolution: 600 events per installation per minute, `429` with `Retry-After` beyond that.
Lifecycle events and pings return before it, so a revocation is never delayed. A limiter
fault fails open and logs a redacted `rate_limit_error`. Covered by three tests in
`tests/pipeline/delivery-path.test.ts`. AR-16 is reworded to the residual risk.
