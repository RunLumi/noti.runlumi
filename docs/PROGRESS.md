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
| 4b | Canonical event layer (validated `CanonicalEvent` for GitHub, generic, GitLab, Stripe), one event-type registry, connector descriptor and conformance suite, fixture replay with goldens, GitHub F59/F60/F63/F64 settled, F65/F69 recorded as blocked | F41–F46, F48 (each in part), F59, F60, F62–F65 (in part), F71, F72, F79 (in part) | D13 (part) | 🟡 | this PR |
| 5 | Destination capability model; Slack, Teams and Lark adapters, wired into the delivery consumer; Teams as a destination kind | F91–F104 | D8 | ✅ (no real-provider test) | #8, wiring PR |
| 6 | Dashboard: setup wizard, integrations, delivery log, test send | F205–F226 | — | ⬜ | — |
| 5 | Destination capability model; Slack and Teams adapters (adapters shipped as pure modules; consumer wiring pending slice 4) | F91–F104 | D8 | 🟡 | — |
| 6a | Dashboard: integrations list, guided create wizard, settings (edit, pause, rotate, delete), GitHub connection panel and repository picker | F206 (partial), F210 (partial), F211, F216 (partial), F217 (partial), F220 (partial), F221, F223, F224 (structure), F225 | — | 🟡 | #13 |
| 6b | Dashboard: delivery log and manual redelivery (API and UI; migration 0013 indexes), workspace export and deletion screens, Teams in the create wizard. Test send and the setup-progress model remain | F181 (part), F182 (part), F213 (part), F218 (part), F211 (Teams) | D11 (surface) | 🟡 | #16 |
| 6c | Dashboard: accessibility gate (axe-core on every route, wizard step and dialog), route-change title/announcement/focus, skip link, palette-contrast and stylesheet-preference tests, Vietnamese catalogue with a language switcher, hard-coded-string and catalogue-drift tests | F221 (part), F223 (part), F224 (part) | — | 🟡 | this PR |
| 6d | Dashboard: "Send a test notification" through the real delivery path (API, settings section, list button, optional wizard step), derived setup-progress API and Overview card, `is_test` column (migration 0022) | F98 (part), F207 (part), F215 (part), F216 (part) | — | 🟡 | this PR |
| 6e | Dashboard: workspace switcher (`POST /api/workspace/active`, `activeOrgId`, query-key isolation, create another workspace) and the admin-only audit log (`GET /api/audit`, `/audit`, plain-language en/vi labels, allow-listed metadata, CSV of the loaded events) | F28 (read side, in part), F222 (read side, in part), F205 (part), F224 (part) | — | 🟡 | this PR |
| 7 | Per-integration routing filters with provenance (backend, API, dashboard); the F121 rule engine is not started | F124, F125, F127, F128, F136–F140 (each in part) | — | 🟡 | #25 |
| 8 | Noise control: quiet hours, burst grouping, hourly/daily digests, resolved notices, held-event store and release job, settings API and dashboard section. Not the preset library, preferences, silences or AI | F141–F146, F148, F152, F159, F165, F166 (each in part, see section) | — | 🟡 | this PR |
| 9 | Observability and runbook: correlation id, D1-derived SLIs and summary API, stall detection, retention, operator runbook | F193 (partial), F194 (partial), F197 (partial), F198 (partial), F200 (partial), F201 (partial) | — | 🟡 | #16 |
| 10 | Additional sources and destinations, gated on demand evidence | F73–F90, F105–F120 | — | ⬜ | — |
| 10a | Generic signed-webhook source: Standard Webhooks verification, sealed per-source secrets, sources API and dashboard page, routing to source integrations | F74, F75, F76, F77, F78, F79, F80 (each in part, see section) | — | 🟡 | this PR |
| W | Workspace export and two-phase deletion; retired-schema guard; single destination allowlist | F30, F31 | N3 | ✅ | #12 |
| S3 | Compliance: retention matrix (code-checked, generated `docs/DATA_RETENTION.md`), hourly purge of expired auth records, account data export and erasure, `security.txt`, subprocessor inventory, incident response skeleton | F237, F238, F242 (each in part) | — | 🟡 | this PR |
| C | Credential lifecycle and boot hygiene (ADR 0022): credential fingerprint, revoke for integrations and sources, shredding proof, guarded KEK destruction with an audited event, per-environment KEK check value, `assertConfig` at every entrypoint, `/health/ready`, `withD1Retry`, bound-parameter guard (migration 0024) | F34, F37, F39, F40, F04, F09, F10 (each in part) | D1 | 🟡 | this PR |
| 1.1 | Tenant contract closed in the schema (migration 0026: NOT NULL + foreign key on six tables, derive-or-quarantine backfill, row-count check), static every-query-has-an-org-predicate test with a reviewed allowlist, route registry and route-to-capability test, `docs/AUTHORIZATION.md`, tenant-isolation drill over every route on a fake D1 plus an unrun staging runner (ADR 0021) | F25 (contract), F26 (static half), F232, F233 (static and fake-D1 half) | D2 (at rest) | 🟡 | this PR |
| 1.19 | Egress guards (ADR 0026): AST regression guard for the outbound surface, typed provider registry with a weekly 180-day staleness check, `unmapped_provider_response` event | F228, F229 (in part), F230 | — | 🟡 | this PR |
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

## Slice 6c — accessibility and Vietnamese (this PR)

**What changed**

- **axe-core in the test suite.** Every route, every wizard step, the three confirmation
  dialogs, the delivery detail drawer and the main error states are mounted against a mock
  API in jsdom and scanned; the build fails on any serious or critical violation, in English
  and Vietnamese. New dev dependencies, exact-pinned: `axe-core`, `jsdom`,
  `@testing-library/react`, `@testing-library/dom`, `@testing-library/user-event`.
- **Contrast.** A pure test computes WCAG ratios for 34 palette pairs read from `styles.css`
  and checked against `DESIGN.md` §5. Fixed: the opaque glass fallback token was Soft Slate;
  text-field edges were 1.35:1 (now `--color-control-border`, Soft Slate, 5.76:1). Two
  non-text gaps are accepted and pinned to their exact ratios (switch track edge 1.55:1,
  warning rail 2.03:1); see ADR 0013.
- **Keyboard and focus.** `RouteA11y` (title, live-region announcement, focus to `<h1>` on a
  path change), `SkipLink` (first stop, focuses `<main>`, no hash in the URL), a real `<main>`
  and labelled `<aside>` on the sign-in screens. Tests: skip link, tab order of the shell, no
  keyboard trap, route-change focus in both languages, dialog focus trap and restore.
- **Preference media queries** are asserted from the stylesheets (reduced motion, reduced
  transparency, increased contrast, forced colours, 2px focus ring, 44px controls, 12px
  floor). One gap fixed: the modal scrim's blur had no fallback.
- **Vietnamese.** `messages.vi.ts` + `messages.app.vi.ts` cover every message; the shell,
  sign-in, overview, team, onboarding, passkey and dialog-close strings that were literals are
  now catalogue ids. `LocaleSwitcher` (`<select>`), saved choice in `localStorage` (guarded),
  `navigator.languages` default, `<html lang>`, `Intl` dates, relative times, numbers and
  plurals in the active locale, `:lang(vi)` display metrics. Tests fail on a missing id, a
  changed `{placeholder}`, an untranslated copy or any hard-coded visible string (allow-list
  empty).
- Review follow-up: a language switch now re-renders in place (every component subscribes via
  `useLocale()`, enforced by a test) instead of remounting, so focus, open dialogs and typed
  values survive; route focus waits (bounded) for a late `<h1>`, skips redirects, and the
  duplicate navigation announcement is gone; the string scan covers plain `.ts` helpers and
  more attributes; Vietnamese wording corrected (Thành viên, sự kiện, and others).
- Layout fixes found in the browser at 1024px and 200% zoom: wizard review rows and
  destination cards.
- Rebased over routing filters and generic sources: their copy is translated
  (`messages.filters.vi.ts`, `messages.sources.vi.ts`), `/sources`, the filters editor and the
  six-step wizard are in the axe and keyboard tests.

**Verified by**

- 197 new tests (1,747 in total on the rebased branch), `npm run format && npm run check` green.
- A browser pass against `wrangler dev` with local D1 (ADR 0013): axe-core with colour
  contrast on in the page, zero violations on nine screens in English and Vietnamese and with
  a dialog open; keyboard-only sign-in and wizard; 320px with no overflow; emulated 200% zoom;
  Vietnamese rendering from the bundled Geist subset. Screenshots in `docs/screenshots/a11y-*`.

**Known gaps**

- **No screen reader was run.** No conformance level is claimed anywhere.
- Reduced-motion, reduced-transparency, increased-contrast and forced-colours are tested in
  the stylesheet only, not seen in a browser; one Chromium build; no touch or real zoom.
- The Vietnamese copy has not been edited by a native speaker. Server-supplied text (Better
  Auth errors) is still English. Locale is not in the URL; browser
  Back/Forward does not restore the previously focused element.
- Found and filed separately: `GET /api/workspace/me` answers 403 for a user with no
  workspace, so the dashboard sends a new user back to `/signin` and `/onboarding` is
  unreachable.

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
  dated exception list (empty since the toolchain majors below; the two tinypool advisories it once
  excepted went away with vitest 4+).
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

## Slice 8 — noise control (ADR 0016)

**What changed**

- `migrations/0021_noise_control.sql`: `integrations.noise_json` (`ADD COLUMN`, `CHECK` for valid
  JSON up to 2 KiB), `held_events` (display fields only, `CHECK`s that bound every column, no
  payload) and `noise_open_failures` (a key hash per failing workflow). Rollback note in the
  header: the old Worker stops releasing, so held rows wait; they are not lost.
