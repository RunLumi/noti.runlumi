# What is not done

> Evidence-based work queue derived from the per-feature `Status` lines (see
> [`STATUS.md`](STATUS.md) for the generated ledger and counts). Written 2026-10-14 at spec
> reconciliation (PROGRESS.md, "Spec reconciliation"). Nothing here is a promise or an
> estimate of calendar time; sizes are relative: **S** under a day, **M** one to three days,
> **L** more than three days. Priorities are the spec's (P0 blocks a safe release, P1 is needed
> for an unassisted nontechnical V1, P2 is post-V1).
>
> This file is hand-maintained. `tests/spec-status.test.ts` checks that every feature that is
> neither done nor decided against appears somewhere below, so a status change in a spec forces a
> decision here.

## How to use this list

Slices are ordered by dependency first, value second. Within a group, take the top item that is
not blocked. A feature may appear in more than one slice when it has separable halves.

Standing caveat that applies to every group: **no real-provider evidence exists for anything.**
No GitHub App is registered, no real Slack, Teams, Lark or Discord workspace has received a
message, and no staging Cloudflare environment exists. Group 3 lists those blockers explicitly.
Until it is cleared the release rule in `AGENTS.md` cannot be satisfied no matter how much of
groups 1 and 2 is built.

## 1. P0 blockers for a safe public release

Buildable now, without external access.

| # | Slice | Features | Why it is open | Size |
| --- | --- | --- | --- | --- |
| 1.1 | Close the tenant contract in the schema: backfill and final `NOT NULL` plus foreign keys for `organization_id`, then a static test that every query on a tenant table has an organization predicate | F25, F26, F233 (the drill itself is in group 3) | Expand-only today: only new writes are enforced by triggers; no static every-query check | M |
| 1.2 | Credential lifecycle, remainder (the fingerprint at seal time, `revoked`, the shredding proof, audited KEK destruction, environment KEK mismatch refusal and the scan-all-columns test shipped in ADR 0022): revoke order drain then destroy, `destination_revoked` as a consumer outcome, per-connection `key_destroyed` audit, dashboard revoke control and fingerprint display, fingerprint in exports and dead-letter views, Secrets Store (tier 1) for the KEK | F39, F40, F37, F34 | Revoke stops all use but leaves the sealed secret until it is replaced or the connection is deleted; the consumer reports a revoked row as a missing integration; the dashboard cannot revoke or show the fingerprint; the KEK is still a Worker secret; nothing has been rehearsed in staging | S to M |
| 1.3 | Boot and health hygiene, remainder (`assertConfig` at fetch, queue and scheduled, `/health/ready` with D1 and queue probes and the D1-down tests shipped in ADR 0022): assert `APP_ORIGIN`, `BETTER_AUTH_SECRET` and the GitHub bindings at boot, log unknown extra keys, per-dependency codes and an authenticated operator view of readiness | F04, F10 | Those bindings are not asserted at boot (every test environment would need them); `/health` still names misconfigured bindings to anyone | S |
| 1.4 | D1 write discipline, remainder (`withD1Retry` with full jitter, the classification and the bound-parameter static test shipped in ADR 0022, applied to the ingress batch): wrap the outbox claim and dispatch writes, a `no_query_exceeds_100_bound_parameters` test, and decide whether overload should be retried once there is evidence | F09 | Only the ingress batch is retried; overload and timeout are surfaced on purpose (Cloudflare says not to retry them), so a sustained overload still answers 5xx and relies on the provider's retry | S |
| 1.5 | Dedup storage, remainder. Built (ADR 0023): `event_dedup` with a 7-day TTL, hit count, bounded purge job; repeats written as `suppressed` rows with a reason; possible-duplicate flag in the detail dialog. Left: a per-connection TTL and showing it, `semantic_dedup`, writing `claim_conflict` and `provider_idempotency` suppressions, the per-destination client-side window | F171, F185, F186 (client-side window, needs F188 for Lark), F170 follow-up | Ingress duplicates are recorded and counted; the window is a constant, and there is no per-destination suppression after a send | S to M |
| 1.6 | Delivery ledger depth, remainder. Built (ADR 0023): `delivery_attempts` (one row per attempt and per deferral, same batch as the ledger transition), per-attempt history in the detail dialog, retention, export and purge coverage. Left: `provider_message_id` is never populated (no adapter response carries one; needs real-provider evidence), a correlation id on attempts (slice 1.10), a rendered-payload preview, the grouped 'N failures' view | F184, F181, F99 | The attempt history exists; the provider's own message id, the correlation id and a redacted payload preview do not | M |
| 1.7 | Replay at scale and breakers, remainder. Built (ADR 0023): bulk and scoped replay with a dry-run count, plan token, 200 bound, typed confirmation and one audit row; a per-integration circuit breaker shown on the integration and on each delivery. Left: replay after outbox purge, a dedicated redeliver queue, an alert when a breaker opens, the Discord global breaker (1.16), the remaining F204 capabilities | F182, F183, F204 (remaining capabilities) | Replay needs the stored outbox message; nobody is paged when a breaker opens | S to M |
| 1.8 | Outbound rate limiting, remainder. Built (ADR 0023): per-integration pacing from `x-ratelimit-remaining: 0`, `-reset-after`, `-reset` and a 429's `Retry-After`. Left: a budget per provider account (the consumer cannot tell which account a stored webhook belongs to; needs a provider-account identity per destination), Slack API codes and the per-method cooldown, Telegram and Lark per-mode limits | F187, F178, F179 | One integration cannot run itself into its own rate limit, but two integrations on the same provider account still share a budget nobody tracks | M to L |
| 1.9 | Job runner: `job_runs`, leases, cadence table, `job_stale` signal, DLQ-consumer health check; then the missing jobs (dedup purge, GitHub poll, reconciliation) | F192, F174, F190, F180 | Seven cron jobs are specified, two exist, nothing records whether any ran | L |
| 1.10 | Correlation everywhere: id on D1 rows, queue messages, consumer logs and the delivery detail view, lookup by id | F193, F11 (rest of it); prerequisite for F202 | The id exists only inside the request that minted it | M |
| 1.11 | Alerting: `alert_state`, a page destination, the other thirteen alerts, a runbook entry per alert with an alert-to-runbook test | F200, F201 | Stall detection logs a line; nobody is paged | L |
| 1.12 | Canonical envelope and versioning (the spine): CloudEvents-shaped envelope, outcome enum, size budget with `truncated`, schema registry, normalisation version | F41, F42, F43, F44, F45, F46, F52, F54, F62 | **Partly done in slice 4b (ADR 0020):** a validated `CanonicalEvent`, one event-type registry, the 64 KiB budget and adapter versions exist for all four sources. Still open: ULID `id` and `orgid`/`connectionid`, the outcome enum with `rawOutcome` and `closesEventId`, published JSON Schemas and `schema_unknown`, the stored `adapter_version`, `unmapped:<raw>` capture. Needs a V1 scope decision: the spec marks these P0, the shipped product works without them | L (F41 to F44 together), M each for F46, F52, F54 |
| 1.13 | Routing rule engine, if rules are in V1: rule object, versions, `all`/`any` groups, general operators, priority and conflict resolution, rule-level event and outcome conditions, `rule_id` in provenance | F121, F122, F123, F124, F125, F127, F131, F132, F136, F137, F140 | Slice 7 shipped five closed per-integration filters instead (ADR 0010). This is a scope decision before it is a task | L |
| 1.14 | Repository and capability filters the rule engine assumes | F126 | An integration is bound to one repository | S |
| 1.15 | Platform gates: coverage floor and a separate integration job in CI, `exactOptionalPropertyTypes`, `wrangler d1 migrations apply --local` from zero, migration immutability check, rollback procedure per migration | F01, F02, F05 | CI is green but proves less than the spec asks | S to M |
| 1.16 | Discord global breaker before Discord is enabled for customers (the spec calls it the highest-consequence bug), and generic customer webhook SSRF criteria before `GENERIC_WEBHOOK_ENABLED` is turned on: workspace host allowlist, periodic re-resolution, recorded addresses | F108, F115 | Both are off or unadvertised; they become blockers the day they are switched on | M each |
| 1.17 | Ingress contract details: duplicate answers 200, 415 on wrong content type, 410 for disabled endpoints, `correlation_id` in error bodies, missing `X-GitHub-Event` | F50, F59, F76 | Small deviations from the contract. **Done in slice 4b:** missing `X-GitHub-Event` is 400 and F59 is pinned by tests. Still open: duplicate answers 200, 415 on the GitHub route, 410, `correlation_id` in error bodies | S |