- `src/routing/noise-time.ts` (time-zone arithmetic with `Intl`, DST gaps and overlaps),
  `noise.ts` (settings, validation, stored-document reader, the pure `decideNoise`, group key),
  `noise-store.ts` (SQL), `noise-ingress.ts` (the one place ingress asks "deliver or hold?"),
  `noise-render.ts` (group and digest rendering), `github/noise.ts` (subject and workflow facts).
- `src/pipeline/noise-release.ts` plus cron jobs `noise_release` (after `outbox_reconcile`) and
  `noise_purge`: leased, budgeted (100 notifications per tick across integrations, decided before
  claiming; 15 per D1 batch), atomic per notification, poison-proof (attempts, backoff, dead-letter
  after 5), paused integrations wait, released rows blanked, creating ordinary deliveries and outbox
  rows. Digests split into up to 3 messages before anything is left out.
- Ingress wired into the GitHub, generic and provider (GitLab, Stripe) routes. `held_events` and
  `noise_open_failures` are in `TENANT_TABLES` and deleted with an integration or a source cascade.
  `DeliveryMessage.count` lets a combined notification carry a summary of up to 1400 characters.
- API: `noise` on create and update (validated, audited by feature name), `noiseInvalid` /
  `noiseNewer` on the view, `GET /api/integrations/:id/noise-status`, `heldReason` and
  `groupedCount` on the delivery log, and the noise reason codes in the routing log
  ([API.md](API.md#noise-control-quiet-hours-grouping-summaries-resolved-notices)).
- Dashboard: "Quiet hours and summaries" section in integration settings, English and Vietnamese
  copy, an a11y scenario set ([FRONTEND.md](FRONTEND.md)).

**Verified by** (all over the real migrations and Worker entry point)

- `tests/noise/*.test.ts`: time arithmetic (DST, odd offsets, rollovers), the decision table
  (window edges, critical bypass, capacity), settings parsing, rendering, ingress end to end,
  release (idempotent, concurrent, bounded, failure, lost lease, tenant isolation, scheduled job),
  migration, retention and purge, API validation, authorization and CSRF, GitLab and generic
  routes, and a **seeded property test** (30 seeds) that every ingested event is accounted for
  exactly once. The property test found a real double delivery (a held event redelivered after
  its settings were cleared was also sent at once); it is fixed and has its own regression test.
- `web/src/integrations/noise/*.test.*` and the a11y scenarios in English and Vietnamese.

**Not done (named, not hidden)** — see [ADR 0016](adr/0016-noise-control.md): the preset library
and definitions (F154, F155), three-level preferences and a configurable critical lock (F147,
F148), one-click unsubscribe, bot-suppression presets, per-destination budgets, silences,
per-repository overrides, in-place updates and correlation tables, escalation, inhibition, noise
reports and metrics, weekly digests, "send at least every", a link from a digest to an in-app view,
resolved notices on run attempts and for non-GitHub sources, noise settings in the create wizard, and
any AI summarisation.

**Review round 2 (independent review of the pre-rebase branch):** a per-tick notification budget and
batches of 15 (about 13 D1 calls per tick), `noise_release` after `outbox_reconcile`, continuation
digests with an honest "not shown, details not kept", paused integrations wait, held rows rescheduled
on settings change, poison rows (attempts, backoff, `failed`), released rows blanked, the cheaper
ingress read, the settings in the workspace export, and a conservation test with injected D1
failures, overlapping runs, pauses and deletion.

**Not verified:** a browser pass of the new section (320 px reflow, contrast, native time pickers,
Vietnamese diacritics), a screen reader, a long digest against real Slack, Lark and Teams, real D1
semantics for `UPDATE ... RETURNING` with a subselect, `Intl` zone data on the Workers runtime, load,
and any real-provider end-to-end run. Vietnamese copy has had no native-speaker review.

## Slice 6d — test send and setup progress (ADR 0018)

What exists now:

- `POST /api/integrations/:id/test` (`src/api/test-send.ts`): a real delivery marked `is_test`
  (migration `0022`), event type `test`, created in one guarded batch with its outbox and audit
  rows; 202 with the delivery id only; `integration.update`; CSRF; 5 per integration and 20 per user
  per minute; refused (409) while deletion is pending, or for a paused or quarantined integration;
  cross-tenant is a 404 that burns no budget.
- A test never enters the noise or filter paths (the route does not use them); there is **no**
  event-type bypass, and `test` / `noti.*` are reserved at generic ingress. Tests are excluded from
  the observability SLIs, stall detection, `GET /api/deliveries/summary` and the "real event" setup
  step. A replay of a test is still a test.
- Security review fixes: layered limits (integration 5, user 20, workspace 30, destination host 10 per
  minute across tenants), a `test_in_flight` guard (atomic, 15-minute window), two-bucket results for
  custom webhooks, a tri-state "verified" (`accepted` is not `done`) that requires a live, enabled,
  unquarantined integration, index-driven progress queries, disabled sources ignored, `CHECK(is_test
  IN (0,1))`, and 429-tolerant polling. Migration 0022 must be applied before the new Worker.
- `GET /api/setup/progress`: four derived steps with `since` and a closed next-action key.
- Dashboard: `TestSend` (settings section and list row), the optional "Test it" wizard step, the
  "Finish setting up" Overview card, and a "Test" badge in the delivery log. English and Vietnamese.

Tests: `tests/api/test-send.test.ts` (including end to end through the real consumer and adapters
for Lark, Slack, Teams and Discord), `tests/api/setup-progress.test.ts`,
`tests/migration-0022.test.ts`, additions to the filter and noise tests, and on the web side
`poll.test.ts`, `setup.test.ts` and `test-send.a11y.test.tsx` plus the existing axe scenarios.

**Not done:** scheduled re-tests and health banners; payload preview, HTTP status and latency in
the result; F207's seven steps; testing a source endpoint; an Audit page view of `integration.test`;
server-localised test text. No real provider accepted a test message: every provider response in
the tests is a fixture.

### Slice 6d: browser verification

Run against `vite dev` (one process, local D1 and Queues) in the built-in browser, signed in with a
local test account and a workspace created through the UI. The Browser pane was not displayed, so
**no screenshot was taken**; everything below was read from the DOM and the network.

**Seen:** the Overview card against the real `GET /api/setup/progress` (1 of 4, then 2 of 4 after an
integration existed, with `since` times); a real "Send a test notification" click on a Slack
integration: 202, the delivery row with `is_test = 1`, the `integration.test` audit row, the real
queue consumer picking it up and the panel moving from "Waiting for Slack to answer" to "The first try
did not work" with a "See it in Activity" link (the sandbox has no outbound network, so Slack was not
reachable and each attempt timed out: that is a retry-path run, not a delivery); no horizontal
overflow and no control under 44 px high at 320 px on the Overview, the list and the settings page;
the Vietnamese settings section.

**Not seen:** any screenshot or visual layout; a successful delivery or an `accepted` (Teams) result
in a browser (no real webhook exists; the sent, accepted and failed states are covered by jsdom and
the fake-D1 end-to-end tests only); the create wizard's "Test it" step in a real browser; the
dead-lettered fix links against a real provider answer; keyboard order, focus ring and contrast on
the new screens; any screen reader; Firefox and Safari.

## Slice S2 — ingress flood control wired (F29)

`POST /webhooks/github` now calls `ingressLimiter` after signature verification and tenant
resolution: 600 events per installation per minute, `429` with `Retry-After` beyond that.
Lifecycle events and pings return before it, so a revocation is never delayed. A limiter
fault fails open and logs a redacted `rate_limit_error`. Covered by three tests in
`tests/pipeline/delivery-path.test.ts`. AR-16 is reworded to the residual risk.

## Slice S3 — compliance: retention, DSAR, disclosure (this PR)

Real code plus honest documentation. No legal claims, certifications or audit evidence were
written, because none exist.

**What changed**

- `src/compliance/retention.ts`: the retention matrix, one row per table or column family
  (data, purpose, category, retention, removal mechanism, export position, legal-basis and role
  fields set to "to be decided by the operator"). Every period is imported from the code that
  enforces it. `tests/compliance/retention.test.ts` fails when a migration table has no row, when
  a split table's columns are not each covered once, when a claimed cron job, workspace-purge route,
  foreign-key cascade, customer delete or account erasure does not exist, when a tenant table is
  neither purged nor a declared ledger, when the Worker vars drift, and when `docs/DATA_RETENTION.md`
  differs from `renderRetentionDoc()` (`npm run docs:retention` rewrites it).
- `src/pipeline/expired-records.ts` and the `expired_auth_purge` cron job: expired sessions,
  verification records, GitHub install states (one day past expiry) and Better Auth rate-limit
  rows were never deleted; they are now, hourly and bounded. Found by writing the matrix.
- `src/api/account.ts`: `GET /api/workspace/me/data-export` and `DELETE /api/workspace/me`
  (`docs/DSAR.md`). Audit actions `account.export` and `account.delete`, with en and vi labels.
- `/.well-known/security.txt` (RFC 9116), generated by the Worker (`src/web/security-txt.ts`) so `Expires` is
  always 90 days ahead; tested through `worker.fetch` and against `SECURITY.md`.
- `docs/SUBPROCESSORS.md`, `docs/INCIDENT_RESPONSE.md`, `docs/DSAR.md`; RUNBOOK operator procedure
  and security.txt renewal; `docs/API.md`; threat model section 4.6b, AR-40 and AR-41; release gates;
  spec 15 F237, F238, F242 statuses.
- Small refactors so the matrix reads real constants: `src/auth/session-policy.ts`,
  `RATE_LIMIT_RETENTION_MS`, and the purge table lists exported from `src/pipeline/purge.ts`.

**Security review fixes (same PR)**

- H1: erasure needs a session created within 10 minutes (`403 reauth_required`), the dashboard
  (`web/src/account/`, Settings) re-signs the person in by password or passkey and retries, and a notice
  email goes to the address on file before the delete. The typed email is documented as a misclick guard
  only (AR-41 reworded). No soft-delete: documented prominently instead.
- M1: pending invitations sent by an erased admin are reassigned to another admin, not deleted.
- M2: only the last-admin trigger gives 409; other database faults are logged and give 500.
- M3: `expired_auth_purge` aborts and logs `expired_purge_aborted` on a seconds-looking expiry or a
  majority-expired large session table; tests use real-shaped rows (Drizzle) with a magnitude canary.
- M4: `security.txt` is generated per request (no static file, no expiry).
- L1 docs claim about the expiry index corrected; L2 `Sec-Fetch-Site` check on the export; L3 never-verified
  accounts listed as a gap; L5 the erasure audit row carries no IP or user agent.

**Verified by**

- `tests/api/account.test.ts`, `tests/pipeline/expired-records.test.ts`, `web/src/account/delete-account.test.tsx`,
  `tests/compliance/retention.test.ts`, `tests/web/security-txt.test.ts`, and
  `npm run format && npm run check`. The account routes run the real Worker over the real
  migrations on the Node SQLite D1 fake with the session faked by a header.

**Not done**

- Data processing agreement templates, legal review, the legal-basis and controller or processor
  decisions, a privacy policy, notification-deadline decisions.
- A penetration test, SOC 2, ISO 27001 or any audit: none exists and none is claimed.
- Anything against real Cloudflare: D1 delete semantics, the assets layer serving
  `/.well-known/security.txt` with the right content type, Time Travel, `Clear-Site-Data`.
- A second factor or an undo window for erasure (AR-41); scrubbing audit IP and user agent on erasure
  (AR-40, blocked by the append-only trigger); correction and restriction mechanisms.
- Expired invitations and the retired `auth_*` tables are not purged; no per-workspace retention
  setting; no staleness alerts on purge jobs; the workspace export omits notification content.
- Rehearsal of the incident playbooks, a monitored security contact, response targets, an
  automatic evidence hold, a sign-up kill switch.

## Slice 10a — generic signed-webhook source (this PR)

**What changed**

- `migrations/0017_generic_source.sql`: `sources` table (sealed secret columns, public
  `endpoint_id`, tenant triggers, cascade from the organization), `integrations.source_id`, and
  a trigger that refuses a cross-organization source reference. Expand-only.
- `src/connectors/sources/generic/`: `route.ts` (`POST /webhooks/generic/:endpointId`),
  `signature.ts` (Standard Webhooks `v1`, constant-time, replay window), `event.ts` (strict
  envelope validator and mapper to `DeliveryMessage`), `secret.ts` / `encoding.ts` (seal with
  purpose `source.signing`, generation, KEK rewrap).
- `src/api/sources.ts`: CRUD, rotate, delete under `source.*` capabilities, audit events,
  quota, rate limit, deletion-pending guard. Integrations accept `sourceId`; export lists
  sources without credential columns; `sources` joins `TENANT_TABLES`; `rewrapStaleSourceKeys`
  runs in the credential maintenance cron.
- `DeliveryMessage.status` gained `warning`; `sourceIngressLimiter` in `src/security/rate-limit.ts`.
- Dashboard: `/sources` (create, one-time secret, endpoint, copy, pause, rotate, delete,
  examples, connect a chat); source integrations render without a repository.
- Docs: ADR 0012, `docs/API.md`, `docs/FRONTEND.md`, spec 06 and 04 status notes.

**Verified by**

- `tests/sources/` (signature, event, ingress, API) and `web/src/sources/sources.test.ts`,
  `tests/migrations.test.ts` (0017), `tests/auth/permissions.test.ts`, and
  `npm run format && npm run check`. The end-to-end tests send signed events through the real
  Worker, then the real consumer and the Slack, Lark and Teams adapters over the fake D1, with
  `fetch` stubbed. The shell and Node examples are executed and verified by the Worker's verifier.
- **The Standard Webhooks spec's example signature could not be used**: it publishes the id,
  timestamp, payload and signatures but not the secret. Vectors are generated at runtime and
  cross-checked against `node:crypto`.
- Not verified: real D1, Queues, a real third-party sender, timing parity of the 404 path
  (shape equality only), and the new screens in a browser (desktop, 320 px, keyboard, screen
  reader, contrast, Vietnamese).

**Not done / follow-ups**

- Secret overlap and rotation wizard, `secret_id_used` (F77); mapping, CloudEvents payloads,
  `data.extra`, `adapterVersion` (F78); hashed and dual endpoint keys (F76);
  `clock_skew_suspected` alert and `providerIdStability` (F75); fixture corpus gate (F79);
  setup wizard with a send-test step (F80); filtering by generic event type (slice 7); the
  1 MiB cap of F78 (this source caps at 256 KiB).
- No source health beyond `last_received_at`; no per-source rate-limit tuning.
- GitLab, Stripe, Linear, Sentry and Cloudflare sources (F81–F90).

**Security review of this slice (fixed in the same PR)**

- M1: `src/lib/body.ts` `readBodyCapped` counts streamed bytes and stops at the cap; used by the
  generic route (256 KiB) and the GitHub route (1 MiB). Tested with chunked and lying
  `Content-Length` requests.
- M2: the decoy HMAC is skipped above 16 KiB; `docs/RUNBOOK.md` documents the edge rate rule
  and `docs/THREAT_MODEL.md` has section 4.1b plus AR-18. **The edge rule is not configured or
  rehearsed.**
- M3: `deliveries.body_hash`; a reused `webhook-id` with a different body is `409
  webhook_id_reused`, counted per source and shown on the Sources page (AR-19).
- M4: `source.rotate` and `source.delete` are admin-only; deleting a source with chats needs
  `?cascade=true` (otherwise 409 with the count); the UI hides the buttons from members and the
  dialog states the count.
- L2: rotate is guarded on the wrapped key it read (409 on a concurrent change). L3: the
  25-source quota is inside the `INSERT`. L4: `integrations.source_id` is immutable once set and
  an `AFTER DELETE` trigger on `sources` leaves no orphan integrations. L5: the outbox insert
  is conditional on the delivery insert (`changes() > 0`); the GitHub route had the same
  defect (a redelivery after outbox retention sent again) and is fixed with a test.

## Fix F — new users and multi-workspace sign-in

Found by the accessibility agent while walking the app in a real browser.

- `GET /api/workspace/me` answered 403 for a signed-in user with no workspace, and the
  dashboard treats any `/me` failure as signed out. A new user was bounced to `/signin` and
  could never reach onboarding. It now returns the user with `org_id: null`.
- PR #5 allowed several workspaces per user, but the Better Auth organization hooks still
  refused to create, add or accept a second one ("An account can belong to only one
  organization"). They are removed; verified email is still required to accept an invitation.
- A new session now starts in the user's earliest workspace, and a user left with several
  workspaces and no valid active one (for example after a purge) is settled on the earliest
  and that choice is stored on the session. An explicit `?org=` for a workspace the caller is
  not in is still a 404.
- Covered by `tests/api/workspace-me.test.ts`.
- The workspace switcher was not built here; it shipped in slice 6e (below).

## Slice 6e — workspace switcher and audit log (ADR 0019, this PR)

Two gaps left on purpose. Full decisions, the disclosure rules and the verification record are in
[ADR 0019](adr/0019-workspace-switcher-audit-log.md); this is the summary.

- **Workspace switcher.** `POST /api/workspace/active` (membership from the database, 404 with one
  shape for a non-member and an unknown organization, own session row only, CSRF by the central
  middleware, 30 a minute per user); `/me` returns `activeOrgId`. A sidebar menu (Base UI) for
  several workspaces, a static label plus "Create another workspace" for one, nothing for none.
  Every workspace-scoped query key is `[area, orgId, ...]` (the team list was the one that was not);
  a switch drops every other workspace's cache and refetches. Onboarding can create an additional
  workspace and activates it through our endpoint.
- **Audit log.** `GET /api/audit` (`audit.read`, admin only), cursor on `(created_at, id)`, filters,
  120 reads a minute. Actor is a **name only** and only for a current member; no email, no IP, no user
  agent; `metadata_json` goes through a per-action allow-list with truncation. `/audit` page with
  plain-language English and Vietnamese labels for every recorded action, URL-backed filters, empty and
  error states, the retention in force, and a formula-safe CSV of the events loaded.
- **Tests.** API (`tests/api/workspace-active.test.ts`, `tests/api/audit.test.ts`) and dashboard
  (`web/src/workspace/switcher.test.tsx`, `web/src/audit/audit.test.tsx`, new axe scenarios for `/audit`
  and the multi-workspace shell in both languages).
- **Security review follow-ups (this PR):** a person in several workspaces must send `?org=` on every
  write (400 otherwise, enforced in `resolveWorkspace`), forms bind the workspace they were opened for,
  a tab detects a switch made in another tab and says so; invitations can be accepted by an existing
  member; onboarding no longer invites a duplicate on a failed activation; the audit actor distinguishes
  a former member from an outside user; refused-probe auditing is rate limited per person (and a refused
  switch is audited); more invisible characters stripped and cuts are by code point; CSV has a BOM.
- **Not done:** the F222
  read side beyond this (actor/target filters, total, correlation id, diff, member and session
  events); the workspace export still carries raw `metadata_json`; no screen reader, Firefox or Safari
  pass; the Vietnamese copy is unreviewed.

## Slice 10b — GitLab and Stripe sources, Sentry refused (this PR)

**What changed**

- `migrations/0019_provider_sources.sql`: `sources` rebuilt (kind CHECK `generic|gitlab|stripe`,
  columns `auth_mode`, `livemode`), every column, index and trigger preserved; schema-diff test.
- `src/connectors/sources/`: `types.ts` (`SourceConnector` contract), `registry.ts`,
  `provider-route.ts` (`POST /webhooks/<kind>/:endpointId`), `gitlab/` and `stripe/`
  (verify, map, catalogue, pasted-credential parsing), `text.ts` (display sanitising),
  `src/lib/timing.ts` (constant-time string compare).
- `src/api/sources.ts`: kinds, pasted credentials sealed on write and never returned, provider
  rotate, Sentry refused with the reason. `src/api/integrations.ts` / `integration-input.ts`:
  `eventTypes` on source integrations validated against the kind's catalogue (GitHub path untouched).
- Dashboard: kind picker, GitLab auth-mode and Stripe test/live choices, masked credential field,
  provider guidance, event checkboxes per chat, replace-credential dialog; copy in
  `messages.providers.en.ts`.
- Docs: ADR 0015, `docs/API.md`, `docs/FRONTEND.md`, spec 06 statuses.

**Verified by**

- `tests/sources/gitlab.test.ts`, `stripe.test.ts`, `provider-api.test.ts`,
  `tests/migration-0019.test.ts`, `web/src/sources/providers.test.tsx`, and `npm run format &&
  npm run check` (all green). Signatures are built with `node:crypto`; mapping fixtures are the
  providers' documented examples. End to end through the real Slack, Lark and Teams adapters over
  the fake D1.
- Not verified: any real GitLab or Stripe delivery, real D1 and Queues, the new screens in a browser
  (desktop, 320 px, keyboard, screen reader, contrast, Vietnamese). UNVERIFIED provider facts are
  listed in ADR 0015.

**Security review follow-up**: GitLab links restricted to gitlab.com (M1); dropped-event counter,
migration 0020, card, export, `ingressDropped` in the observability summary (M2); coarse per-endpoint
limiter before the secret unwrap (L1); unreadable `event_types` delivers nothing (L3); confidential
issues build no labels (L4); export lists `auth_mode`/`livemode` (L5); `whsec_` scrubber (L6);
`confirmDowngrade` for GitLab signing token to secret token (L7). Vietnamese copy
(`messages.providers.vi.ts`) and `useLocale()` added for the rebased i18n/a11y rules; the a11y
source fixtures carry the new fields. Details: ADR 0015.

**Not done / follow-ups**: see ADR 0015 "Deliberately not done" (GitLab self-managed and the F82
health model, Stripe thin events, enrichment, semantic dedup and reconciliation, Linear, Cloudflare,
fixtures captured from real providers, merging the two webhook fan-out paths). Sentry is a
recorded refusal, not a gap.
## Slice 8a — Discord and the signed customer webhook (this PR)

**What changed**

- `migrations/0018_extended_destinations.sql`: `integrations` rebuilt to widen the destination
  CHECK to `discord` and `generic_webhook`; everything else (all columns, `filters_json` and its
  CHECK, `source_id`, four indexes, four triggers, and the `sources` trigger that names the
  table) is carried over and diffed by `tests/migration-0018.test.ts`.
- `src/connectors/destinations/discord/` and `generic-webhook/` (render, classify, adapter);
  `address-policy.ts` (private-range table), `dns-check.ts` (save-time DNS-over-HTTPS);
  `url-policy.ts` (Discord host/path/query, customer-host shape rules), `config.ts`,
  `capabilities.ts`, `markup.ts` (Discord dialects), `index.ts` (dispatch, `DeliveryMeta`).
- Consumer: passes `DeliveryMeta`, the signing secret for the custom webhook, and pauses a
  Discord integration after a 404/410 or Discord code 10015/50027 (`integration.auto_pause` audit).
- API: the two kinds, server-generated one-time signing secret, DNS verification on create and
  rotation (`src/api/destination-host.ts`).
- Dashboard: two destination entries, `IssuedSecret`, copy in `messages.destinations.en.ts`.
- Docs: ADR 0014, API.md, FRONTEND.md, threat model (AR-30, AR-31), specs 07 and 09 statuses.

**Verified by**

- Unit and end-to-end tests over the real migrations and fake D1 (`tests/destinations/discord`,
  `generic-webhook`, `tests/pipeline/extended-destinations`, `tests/api/extended-destinations`,
  `tests/migration-0018`, `web/src/integrations/destinations.test.ts`) and
  `npm run format && npm run check`. The custom-webhook tests verify the signature with the
  same verifier the generic source uses; fixtures are built at runtime.
- A live DNS-over-HTTPS query from a developer machine confirmed the response shape the check
  parses. No real Discord webhook, customer endpoint or Worker egress was exercised.

**Review round (SSRF review of PR #30, rebased on PR #28/#29)**

- `GENERIC_WEBHOOK_ENABLED` (default `"false"`) gates the custom webhook in the API validator
  (one message, before the URL is examined), on re-enable and rotation, in the consumer (stored
  rows are refused unsent), and in the dashboard (`capabilities` on the list response); the
  enabling criteria are in ADR 0014 decision 18.
- `global_fetch_strictly_public` researched: documented as routing semantics, not an
  address filter; **not added**, marked UNVERIFIED.
- Blocked: `workers.dev`, `pages.dev`, `cfargotunnel.com`, and the `APP_ORIGIN` host and parent
  (passed to the policy at save and send); `workers_dev: false`; CNAME targets in the DNS check;
  DNS re-run on re-enable; at most 10 custom webhooks per workspace; connection failures shown
  as one reason.
- Discord pause: only for 404/410 or Discord code 10015/50027, tied to the credential used, in
  one batch with its audit row; other 401/403 retry at most once more and never pause.
- Vietnamese catalogue for the new copy; `IssuedSecret` calls `useLocale()`.

**Not done**

- Telegram (spec recommends against) and email (spec rejects Cloudflare Email Sending for
  notifications; the recommended provider, recipient verification and unsubscribe do not exist).
- The workspace host allowlist, periodic re-resolution and recorded addresses; **DNS rebinding
  is not defeated** (AR-30). Whether Workers egress can reach metadata/RFC 1918 space is untested.
- Discord: persisted cross-workspace breaker (AR-31), message-id capture and update-in-place,
  rate-limit pacing, identity fields, programmatic webhook creation.
- Custom webhook: payload template, secret rotation overlap, event and correlation id headers,
  send-a-test, expected-status setting, rate limiting and breaker, the source chat picker.
- No browser pass of the new screens.

**UNVERIFIED**: see the list in ADR 0014 (Discord per-route limit, legacy and canary hosts, token
shapes, embed-title markdown, the Worker-side DoH answer, egress reachability).



## Toolchain majors (2026-10-14)

One coordinated upgrade replaces four separate Dependabot PRs (#19 plugin-react, #20 typescript,
#21 coverage-v8, #22 vite). Evidence read on 2026-10-14 from `npm view <pkg>@<ver> peerDependencies
engines time` and the official migration guides (vite.dev/guide/migration, vitest.dev/guide/migration).
Versions chosen are at least two weeks old, exact-pinned where the repo pins.

| Package | From | To | Decision | Evidence |
| --- | --- | --- | --- | --- |
| vite | ^7.1.0 | ^8.3.1 (locked 8.3.1, 2026-09-24) | Upgraded | Node `^20.19 \|\| >=22.12`; `@tailwindcss/vite` 4.3.3 peers `vite ^5.2 \|\| ^6 \|\| ^7 \|\| ^8`. No config change needed: the app uses no `rollupOptions`/`esbuild` options. Bundle 247 kB gzip JS, 12 kB gzip CSS |
| @vitejs/plugin-react | ^5.0.0 | ^6.1.1 (2026-08-28) | Upgraded | Peers `vite ^8.0.0` (its optional babel/oxc peers are unused) |
| vitest | 3.2.7 | 5.0.2 (2026-09-25) | Upgraded | Peers `vite ^6.4 \|\| ^7 \|\| ^8`, Node `^22.12 \|\| ^24 \|\| >=26`; `better-auth` 1.7.7 optional peer accepts `^5.0.0`. No `tinypool` dependency (3.2.7 had it). 4.1.11 also passed the whole check, so 4.x is the fallback |
| @vitest/coverage-v8 | 3.2.7 | 5.0.2 | Upgraded | Must equal the vitest version (peer `vitest: 5.0.2`) |
| typescript | ^5.9.2 | not upgraded | **Deferred** | `typescript-eslint` 8.71.2 (latest) peers `typescript >=4.8.4 <6.1.0`, so 6.1+ and 7.0.2 are outside the supported range. Dependabot major ignore added, revisit 2026-12-14 |
| @tailwindcss/vite, drizzle-kit, typescript-eslint | | unchanged | n/a | Already compatible with vite 8 or untouched |

Consequences and fixes:

- The two audit exceptions in `scripts/audit-gate.mjs` and `docs/SECURITY.md` are removed; the list
  is empty and `npm run audit:gate` passes with none. The exception mechanism and its tests stay.
- `package.json` `engines.node` is now `>=22.12`, which vite 8 and vitest 5 already require.
- `tsconfig.json` lists `"node"` in `types`. Before, `@types/node` entered the program only through a
  triple-slash reference in vite 7 / vitest 3; the same Node typings are available as before.
- `tests/pipeline/{destinations,reliability,extended-destinations}.test.ts`, `tests/api/extended-destinations.test.ts`: `fetchMock` typed `Mock<typeof fetch>`
  (vitest 4+ types made the untyped `vi.fn` trip `no-misused-promises`).
- Lockfile: regenerated only for the toolchain subtree (npm 10.9.2 cannot resolve vitest 4+ with
  vite 8: `Cannot read properties of null (reading 'edgesOut')` in arborist; the lock was resolved with
  npm 11.19.1, and `npm ci` was then verified with the repo's npm 10).

**Verified by**: `npm ci` from scratch, `npm run format && npm run check` (2225 tests, typecheck,
web typecheck, build, worker bundle), `npm run test:coverage`, `npm run audit:gate`, and the built
SPA served by `npm run preview:web`: `/` redirects to `/signin`, which renders with its fonts and
assets and no script errors. The only console errors are two 502s from `/api/workspace/me`
because no Worker was running behind the preview proxy.
**Not verified**: the dashboard behind sign-in against a running Worker, and the Vite 8 dev server
(`npm run dev:web`) beyond starting the production build; CSS output is minified by Lightning CSS
now, so a visual diff of the authenticated screens was not run.

## TanStack Start (ADR 0017)

The dashboard is now a TanStack Start app in SPA mode, built and served by the same Worker as the API.

- File routes under `web/src/routes/` replace `web/src/main.tsx` and `web/index.html`; the page
  components are unchanged.
- `src/worker.ts` is the Worker entry: Hono for `/api`, `/webhooks`, `/github`, `/health`; the
  prerendered shell for everything else; `scheduled` and `queue` exactly as before.
- One `vite dev` process on :5173 serves both; the Vite proxy is gone. `npm run deploy` builds and
  deploys `web/dist/server/wrangler.json`.
- The CSP stays free of `'unsafe-inline'`: the Worker adds the SHA-256 of Start's inline scripts.
- New tests: `tests/web/shell.test.ts`, `tests/web/start-boundary.test.ts`; the route-coverage and
  font tests read the file routes.

**Verified** in a real browser against the production build under `vite preview` and against
`vite dev` (Chrome, Vietnamese locale): sign-in with cookies, onboarding, workspace creation (a
same-origin POST through the CSRF check), deep-link reload of `/integrations`, cron via
`/cdn-cgi/handler/scheduled` (heartbeat row written), strict CSP with no console errors.
**Not verified**: a real Cloudflare deployment, the queue consumer processing a live message through
the new entry (it is exported and type-checked), the CI run of the Vite build (it starts workerd to
prerender), other signed-in screens under the CSP, and a 320px or keyboard pass on the routed shell.

### TanStack Start: security review follow-up

- Start's handler is now unreachable in a deployment (`X-TSS_SHELL: true` exactly, loopback host
  and no built shell, or `vite dev`); `tests/web/worker.test.ts` drives `src/worker.ts`.
- `@tanstack/react-start` 1.168.60 (patched for GHSA-qx66-fv34-fjm8) with `react-router` 1.170.41.
- Four build-only packages are held back by `overrides`; the remaining age exceptions are listed in
  ADR 0017 ("Dependency age"). `npm run audit:gate` passes.
- Static extensions allow-list for the assets layer; assets misses carry the baseline headers.
- `verify:worker-bundle` reads the built default export (fetch, queue, scheduled), the cron and both
  queue consumers, `html_handling`/`not_found_handling` `none`, fails in CI if
  `web/dist/server/.dev.vars` exists, and `npm run deploy` strips it first.
- New explicit items in `RELEASE_GATES.md` section 3 for what is still unverified on a real deployment.

## Dependency deferrals (2026-10-14)

| PR | Package | Decision | Why |
| --- | --- | --- | --- |
| #43, #17, #32 | minor/patch groups, GitHub Actions | merged | CI green; pins stay full-SHA / exact |
| #40 | `@types/node` 22 → 26 | closed, major ignored | types must match the runtime floor (Node 22) |
| #39 | `jsdom` 29 → 30 | closed, major ignored until 2026-11-01 | 10 days old (< 2 weeks); needs Node ≥22.22 |
| #38 | `@tanstack/react-table` 8 → 9 | closed, major ignored | breaking API; CI fails; needs a deliberate port |

## Spec reconciliation (2026-10-14)

The `Status` line of every feature F01 to F262 was re-derived from the code, tests, migrations
and ADRs instead of earlier status prose. Before, the lines were a mix of free-text ("not
started", "partial (slice 8a) ...", "implemented") with no common vocabulary and spec 01
saying "not started" for all fourteen features.

| | Done | Partial | Not started | Blocked | Deferred or decided against |
| --- | --- | --- | --- | --- | --- |
| Before (classified from the old wording) | 25 | 96 | 135 | 0 | 6 (free-text, unclassifiable) |
| After (`docs/specs/STATUS.md`, generated) | 32 | 152 | 56 | 5 | 17 |

Method: one audit pass per spec file, each reading the feature's acceptance list and checking it
against `src/`, `web/src/`, `migrations/`, `tests/`, `scripts/`, `.github/` and `wrangler.jsonc`.
A feature is done only when its acceptance list is substantially met and a test exercises it;
pure modules that are not wired count as partial; process features (rehearsals, audits,
real-provider runs) are not done without evidence. Tests were not re-run as part of this audit:
done means a test that covers the behaviour exists, as read, and `npm run check` passes.

Biggest corrections:

- **Spec 01 (platform):** 14 "not started" became 3 done (F08 backoff and ack, F12 redaction,
  F13 error taxonomy), 9 partial (toolchain, CI, boot assertions, migrations, queues, D1 writes,
  health, correlation, ADRs), 1 not started (F03 environments, needs a staging account) and 1
  deferred (F06 sharding).
- **Spec 04 (event model):** nothing is done. Ingress builds a bounded delivery message, not the
  canonical envelope; F41, F46, F52 to F54 are not started. The closed GitHub catalogue and
  delivery-id dedup are the partial pieces.
- **Specs 10 and 11:** no feature is done. Slices 7 and 8 shipped closed filters and noise
  control (ADRs 0010, 0016), which is not the rule engine, preferences or preset library the
  specs describe; the status lines now say which halves exist.
- **Spec 14:** no feature is done; most are partial. F226 (usability gate) is blocked, not
  "partial".
- **Spec 16:** the AI part (F243 to F252) is marked deferred, not "not started": no AI code
  exists and `AGENTS.md` makes it optional and later. Marketplace (F259) is deferred as
  forbidden in V1.
- **Spec 15:** the old note that the ingress limiter is not wired was stale; it is wired for the
  GitHub and source routes. (`docs/RELEASE_GATES.md` still carries that stale note and ADR 0015
  still says the dropped-events counter is not built although migration 0020 exists; both are
  left for the PR that owns those documents.)
- **Spec 02:** the Better Auth rules (F16 to F22) are configured but no test shows their
  behaviour, so they are partial rather than done.

New files: `docs/specs/STATUS.md` (generated by `npm run docs:spec-status`, checked by
`tests/spec-status.test.ts`), `docs/specs/REMAINING.md` (the work queue: P0 blockers, P1 for V1,
external blockers, P2 and deferred). The README status table was replaced by generated counts.

## Test stability: pinned clock

Several limiters use fixed one-minute windows keyed on `Date.now()`, and a test that drove one
with a loop could cross a minute boundary half-way and fail about one run in a few hundred
(seen on PR #47's CI). `tests/setup/pin-clock.ts` now freezes `Date` 10 s into a minute for every
test (timers and promises stay real). A test that needs time to move calls `vi.setSystemTime`.
## Slice 4b: canonical event, conformance and fixture replay (ADR 0020, this PR)

- `src/events/`: `CanonicalEvent` (CloudEvents-aligned, versioned, closed `data`), a bounded hand-written
  validator (64 KiB budget, no payload bodies, unsafe-text rules), the event-type registry
  (`GITHUB_/GITLAB_/STRIPE_EVENT_TYPES` are derived from it) and shared text hygiene.
- GitHub, generic, GitLab and Stripe map to a canonical event and validate it before routing;
  `DeliveryMessage` and the GitHub routing facts are derived from it. Behaviour is unchanged for the
  existing 2935 tests (3230 now, with the new suites). The one intended change: control characters and bidirectional marks in provider
  text become spaces, and a non-https GitHub link is dropped.
- `SourceDescriptor` plus `tests/conformance/conformance.test.ts`: one suite, run against all four
  sources (verify before parse, size cap including chunked, replay window or idempotency, identical
  404 or 403, content type, determinism, no payload or personal data in the event, bounded output,
  closed catalogue).
- `tests/fixtures/`: 59 documented, derived or composed fixtures with provenance (README), goldens for
  the canonical event, routing under five filter configurations and Slack, Lark, Teams and Discord
  payloads, a no-skip corpus gate and a hygiene scan. Updated only with `UPDATE_GOLDEN=1`.
- GitHub: a delivery without `X-GitHub-Event` is now 400; ghost senders are not shown as people;
  `[bot]` logins set `isBot`; an oversize body is logged with its reason; ack discipline (5xx on D1
  failure, dispatcher kick after the commit) is pinned by tests.

**Review follow-up** (independent review of PR #49): a validator rejection for our own mismatch is a
logged, counted 2xx (never a provider-visible 4xx); one `buildCanonical` for routes and harness; a
generic summary cut inside an emoji no longer leaves half a pair (H1); unknown facts instead of
truncated ones; zero-width and tag characters are unsafe text; the oversize log is sampled; render
goldens only for eight representative fixtures and no golden update in CI; wider secret scan; the
source-text verify-order check was dropped in favour of the behavioural tests.

**Not done / unverified**: F65 polling and F69 reconciliation are **blocked on the GitHub App private
key and API access** and are not implemented; fixtures are documented examples, some derived by a
stated field change (GitHub `closed` is `merged=false`; the merged, draft, bot, ghost and workflow
conclusion variants are derived), the Stripe ones are composed and the GitLab `failed` pipeline and
`X-Gitlab-Instance` value are unverified; no real captures. CloudEvents export, a schema registry
and published JSON Schemas, ULID ids, `orgid`/`connectionid`, the `unmapped:` view, `rawOutcome` and
`closesEventId`, the stored `adapter_version`, noise facts from the canonical event, and the full
`SourceAdapter` interface are not built. Titles of push, release, workflow_run and deployment_status
messages are still the event type string (visible in the goldens).

## Credential lifecycle, boot hygiene and D1 write discipline (ADR 0022)

REMAINING.md slices 1.2, 1.3 and 1.4. Decisions and the not-done list are in
[ADR 0022](adr/0022-credential-lifecycle-and-boot.md).

**What changed**

- `migrations/0024_credential_lifecycle.sql` (expand-only, apply before the Worker):
  `integrations.credential_fingerprint`, `sources.credential_fingerprint`,
  `sources.credentials_revoked_at`.
- `src/crypto/fingerprint.ts`: `credentialFingerprint` (tenant-keyed HMAC under `FINGERPRINT_KEY`, F39; first version was an
  unsalted SHA-256 prefix, replaced in the review round below) and `kekCheckValue` (HKDF of a label under the KEK, F34). The fingerprint is written when a credential is sealed
  (create, rotate, v0 migration) and returned as `credentialFingerprint`.
- Revoke: `POST /api/integrations/:id/revoke-credentials` and `POST /api/sources/:id/revoke-credentials`
  (new admin-only capabilities `integration.revoke`, `source.revoke`; audit actions
  `integration.credentials.revoke`, `source.credentials.revoke`). Integration: quarantine reason `revoked`,
  `revoked: true` in the view, counted separately by `credentialStatus`. Source: disabled plus
  `credentials_revoked_at`, re-enable blocked until `rotate`.
- `scripts/kek-destroy-check.mjs` (`check-value`, `destroy-check`, `record-destruction`) and the platform audit
  event `key.destroy` (subject type `key`, no workspace). The check counts rows by the `kek_version` column and by
  the version inside the wrapped key.
- `src/platform/config.ts`: `assertConfig(env)` (names only), `kekMismatches`, `bootReport`. New vars
  `ENVIRONMENT_NAME`, `KEK_CHECK_V1`, `KEK_CHECK_V2` (`wrangler.jsonc`, `.dev.vars.example`).
  `src/index.ts`: fetch guard middleware (tiered, see the review round below), `queue` retries each delivery message on
  a growing delay, `scheduled` throws after recording its heartbeat; `GET /health` (config only, 200 while D1 is down) and the new
  `GET /health/ready` (`{ok, checks:{config,d1,queue}}`).
- `src/db/retry.ts`: `classifyD1Error`, `withD1Retry` (full jitter, at most 5 attempts, `idempotent` required),
  `ingressBatch` applied to the delivery+outbox batch of the GitHub, generic and provider routes.
- i18n: en and vi labels for the three new audit actions and the `key` subject.

**Verified by** (new tests; the suite went from 2948 to 3037 tests)

- `tests/security/credential-lifecycle.test.ts`: fingerprint, revoke for both kinds (admin only, CSRF, tenant scope,
  validation, idempotence, queued messages not delivered, cleared only by a new credential), and the
  crypto-shredding proof (no copy of the wrapped key or ciphertext survives any table; the ciphertext does not open
  even with the KEK).
- `tests/security/secrets-not-stored.test.ts`: a scan of every column of every table, every queue message and every
  log line after a realistic run (API-created sources and integrations, a v0 row migrated, a GitHub and a generic
  event delivered, a KEK rotation) for KEK v1 and v2, the legacy key, the webhook and session secrets and the
  clear webhook URLs and signing secret; plus a control showing the scan finds a planted value in text, base64 and BLOB form.
- `tests/platform/boot.test.ts`: `assertConfig`, the check value, `/health` and `/health/ready` with D1 down, a
  rejecting D1, a missing queue, a bad key ring and a foreign KEK, the fail-closed paths with headers and a
  correlation id, the queue retry and the failing tick.
- `tests/security/kek-destroy-check.test.ts`: the destruction check against the real migrations, including a stale
  column, and the single-statement audit record.
- `tests/db/retry.test.ts`: classification of the documented messages, bounded full-jitter retry, no retry of
  constraint or overload errors, and an ingress batch that is retried before the commit and after it (one delivery,
  one outbox row either way).
- `tests/security/bound-parameters.test.ts`: every dynamic part of every SQL string in `src/` is reviewed and none is
  request-derived.

**Not done** (see the ADR for reasons): Secrets Store for the KEK; drain-then-destroy on revoke and
`destination_revoked` in the consumer; a dashboard control and fingerprint display; `withD1Retry` on the outbox
claim and dispatch writes; `APP_ORIGIN`, `BETTER_AUTH_SECRET` and the GitHub bindings in `assertConfig`; the
`no_query_exceeds_100_bound_parameters` test; a staging rehearsal of rotation and destruction.
**UNVERIFIED:** the D1 error message wording (taken from Cloudflare's documentation, not observed).

### Review round for ADR 0022 (PR #51)

An independent review (no critical, 3 high, 6 medium, 7 low) is fixed in the same PR, each with tests:

- **High.** `/health/ready` was answered by the SPA shell in a deployment (`isBackendPath` matched only `/health`): fixed and
  tested through `src/worker.ts`. A configuration outage retried the whole batch on a flat 60 s delay and would have
  dead-lettered in-flight deliveries after five minutes: each message now backs off 5 min doubling (about 2.6 h), the DLQ
  consumer is never gated, and the docs say what is and is not recovered. A fail-closed 503 lost webhooks: ingress is now
  gated only on D1; a key-ring or KEK fault stops only requests that seal or open credentials.
- **Medium.** A predeploy guard, a CI allow-list for placeholders and a post-deploy smoke check; the rotation order; a malformed
  optional `ENCRYPTION_KEY` is a `/health` warning that stands down only the v0 migration (required vs optional bindings are
  tabulated in the ADR); a revoke cannot be undone by pasting the same credential or by a member; revoke writes one audit
  entry under concurrency; the fingerprint is a tenant-keyed HMAC under a dedicated optional `FINGERPRINT_KEY`.
- **Low.** Heartbeat and stall detection run before the boot throw; `bootReport` never rejects or memoises a failure;
  `development` needs a local `APP_ORIGIN`; the check value is HKDF-derived (label `kcv/v2`); `/health/ready` is cached 5 s with
  its timer cleared; `key.destroy` reads "authorised" and is exempt from the audit purge; the post-commit retry caveat is
  documented; the bound-parameter guard now catches `+` after any literal, string methods, `String.raw` and aliased `prepare`,
  requires allow-listed identifiers to be declared from literals in the same file, and scans `scripts/*.mjs`.

## Slices 1.9 to 1.11 — job runner, correlation and alerting (ADR 0024, this PR)

Scope: `docs/specs/REMAINING.md` rows 1.9 to 1.11 and `docs/adr/0024-job-runner-alerting.md`. Migration
`0027_job_runner_alerting.sql` (expand only; apply before the Worker).

- `job_state` (one upserted row per job) plus `job_runs` (history of failures and outcome changes only), one
  batch per tick; one cadence table; staleness at 3x cadence (`jobs` for admins, `jobsStatus` for everyone) and
  as `job_stale`; a job with no record is not stale. Maintenance windows write one `ops_state` marker so they
  are not read as a missed cron. Review follow-ups: capped, index-seek alert signals with plan tests; hysteresis
  and clear streaks; unsent notices re-sent as the same kind; a shared sink budget; webhook health for platform operators only (`PLATFORM_OPERATOR_USER_IDS`). Delta review: a freeze settle period and
  two-tick confirmation for the backlog alerts, a marker must bracket the whole heartbeat gap, a prolonged-
  maintenance log, `deliveries_org_correlation` for the API lookup, and recovery re-adds `correlation_id` after 0027.
- DLQ consumer writes an `ops_state` run record; `dlq_consumer_no_progress` is a ledger-side proxy, not queue depth.
- Correlation id on `deliveries`, outbox, attempts, queue message, consumer logs, delivery view;
  `GET /api/deliveries?correlationId=`.
- `alert_state` plus a ten-alert engine; sinks: log (always) and `ALERT_WEBHOOK_URL` (Slack, Discord, Lark,
  Teams only, URL policy, 10 s, one attempt). Runbook section per alert, enforced by a test.
- Not done: paging a human, leases/cursors/`cpu_ms`, real DLQ depth, threshold tuning, dashboard row for the
  correlation id, an external dead-man's-switch. Nothing verified against real Cloudflare or a real chat endpoint.

## Slices 1.5 to 1.8 — delivery ledger depth (ADR 0023, this PR)

Source of truth for scope: `docs/specs/REMAINING.md` (rows 1.5 to 1.8 now say what is built and
what is left) and `docs/adr/0023-delivery-ledger-depth.md`. Migration `0025_delivery_ledger_depth.sql`
(expand only; apply before the Worker).

What exists now:

- **Recorded dedup (F171, F185).** `event_dedup` (7-day TTL, hit count) is written in the ingress batch
  of the GitHub, generic and provider routes; a repeat of an accepted or held event becomes a
  `suppressed` delivery row with reason `duplicate` and `duplicate_of`, and bumps the counter. A bounded,
  resumable `dedup_purge` cron job removes expired rows. The TTL is asserted to exceed the GitHub and
  Stripe redelivery horizons. The conservation property test now accounts for every ingested event as
  delivered, held and released, or suppressed with a reason, and checks each `hit_count` against the
  suppressed rows.
- **Per-attempt ledger (F184, F181, F99).** `delivery_attempts`: one row per attempt and per deferral, in
  the same batch as the ledger transition and only when it changed the row (a lost claim records
  nothing, a double-consumed message records one). Closed vocabularies only. Returned as `attempts[]`
  by `GET /api/deliveries/:id` and shown as a timeline in the detail dialog (English and Vietnamese,
  axe-checked). Deleted with the delivery by retention, drained by the workspace purge, included in the
  export. `possible_duplicate` is set on a retry after an unconfirmed attempt (timeout, dropped
  connection, 5xx, expired claim) and shown as "may have arrived more than once".
- **Bulk replay (F182).** `POST /api/deliveries/replay-plan` and `POST /api/deliveries/replay`:
  dry-run count and a plan token first, at most 200 per request, refused when the set changed, typed
  confirmation above 20, one audit row with counts, 6 a minute, refused while deletion is pending, built on
  `redeliver()`. "Redeliver all failed" on the Failed view of Activity.
- **Circuit breaker and pacing (F183, F187, F178).** `destination_health` per integration: opens after 5
  consecutive `destination_unavailable` or `destination_timeout`, 5 minutes open, one half-open probe; while
  open or while the destination asked to be left alone (`x-ratelimit-remaining: 0`, 429 `Retry-After`) the
  consumer defers without a request and without spending an attempt. Shown on the integration and on
  each waiting delivery; never disables anything; tests bypass it; fails open if the table is
  unreadable. The observability summary gains `duplicates` and `destinationHealth`.

Tests: `tests/pipeline/ledger-depth.test.ts` (attempts, claim races, double consume, breaker transitions with
an injected clock, probe race, tenant isolation, pacing, retention), `tests/delivery/dedup.test.ts`,
`tests/api/delivery-depth.test.ts` (attempt view, flags, bulk plan and run: bounds, idempotency, stale plan,
capability, CSRF, rate limit, deletion pending), `tests/migration-0025.test.ts`, additions to the noise,
sources, observability and workspace-lifecycle tests, and web axe scenarios in
`web/src/a11y/dialogs.a11y.test.tsx`.

**Review follow-up (independent review of this PR):** bulk replay is chain-roots-only (a failed replay can no
longer be replayed twice in one request); waits are folded into one `deferred` row with `repeat_count` and the
history returns the newest 50 rows; a delivery held back for more than 24 hours is dead-lettered
(`circuit_open_timeout`, replayable); suppressed rows are capped at 20 per original; a repeat of a failed
original is shown as such; the bulk audit is an intent row before the replays plus a counts row after; the
stale-claim sweep writes an attempt row; deferrals no longer reuse the next real attempt number; the attempts
purge is driven by age (`delivery_attempts_age`); `delivery_attempts` and `destination_health` have an
organization foreign key with cascade; the suppression gate cannot be fooled by an orphan outbox row; the
"~600 D1 calls" figure is corrected to about 400.

**Not done / unverified:** `provider_message_id` is never populated (no adapter response carries one);
a per-connection dedup TTL; `semantic_dedup`; the per-destination client-side window (F186) and Lark
`uuid` (F188); `claim_conflict` and `provider_idempotency` suppressions are never written; a budget per
provider account (the consumer cannot tell which account a stored webhook belongs to), Slack API codes;
an alert when a breaker opens; the Discord global breaker; replay after outbox purge; the ~400
D1 calls of a full bulk replay against the real subrequest limit; a real browser at 320 px and a screen
reader for the new surfaces; Vietnamese copy review. No real provider has seen any of this: every
provider response in the tests is a fixture.
## Slice 1.1 / 1.20 / 1.23 — tenant contract closure (ADR 0021, this PR)

Closes the tenant contract in the schema and proves it statically. Nothing here has run on a real D1 or a
deployment.

- **Audit (over the full migration chain, via the fake D1).** `integrations`, `deliveries` and
  `notification_outbox` had a nullable `organization_id` and no foreign key; `held_events`,
  `routing_decisions` and `noise_open_failures` were NOT NULL with no foreign key. `audit_events`
  (nullable by design) and `workspace_deletions` (a ledger with no foreign key by design) stay as the only
  exceptions, and a test names them.
- **Migration 0026.** Rebuilds those six tables with `organization_id TEXT NOT NULL REFERENCES
  organization(id) ON DELETE CASCADE`. Backfills only what is derivable from our own rows (integration
  from its source, delivery from its integration, outbox row from its delivery or payload integration);
  quarantines the rest into `legacy_orphaned_rows` with metadata only (credentials and payloads leave the live tables, recoverable only through Time Travel; never guessed into a tenant); verifies the copy against the live original and swaps by RENAME, **keeping every original as `<table>_old`** (the guarded DROP of the first version was defeatable and was removed; see the non-destructive follow-up below). Renumbered 0023 -> 0026 so it follows 0024 (#51) and 0025 (#53); it carries 0024's `integrations.credential_fingerprint`. `tests/migration-0026.test.ts` (21 tests, incl. runners that abort and runners that carry on, a late writer, a re-run, and upgrades from 0012/0015/0017/0020/0021) diffs the schema before and after, runs the backfill over
  legacy-shaped rows, proves nothing secret reaches the quarantine, and proves an unbalanced copy aborts
  with the old schema intact. Six existing test files gained `seedOrganization` calls; one expectation
  changed to "the schema refuses a tenant-less outbox row".
- **Static query scope (F26, F233).** `tests/support/sql-scope.ts` + `tests/security/tenant-query-scope.test.ts`
  (43 tests). Tenant tables are derived from the schema. **Real violations found: none.** Everything flagged
  was tenant-agnostic by design and is one of 42 reviewed allowlist entries (credential-keyed ingress
  lookups, cron sweeps, retention, one primary-key-correlated subquery); an entry that stops matching fails.
  Proven against 42 fixtures (a top-level OR, the tenant inside an OR group, NOT, <> and !=, and predicates that exist only in a comment are all refused) and against real files with their predicates stripped.
- **Route registry (F232).** `src/auth/route-policy.ts` (39 routes), `tests/security/route-capability.test.ts`
  (46 tests: runtime `app.routes` vs registry vs source parse vs handler guard), `docs/AUTHORIZATION.md` with
  two generated tables and `npm run docs:authorization`. `app` is now a named export of `src/index.ts`;
  `DOMAIN_CAPABILITIES` is exported from `permissions.ts` and the permissions table test asserts it covers all.
- **Drill.** `scripts/lib/drill-plan.mjs` (shared plan), `tests/drill/tenant-isolation.test.ts` (113 tests; A to
  B, member of A to B, B to A; reads, writes, actions; control run; ingress; denials), and
  `scripts/tenant-isolation-drill.mjs` for a deployed URL (**UNVERIFIED**, never run). Result on the fake D1:
  every attempt 404, no leak, no row changed, nothing sent to the victim's destination.
- **Observation for a decision, not a bug fixed here:** F233 says every cross-tenant attempt is audited; ADR 0019
  caps recording at 20 a minute per user so a scan cannot flood a workspace's log. Left as is (REMAINING 1.23).

Not done: chunked backfill (one statement per table), 0026 on a real D1 and its rollback rehearsal, the
staging drill and Time Travel re-drill, audit of unknown-installation 403s, typed repository functions.

### Slice 1.1 review fixes (independent database review of #52)

- **H1 atomicity.** D1's per-file transaction and abort-on-error behaviour is not documented (UNVERIFIED), so the
  migration no longer relies on either: original renamed aside, copy takes its name, `DROP <t>_old` guarded by a
  foreign key released only by a recount. Tests run it under three runners, with a sabotaged copy and a late writer.
  `MAINTENANCE_MODE=true` (503 + Retry-After on all but the probes, cron skipped, queue retried) is the mandatory
  write freeze; `scripts/migration-0026-preflight.sql` / `.mjs` is the mandatory preflight; the runbook has the
  window, bookmark, recount and verification queries. Rehearsal on a real D1 is a blocking gate.
- **H2** quarantine fields are cut to 200 characters (a 2,400-character legacy repo overflowed the CHECK).
- **M1** re-runnable (`IF EXISTS` scratch, idempotent quarantine); **M2** wording corrected, preflight acknowledges the
  exact quarantine count; **M3** scanner refuses top-level OR, OR groups, NOT, `<>`/`!=` and comment-only predicates;
  allowlist `includes` tightened; **M4** the route guard must be an unconditional top-level statement before any
  database use, and a webhook verification must be a real call; **M5** tests without a wrapper transaction.
- **L1** copies in rowid order; **L2/L3** preflight reports delivery/integration/source organization mismatches and
  case-different ids (decision: kept / quarantined, never guessed); **L4** 100,000-row ceiling; **L5** upgrades from
  0012/0015/0017/0020/0021 are tested.
- Rebased over #47 and #51: renumbered 0023 to 0026; carries 0024's `integrations.credential_fingerprint`;
  `route-policy` gained the two revoke routes and `/health/ready`; the retention matrix has a row for the quarantine.
  Rebased again over #53 (0025): the rebuild also carries `deliveries.duplicate_of`, `suppressed_reason`, `possible_duplicate` and `provider_message_id`; the three new ledger tables need no rebuild; the routes `/api/deliveries/replay-plan` and `/replay` are in the registry and the drill; three retention statements (`PURGE_EVENT_DEDUP_SQL`, `PURGE_ATTEMPTS_SQL`, `PURGE_DESTINATION_HEALTH_SQL`) are allowlisted with reasons; the scanner accepts an outer row picked by equality with a scoped subquery. The legacy seed now holds rows with the new columns.

## Slice 6f: setup flow, shell and navigation, state gates (ADR 0025)

- **Server model.** `GET /api/setup/progress` v2: seven steps, five states, `blockedBy`, `nextAction`, `resume`.
  Derived from `github_installations`, `sources`, `integrations` and the delivery ledger; "GitHub App not configured"
  is a real `blocked` state from `githubAppConfig(env)`. `tests/api/setup-progress.test.ts`: 43 tests (pure table,
  API, tenant isolation, index-driven plans).
- **`/setup/:step`** (`web/src/setup/`): GitHub, repository, destination (creates the integration through the normal
  `POST /api/integrations`), events (optional), test, done. State comes from the server on every load; the only
  client state is the in-memory draft of the step in progress.
- **Shell.** `web/src/shell/route-guard.ts` (rows, not an array of exact paths), shell 404, breadcrumbs, `returnTo`
  validated by `safeReturnTo`, Activity nav link for failed deliveries.
- **Settings.** Section order per F217, `RepairPanel`, `HealthSection`, `HistorySection`.
- **States.** `Skeleton`, `EmptyState`, `ErrorPanel` (what, why, what to do, how to get help); banned-phrase test over
  both catalogues; four filler messages rewritten.
- **Verified:** unit, jsdom and axe tests (see the PR). Browser pass against `npm run dev`: see the PR description for
  exactly what was and was not driven by hand.
- **Not done:** real-provider validation of the GitHub connect round trip, Slack OAuth, Teams auth capture, screenshots
  pipeline, screen-reader and device matrix, usability test (F226).

## Slice 1.19: egress guards (ADR 0026)

- **AST regression guard** (`tests/security/egress.test.ts`, `tests/support/egress-ast.ts`): the TypeScript parser, not
  regular expressions, finds global `fetch` references (every form), `globalThis`/`self`/`window` fetch, WebSocket,
  EventSource, XMLHttpRequest, sendBeacon, eval, Function and network module imports (static, dynamic, `require`).
  Three files are allowed and pinned to exact call sites by AST (`send.ts` guard-before-request in one function,
  `dns-check.ts` URL from `DOH_ENDPOINT`, `github/install.ts` three calls from the GitHub constants). A regression guard,
  not a proof: aliasing is not followed. The GitHub install file was found by the first run.
- **Registry** (`src/connectors/destinations/provider-registry.ts`): exact hosts, path prefixes, host labels, `docsUrl`,
  `verifiedOn`, written reason for the Teams wildcard; `url-policy.ts` (including the Lark domain) reads it.
  `verifiedOn` is the reference's research date, an attestation nobody has made for the pages themselves.
- **Staleness** is a weekly workflow (`npm run check:stale`, `tests/stale/`), not part of `npm run check`.
- **Event**: `unmapped_provider_response` (kind, attempt, numeric status, status class, ids; no body or URL). Log only.
- **Verified:** unit tests for the above. **Not verified:** any real provider.

## Migration 0026 made non-destructive (ADR 0021 A4, follow-up to #52)

A second independent review applied 0026 in scratch SQLite (3 runner modes x sabotage x foreign keys on/off, plus
140 kill-between-statements states) and found the guarded `DROP TABLE <t>_old` could lose the originals (re-run
over a leftover `_old` in a carrying-on runner; foreign keys off; `defer_foreign_keys`). 0026 has never run on a real D1, so it was edited in place:

- **No DROP/DELETE/TRUNCATE of an original or `_old` anywhere in the file** (static scan test). `_old` stays until
  `scripts/migration-0026-finalize.mjs` (+ `.sql`) reconciles it row for row and drops it (idempotent, `--apply`, `--ack-drift`).
- **Tripwires and gates** (FK on, legacy_alter_table off, no `_old`, six live tables) that also stop a carrying-on runner:
  gate tables created by an erroring CTAS, `AND EXISTS (gate)` on every data statement, a poison view that fails every RENAME.
- **`scripts/migration-0026-recover.mjs`**: restores originals and verbatim indexes/triggers from `_snapshot_0026`; tested
  from every statement boundary (141 states) plus sabotage and late-writer states. `sources_delete_integrations` window shrunk to two adjacent statements.
- Preflight now derives tenants exactly as the migration does (prediction == result, 25-round fuzz) and blocks on FK off / leftover `_old`.
- `_old` tables and `_snapshot_0026` are TEMPORARY rows in the retention matrix, cleared per workspace by the purge, and `/health/ready` warns (200) while they exist.
- `MAINTENANCE_MODE`: the dead-letter consumer is never gated; the runbook freezes with `wrangler queues pause-delivery` first and states the 25-minute `retryAll` limit.
- Tests: `tests/migration-0026-matrix.test.ts` (52) and extended preflight/retention/purge/health tests.

Not done / UNVERIFIED: everything on a real D1 (see RELEASE_GATES); `wrangler queues pause-delivery` semantics for in-flight batches and message age; the wrangler executor of the finalize/recover scripts (tested only through an injected node:sqlite executor); finalize compares whole rows by INTERSECT rather than hashing.

Re-review fixes (same PR): the file used 6- and 7-term compound SELECTs that workerd's SQLite rejects ("too many terms"; node:sqlite allows 500), so
verification is one INSERT per row and finalize/preflight are many small statements, with a static ban (<= 4 terms across migrations, scripts and
runbook SQL) and `tests/migration-0026-d1.test.ts` running the real `wrangler d1 migrations apply --local` on a seeded legacy database plus finalize/recover via
`wrangler d1 execute --local`. `PRAGMA legacy_alter_table=OFF` first (sqlite3 shell default ON let empty copies be swapped in); the snapshot is always populated and recover
falls back to the live tables' DDL. finalize refuses an empty live table over a non-empty original, lists ids, and needs `--ack-changed` separately from `--ack-drift`;
`/health/ready` also warns on a leftover `_gate_0026_poison`. Still UNVERIFIED on a remote D1: see the RUNBOOK list and the mandatory throwaway-D1 rehearsal.

## Slice 1.15: platform gates (ADR 0027)

- `exactOptionalPropertyTypes` is on (27 errors fixed at the source, none silenced). Web project unchanged.
- Coverage floor in `vitest.config.ts` (statements 89, branches 84, functions 85, lines 91; measured 89.99 / 84.11 / 85.38 / 91.58);
  CI runs `npm run test:coverage`.
- `integration` CI job (`npm run test:integration`): the real `wrangler d1 migrations apply --local` from zero plus the 0026 scripts.
- Migration seal: one `migrations/NNNN_name.sql.sha256` sidecar per migration (`npm run migrations:seal` / `migrations:check`), disjoint
  files so parallel migration PRs cannot conflict; duplicate numbers, unlisted gaps (only 0023), and on PRs any change versus the base
  branch fail; an unresolvable base ref is exit 2. Tested as a real process in a temp git repo. `.github/CODEOWNERS` added.
- Branch coverage floor 83.5 (0.11 margin was too thin); the floor is CI-only (`npm run check` does not run coverage).
- **Verified:** unit tests, the full suite, the integration test locally. **Not verified:** the new CI jobs have not run on the CI host; branch protection (required checks, code-owner review) is NOT enabled and is an open operator action; no
  deliberately red PR per gate; required-check settings; any rollback on a real D1.

## Slices 1.17, 1.23, 1.32 (read side), 2.4: ingress contract, refused-tenant audit, audit read side (ADR 0030)

- **Ingress (F50, F59, F76):** an exact duplicate is `200 {accepted, persisted: 0, duplicate: true}` on every source (GitHub said 202 with no flag);
  GitHub answers `415` for a body that is not `application/json` before reading it; a paused, revoked or disabled generic/GitLab/Stripe
  endpoint is `410 Gone` (unknown and malformed stay one 404 with the decoy HMAC; the earlier "disabled looks unknown" property is
  deliberately given up for this case, reasoning in the ADR); every non-2xx webhook body carries our `correlation_id` (one middleware around
  `/webhooks/*`, `src/platform/ingress-errors.ts`). F50 is now ✅ in the ledger; F59's note changed; F76 keeps hashed keys and two live keys (2.11).
- **Accounting (F29):** `ingress_usage` (migration 0030) counts accepted, duplicate and rate-limited events per workspace, UTC day and source,
  apart from the abuse counters, best effort after durable acceptance (it can under-count, it is not a billing meter). Retention 400 days, in
  the retention matrix and the purge. The full-route GitHub 429 is a test.
- **Audit of refused tenants (F233):** `github.webhook.refused` for a signed event to an unknown or suspended installation (hourly per
  installation, 30 a minute platform-wide, no workspace for an unknown one). Decision recorded: not every probe is audited; past 20 a minute per
  person one `probe_audit_capped` marker and a log line make the loss visible; object-level misses are not audited by construction.
- **Audit read side (F222, F28):** `audit_events.correlation_id` stamped from the request; filters for actor (current members or system only),
  target and request id; a total capped at 10,000; a before/after diff for `enabled`, `repo` and subscribed updates (never a secret field);
  reads fail closed (503, no events, tenant check on every row). Dashboard: Who, About (id) and Request ID filters, match count, one-click
  related-event links, "What changed" block, request id, CSV columns; English and Vietnamese; axe on the new states.
- **Migration:** `0030_ingress_usage_audit_read.sql` plus its seal. 0028 and 0029 belong to other slices, so the seal check's contiguity rule
  fails until they merge (it passed locally only with throwaway stub files for 0028 and 0029, which are NOT in this change).
- Tests changed on purpose (202 to 200, 404 to 410, text to JSON bodies, 415 where a GitHub request had no content type): listed in the ADR.
- **Verified (locally, with stub 0028/0029 present):** `npm run format && npm run check` (168 files, 4290 tests, typecheck, web typecheck,
  lint, build, worker bundle), `npm run test:coverage` (floor held), `npm run test:integration` (the real `wrangler d1 migrations apply
  --local` chain including 0030, 36 tests), `npm run docs:spec-status`, `npm run docs:retention`.
- **Not verified:** any real GitHub, GitLab or Stripe reaction to 200, 410 or 415; 0030 on a real D1; the CI jobs on the CI host; a screen reader,
  a 320 px device and the Vietnamese copy by a person; the dashboard against a real server (only the mocked API in the component tests);
  `ingress_usage` is not reconciled with `deliveries` and is not shown in the dashboard.