### Security and compliance P0s (spec 15)

| # | Slice | Features | Gap | Size |
| --- | --- | --- | --- | --- |
| 1.19 | Egress proofs: static test that one module performs outbound fetch, typed provider-domain registry with `verifiedOn` and a 180-day staleness test, unmapped-response metric | F228, F229, F230 | Mechanism exists (`src/connectors/destinations/`), the proofs do not | S |
| 1.20 | Authorisation pointer and static route-to-capability check | F232 | Not written | S |
| 1.21 | Abuse controls: outbound provider bucket (with 1.8), quota ledger, abuse alerts, coarse pre-filter | F231 | Ingress limiter is wired; nothing else | L |
| 1.22 | Retention matrix and enforcement: matrix doc, per-workspace setting, per-job staleness alert, resolve ledger retention against the spec (ledger purged at 90 days) | F237 | Purge job is tested; the matrix and setting are not | M |
| 1.23 | Static query-scope test (with 1.1), audit of unknown-installation 403s; staging drill and Time Travel re-drill are group 3 | F233 | See 1.1 | M |
| 1.24 | Threat-model hygiene: control-ID CI check; session revoke-others and restore-revokes-sessions; verify token storage in the installed Better Auth version | F227, F234 | AR-1 is accepted with mitigations only partly built | M |
| 1.25 | Security release gate: all four gates green (real-provider run, isolation drill, KEK and rollback rehearsal) | F240 | No gate is green; see group 3 | L |

### Dashboard and UX P0s (spec 14)

| # | Slice | Features | Gap | Size |
| --- | --- | --- | --- | --- |
| 1.26 | Server-driven setup model and resumable wizard: seven-step model, `/setup` route space, resume | F207, F216 | Four derived steps and an optional seventh wizard step exist (ADR 0018); no resume | L |
| 1.27 | Shell and navigation: route guard as a list, shell 404, breadcrumbs, `returnTo`, admin nav trimmed | F205 | Switcher and Audit nav only | M |
| 1.28 | GitHub setup UI: login display, wrong-account switch, admin fallback; all-vs-selected, search, new-repo diff, private warning | F208, F209 | Connect button and picker only (real-App validation is group 3) | M |
| 1.29 | Destination setup: Slack OAuth and Teams auth capture (validation needs real tenants), add-another, capability-disabled options; setup-instruction capture pipeline | F211, F212 | Paste-URL flows only; no verified screenshots | M |
| 1.30 | Settings and replay: nine-section settings order, health and history, repair panel; bulk replay and DLQ page | F217, F218, F213, F215 | Settings page, blocker, rotate and delete exist | M |
| 1.31 | Error, state and accessibility gates: four-part errors with banned-phrase test, shared Skeleton and EmptyState, screen-reader pass, browser and device matrix, 320px in CI | F220, F225, F221, F223 | Evidence is jsdom axe and a one-off manual 320px run | M |
| 1.32 | Audit read side: actor, target and correlation filters, total, field diff, fail-closed | F222 | Admin `/audit` exists, minimal | M |
| 1.33 | Usability gate | F226 | Blocked on participants, a real Slack and GitHub path and finished setup screens (group 3) | L |

## 2. P1 required for an unassisted nontechnical V1

Order: identity and recovery first (a user who cannot sign in cannot be helped), then the setup
path, then noise control, then the rest.

| # | Slice | Features | Gap | Size |
| --- | --- | --- | --- | --- |
| 2.1 | Auth behaviour tests and policy: password and email policy tests and canonicalisation, resend limits, reset revocation and generic responses, invite acceptance and role validation tests, passkey tests and sign-counter handling, rate-limit rule tests | F16, F17, F18, F19, F21, F22 | Better Auth is configured but none of these rules has a test; behaviour is believed, not shown | M |
| 2.2 | Sessions: session and device list with revoke, absolute timeout decision | F20 | Sessions work; no UI to see or end them | M |
| 2.3 | Audit coverage: member, invite, role and session events, correlation id; unknown-installation 403 audit | F28, F27 (follow-up), F236 | Audit covers integrations and denials only | M |
| 2.4 | Ingress quota accounting and GitHub 429 route test | F29 | Limiter is wired; quota accounting and the full-route 429 test are not built | S |
| 2.5 | ADR 0003 update: record multi-org and the Email Sending constraint | F32 | Decision not recorded | S |
| 2.6 | Destination capability surface: registry for destination kinds, capabilities per configured destination and in the UI, save-time feature validation, rung stored on the delivery, `truncated_fields` and elision recorded, then `docs/CAPABILITIES.md` generated | F105, F92, F93, F94, F95, F119, F120 | Kinds are a hand-edited union and `switch`; capabilities are per kind, not per destination | M to L |
| 2.7 | Destination hygiene: PATCH without new credentials re-runs URL policy; decrypt-failure alert; test-send preview, status and latency, `providerMessageId` capture; destination status model with probes and degraded state | F96, F97, F98, F99, F106, F118 | See notes in each status line | M to L |
| 2.8 | Slack OAuth install (`incoming-webhook`) and Web API mode; Lark per-mode limiters and offsets; Teams orphan-flow warning | F103, F102, F104 | Webhook modes only | L |
| 2.9 | Fix the shape of the source contract: put GitHub behind `SourceConnector` (a descriptor and a shared conformance suite for all four sources exist since slice 4b; the single typed interface does not), then event-model F47 to F51 details (mapping table, `data.extra`, unmapped metric, retention split, size budget) | F71, F47, F48, F49 (P2 half), F51, F63, F64 | GitHub bypasses the contract that GitLab and Stripe use | M to L |
| 2.10 | Complete the GitHub catalogue: `check_run`, `check_suite`, `review_thread`, repository events, ghost sender rendering, ack-budget tests, user-initiated disconnect | F61, F60, F64, F70 | 18-type catalogue enforced; the listed types are missing | M |
| 2.11 | Source hardening: admission-axes test and review stamps, per-connection timestamp tolerance and clock-skew alert, dual secrets with rotation overlap and wizard, hashed ingress keys, source health model with 72 h silence prompt, stepwise source wizard with send-test | F73, F75, F76, F77, F38, F78, F80, F81, F82 | Generic, GitLab and Stripe sources work but lack rotation overlap, health and wizard | L |
| 2.12 | Stripe thin events and enrichment budget | F85 | Livemode routing only | L |
| 2.13 | Noise control follow-ups (ADR 0016): configurable `group_by`, max wait, weekly digest, Slack and Discord rendering tests, per-workspace quiet hours, category grouping and in-app link in digests, per-notification "why", severity model | F141, F142, F143, F144, F145, F146, F149, F159 | Each is a small named gap | S each |
| 2.14 | Preferences and unsubscribe: three-level preference model, admin critical lock, one-click unsubscribe, self-generated suppression, per-destination ceiling, noise report, group metrics store, non-GitHub resolved notices, regex-rejection test and ROADMAP non-goal entry | F147, F148, F150, F151, F152, F153, F164, F166, F167, F165 | Not started except F148 and F152 in part | M to L |
| 2.15 | Preset library and rule-based filters: label picker, path and PR/issue number filters, bot "don't know" choice, impact preview, versioning and rollback, per-rule formats, default rules, presets | F128, F129, F130, F133, F134, F138, F139, F154, F155 | Depends on 1.13 for most; the picker, bot choice and number/path filters can go first | L |
| 2.16 | Observability P1s: closed log message catalogue and byte budget, console lint and one-to-one redaction site test, acceptance, routing and duplicate rates with a publication gate and an SLI view, refusal table and banned-string test | F194, F195, F197, F198, F203 | Logs and SLIs exist; closed catalogue, enforcement and UI do not | M to L |
| 2.17 | Delivery P1s: ack-ordering and rollback tests plus a waitUntil lint rule, Slack API code mapping, retry policy stored per connection | F169, F177, F179, F180 | See status lines | S to M |
| 2.18 | ADR process: ADRs for no Durable Objects, envelope choice, Secrets Store scope, at-least-once contract and single-D1 decision; CI check of ADR headings | F14, F06 (ADR for deferral) | Five decisions are unrecorded | S |

### Dashboard P1s (spec 14)

| # | Slice | Features | Gap | Size |
| --- | --- | --- | --- | --- |
| 2.20 | Preset step, event log and trace, preferences screen | F210, F214, F219 | Not started; F210 and F219 depend on the preset library and preferences (2.14, 2.15) | L |
| 2.21 | Design-system drift tests, no-fake-number test, Skeleton and EmptyState components; locale in URL and native-speaker review | F206, F224 | Tokens, logo and glass tests exist; the drift tests do not | M |

### Security P1s (spec 15)

| # | Slice | Features | Gap | Size |
| --- | --- | --- | --- | --- |
| 2.22 | Audit immutability: append-only test, audit of audit reads, heartbeat, redaction check | F236 | Tenant-scoped admin reads only | M |
| 2.23 | Data-subject requests: per-user access and erasure, tests (legal wording is group 3) | F238 | Workspace export and deletion exist | M |
| 2.24 | Supply chain: `npm audit signatures`, install-script review, OIDC deploy | F239 | Audit gate, pinned actions, Dependabot exist | S |
| 2.25 | Incident response: S1 to S4 runbooks, postmortem template, evidence-preservation rule; `security.txt` once the domain is settled | F242 | `SECURITY.md` and availability runbook only | M |
| 2.26 | Email platform limits doc and failure handling | F235 | Not recorded; P1 in the spec but only matters once mail volume exists | M |

## 3. Blocked on external access

Each of these needs something only the owner can provide. Nothing below can be closed by writing
more code alone; the code half is listed in groups 1 and 2.

| Needs | Blocks | Features | What to do once available |
| --- | --- | --- | --- |
| **Real GitHub App** (registered, private key, webhook secret, slug, client id and secret) | Real-provider end-to-end for the first source; installation tokens; delivery-failure polling and reconciliation; real fixtures | F55, F65, F66, F69, F72, F56 and F68 (real-App runs), F79 (GitHub half) | Register per `docs/GITHUB_APP.md`; set the `REPLACE_WITH_*` values; capture and sanitise real payloads; build JWT and installation-token cache (F66, buildable earlier with test keys), then poller and reconciliation |
| **Staging Cloudflare account** (D1 id, queues, secrets, Workers Paid for 14-day DLQ retention) | Environment separation; rollback rehearsal; KEK rotation rehearsal; tenant-isolation drill; real D1 and Queues behaviour; verifying `_headers` and the assets layer on a deployment; paging | F03, F05 (rehearsal), F07 (retention), F34 (Secrets Store tier), F37 (rehearsal), F200 (paging test), F201 (rehearsal), F233 (drill), F240 | Create `env.staging`, deploy, run the drills in `docs/RELEASE_GATES.md` |
| **Real Slack workspace** | Slack adapter validation; OAuth install | F103, F179, F180, F189 (provider half), F91 | Run create, test, deliver, inspect, retry; capture real response codes |
| **Real Microsoft Teams tenant** (Workflows webhook) | Teams adapter validation; orphan-flow behaviour; private-channel verification | F104, F100 (provider half) | Same run |
| **Real Lark tenant** (custom bot, later app bot) | Lark adapter validation; signed-card behaviour; app-bot mode and `uuid` idempotency | F101, F102, F188 | Same run |
| **Real Discord server** | Discord adapter validation; message-id capture, update-in-place | F107, F109 | Same run before Discord is enabled |
| **Real GitLab and Stripe accounts** | Real-payload validation for both providers | F79 (provider halves), F81, F84 | Capture payloads, replace doc-derived fixtures |
| **Real Linear workspace and OAuth app** | Linear connector | F87, F88 | Only if demand evidence exists |
| **Custom domain and DNS** (`noti.runlumi.app` is configured, ownership and email sending domain are not verified here) | Email deliverability for verification and reset mail; WebAuthn on the real origin; `security.txt` | F17, F18, F19, F242, F235 | Verify sending domain; test real mail and a real-device passkey |
| **Legal review** | Privacy policy and terms, data processing terms, retention commitments, DSAR process wording, subprocessors list, accepted-risk sign-off | F237, F238, F241, F254 | Counsel reviews the retention matrix and DSAR doc before public signup |
| **People** (ten target users for the usability study) | The Continue gate | F226, F262 | Run the study in `14` F226 |

Compliance items (retention matrix, DSAR) are being edited on another branch at the time of
writing; where that branch and this file disagree, the spec status wins and this section should be
regenerated by hand.

## 4. P2, deferred and decided against

| Slice | Features | Why not now | Size |
| --- | --- | --- | --- |
| AI (Part A of spec 16): nothing is authorised for V1; `AGENTS.md` makes AI optional and later | F243 to F252 (all 🚫) | Gated by G6 in F262; building it before delivery, billing and onboarding gates would route around the constraints the spec exists to enforce | L each, after G6 |
| Usage metering, billing, plans | F253, F254 | G4 and G7; needs payment provider and legal review | L |
| Enterprise: SSO and SCIM, custom RBAC, server-side audit export, data residency | F255, F256, F257, F258 | No enterprise customer; G1 to G3 first | L each |
| Public API and keys | F260 | Spec makes G1 a precondition | L |
| Connector marketplace | F259 | Forbidden in V1 (🚫) | none |
| Connector expansion gate record and the stop/continue decision ADR | F261, F262 | Needs real-provider evidence and the usability study | S for the ADR, after the evidence |
| More sources: Cloudflare Alerts, Linear, semantic dedup, GitLab self-managed, GitLab extra hooks | F90, F87, F86, F81 (self-managed), F83 | Demand-gated (F261) | M each |
| Sentry | F89 (🚫) | Refused: no safe push source without real evidence (ADR 0015) | none |
| More destinations: Telegram, email and the email source | F110, F111, F112, F113, F114 | Telegram decided against; email needs a provider account, verified recipients and unsubscribe (ADR 0014) | L |
| Destination polish: Discord threading and identity, update-in-place, entity correlation and thread strategy, generic webhook templates, rotation overlap, send-a-test, response excerpt and banner | F107, F109, F116, F117, F156, F157, F158 | P2 | M each |
| Noise differentiators: escalation, inhibition, mute and silence, per-repo overrides, feedback control, rule templates | F160, F161, F162, F163, F168, F135 | P2 | M each |
| Event-model P2s and observability P2s: ingress coalescing and backpressure, Analytics Engine, product analytics views, support bundle, cost-control ADR | F53, F191, F196, F199, F202 | P2; F196 is date-driven (a Cloudflare pricing change on 2026-12-01) | M to L |
| Sharding | F06 (🚫) | Deferred by design until `overloaded` rates justify it | L |
