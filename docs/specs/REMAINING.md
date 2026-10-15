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
| 1.1 | Tenant contract, what is left after migration 0026 and the static query test (ADR 0021): chunked backfill (the migration copies each table in one statement), rollback rehearsal of 0026 on a real D1 (apply, forced trip, recover, finalize, queue pause), repository functions that take the organization as a parameter, dropping `integrations.repo` as a routing key | F25, F26, F233 (the drill itself is in group 3) | Schema contract and static test are done; these four are not | S to M |
| 1.2 | Credential lifecycle, remainder (the fingerprint at seal time, `revoked`, the shredding proof, audited KEK destruction, environment KEK mismatch refusal and the scan-all-columns test shipped in ADR 0022): revoke order drain then destroy, `destination_revoked` as a consumer outcome, per-connection `key_destroyed` audit, dashboard revoke control and fingerprint display, fingerprint in exports and dead-letter views, Secrets Store (tier 1) for the KEK | F39, F40, F37, F34 | Revoke stops all use but leaves the sealed secret until it is replaced or the connection is deleted; the consumer reports a revoked row as a missing integration; the dashboard cannot revoke or show the fingerprint; the KEK is still a Worker secret; nothing has been rehearsed in staging | S to M |
| 1.3 | Boot and health hygiene, remainder (`assertConfig` at fetch, queue and scheduled, `/health/ready` with D1 and queue probes and the D1-down tests shipped in ADR 0022): assert `APP_ORIGIN`, `BETTER_AUTH_SECRET` and the GitHub bindings at boot, log unknown extra keys, per-dependency codes and an authenticated operator view of readiness | F04, F10 | Those bindings are not asserted at boot (every test environment would need them); `/health` still names misconfigured bindings to anyone | S |
| 1.4 | D1 write discipline, remainder (`withD1Retry` with full jitter, the classification and the bound-parameter static test shipped in ADR 0022, applied to the ingress batch): wrap the outbox claim and dispatch writes, a `no_query_exceeds_100_bound_parameters` test, and decide whether overload should be retried once there is evidence | F09 | Only the ingress batch is retried; overload and timeout are surfaced on purpose (Cloudflare says not to retry them), so a sustained overload still answers 5xx and relies on the provider's retry | S |
| 1.5 | Dedup storage, remainder. Built (ADR 0023): `event_dedup` with a 7-day TTL, hit count, bounded purge job; repeats written as `suppressed` rows with a reason; possible-duplicate flag in the detail dialog. Left: a per-connection TTL and showing it, `semantic_dedup`, writing `claim_conflict` and `provider_idempotency` suppressions, the per-destination client-side window | F171, F185, F186 (client-side window, needs F188 for Lark), F170 follow-up | Ingress duplicates are recorded and counted; the window is a constant, and there is no per-destination suppression after a send | S to M |
| 1.6 | Delivery ledger depth, remainder. Built (ADR 0023): `delivery_attempts` (one row per attempt and per deferral, same batch as the ledger transition), per-attempt history in the detail dialog, retention, export and purge coverage. Left: `provider_message_id` is never populated (no adapter response carries one; needs real-provider evidence), a correlation id on attempts (slice 1.10), a rendered-payload preview, the grouped 'N failures' view | F184, F181, F99 | The attempt history exists; the provider's own message id, the correlation id and a redacted payload preview do not | M |
| 1.7 | Replay at scale and breakers, remainder. Built (ADR 0023): bulk and scoped replay with a dry-run count, plan token, 200 bound, typed confirmation and one audit row; a per-integration circuit breaker shown on the integration and on each delivery. Left: replay after outbox purge, a dedicated redeliver queue, an alert when a breaker opens, the Discord global breaker (1.16), the remaining F204 capabilities | F182, F183, F204 (remaining capabilities) | Replay needs the stored outbox message; nobody is paged when a breaker opens | S to M |
| 1.8 | Outbound rate limiting, remainder. Built (ADR 0023): per-integration pacing from `x-ratelimit-remaining: 0`, `-reset-after`, `-reset` and a 429's `Retry-After`. Left: a budget per provider account (the consumer cannot tell which account a stored webhook belongs to; needs a provider-account identity per destination), Slack API codes and the per-method cooldown, Telegram and Lark per-mode limits | F187, F178, F179 | One integration cannot run itself into its own rate limit, but two integrations on the same provider account still share a budget nobody tracks | M to L |
| 1.9 | Job runner, remainder. Built (ADR 0024): `job_state` and a history `job_runs`, a typed cadence table, `job_stale` from D1 in the summary and as an alert, a DLQ consumer run record and a ledger-side proxy alert (`dlq_consumer_no_progress`). Left: leases, resumable cursors, `cpu_ms`, `partial`, `job_failing`; the missing jobs (GitHub delivery-failure poll, reconciliation); real DLQ depth (needs the Queues API) | F192, F174, F190, F180 | Every job now records whether it ran; overlapping runs are not fenced and no job is resumable | M |
| 1.10 | Correlation, remainder. Built (ADR 0024): id on `deliveries`, outbox and attempts, in the queue message, in consumer and DLQ-consumer logs, in the delivery view, `GET /api/deliveries?correlationId=`. Left: ids on held events (a released notification gets a fresh id), (`correlation_id` is in webhook error bodies since ADR 0028) Analytics Engine blobs, the support bundle (F202), a row in the dashboard detail dialog | F193, F11 (rest of it); prerequisite for F202 | A delivery can be found from the id its request returned; nothing shows it in the dashboard yet | S |
| 1.11 | Alerting, remainder. Built (ADR 0024): `alert_state`, an engine with fire, dedupe, re-notify and resolve, ten alerts from D1 and boot-report signals, a runbook entry per alert with an alert-to-runbook test, sinks for the log and an optional chat webhook. Left: a page-a-human integration (PagerDuty and the like), alerts that need Queues API or Analytics Engine data (`dlq_growth`, `d1_overloaded`, `ingress_gap`), threshold tuning against real traffic, an external dead-man's-switch for a cron that has stopped entirely | F200, F201 | Alerts reach a log and a channel; nobody is paged with acknowledgement | M |
| 1.12 | Canonical envelope and versioning (the spine): CloudEvents-shaped envelope, outcome enum, size budget with `truncated`, schema registry, normalisation version | F41, F42, F43, F44, F45, F46, F52, F54, F62 | **Partly done in slice 4b (ADR 0020):** a validated `CanonicalEvent`, one event-type registry, the 64 KiB budget and adapter versions exist for all four sources. Still open: ULID `id` and `orgid`/`connectionid`, the outcome enum with `rawOutcome` and `closesEventId`, published JSON Schemas and `schema_unknown`, the stored `adapter_version`, `unmapped:<raw>` capture. Needs a V1 scope decision: the spec marks these P0, the shipped product works without them | L (F41 to F44 together), M each for F46, F52, F54 |
| 1.13 | Routing rule engine, if rules are in V1: rule object, versions, `all`/`any` groups, general operators, priority and conflict resolution, rule-level event and outcome conditions, `rule_id` in provenance | F121, F122, F123, F124, F125, F127, F131, F132, F136, F137, F140 | Slice 7 shipped five closed per-integration filters instead (ADR 0010). This is a scope decision before it is a task | L |
| 1.14 | Repository and capability filters the rule engine assumes | F126 | An integration is bound to one repository | S |
| 1.15 | Platform gates, remainder. Built (ADR 0027): `exactOptionalPropertyTypes`, a coverage floor, a separate `integration` CI job running the real `wrangler d1 migrations apply --local` from zero, a per-migration SHA-256 sidecar seal checked against the base branch (content, numbering, duplicates), CODEOWNERS for the gate files. Left: the operator actions in RELEASE_GATES 1b (required checks and code-owner review are repository settings and are OPEN), `--require-base` in CI once main carries the sidecars, a rollback rehearsal per migration (needs a real D1), `defer_foreign_keys` review, a deliberately red PR per gate, confirming merge-blocking in repository settings | F01, F02, F05 | The gates exist and are asserted; none has been shown to block a real merge | S |
| 1.16 | Discord global breaker and generic customer webhook SSRF criteria. **Built (ADR 0029):** a platform-wide Discord guard (invalid-answer trip at 1,000 per ten minutes, per-minute pacing, `egress_breaker_open` alert, tenant-free counters) and, for the custom webhook, a workspace host allowlist enforced at save and send, recorded addresses, re-resolution before send and by cron, refusal of a host that turns private. **Left, all blockers for turning `GENERIC_WEBHOOK_ENABLED` on:** a management API, audit and screen for the allowlist; pinning the connected address (rebinding is narrowed, not closed; needs an egress proxy); a run against a real resolver and a real endpoint; for Discord, observation against the real service and tuning of the trip point | F108, F115 | The flag stays OFF and Discord is not advertised; neither may be switched on until the left items are done | M (remaining) |

### Security and compliance P0s (spec 15)

| # | Slice | Features | Gap | Size |
| --- | --- | --- | --- | --- |
| 1.19 | Egress proofs, remainder. Built (ADR 0026): AST regression guard on the outbound surface (aliasing not followed), typed registry with `docsUrl`, `verifiedOn`, a weekly 180-day staleness check and a written wildcard reason, `unmapped_provider_response` log event. Left: the credential-host binding test, reconnect prompt when a host is removed, a human re-read of the provider pages (the date is the reference's, 2026-10-13), persisting the unmapped flag in the ledger | F228 (remainder), F229 (remainder), F98 | Proofs exist; the reconnect surface and a re-verification do not | S |
| 1.21 | Abuse controls: outbound provider bucket (with 1.8), quota ledger, abuse alerts, coarse pre-filter | F231 | Ingress limiter is wired; nothing else | L |
| 1.22 | Retention matrix and enforcement: matrix doc, per-workspace setting, per-job staleness alert, resolve ledger retention against the spec (ledger purged at 90 days) | F237 | Purge job is tested; the matrix and setting are not | M |
| 1.23 | The staging tenant-isolation drill (`scripts/tenant-isolation-drill.mjs`, unrun) and the Time Travel re-drill are group 3. **Done (ADR 0028):** unknown-installation and suspended-installation 403s are audited (bounded), and the decision that not every cross-tenant probe is recorded is explicit and visible | F233 | Static query test and the fake-D1 drill are done; the staging drill needs an environment | S |
| 1.24 | Threat-model hygiene, remainder. Built: control-ID check (`scripts/check-docs.mjs`: AR ids unique and defined, F ids exist in `docs/specs/`); and (ADR 0030) session revoke-others, revoke-all after a restore (`scripts/revoke-all-sessions.mjs`), token storage verified on the installed Better Auth (1.7.7). Left for F234: run the script against a real D1, a no-token-in-any-log test | F227, F234 | The restore script has never run on a real D1 | S |
| 1.25 | Security release gate: all four gates green (real-provider run, isolation drill, KEK and rollback rehearsal) | F240 | No gate is green; see group 3 | L |

### Dashboard and UX P0s (spec 14)

| # | Slice | Features | Gap | Size |
| --- | --- | --- | --- | --- |
| 1.26 | Server-driven setup model and resumable wizard: seven-step model, `/setup` route space, resume | F207, F216 | Done in slice 6f (ADR 0025): seven-step server model, `/setup/:step` route space, resume. Not done: `setup_progress` table and `skip_test` recorded choice; a second machine for additional integrations | L |
| 1.27 | Shell and navigation: route guard as a list, shell 404, breadcrumbs, `returnTo`, admin nav trimmed | F205 | Done in slice 6f (ADR 0025): declarative route guard, shell 404, breadcrumbs, safe `returnTo`. Not done: a Destinations health nav item; delivery detail and source detail are not routes | M |
| 1.28 | GitHub setup UI: login display, wrong-account switch, admin fallback; all-vs-selected, search, new-repo diff, private warning | F208, F209 | Partly done in slice 6f: connected login and type, wrong-account flow, search, all-vs-selected, not-listed link. Not done: new-repository diff, private-repository warning, admin fallback (needs a real App) | M |
| 1.29 | Destination setup: Slack OAuth and Teams auth capture (validation needs real tenants), add-another, capability-disabled options; setup-instruction capture pipeline | F211, F212 | Partly done in slice 6f: per-destination instructions with a capability summary, add another destination. Not done: Slack OAuth, Teams auth capture, verified screenshots | M |
| 1.30 | Settings and replay: nine-section settings order, health and history, repair panel; bulk replay and DLQ page | F217, F218, F213, F215 | Partly done in slice 6f: nine-section order, health and history, repair panel, DLQ reachable from the integration and the nav. Not done: pause consequence counts, delete impact counts, disconnect-source | M |
| 1.31 | Error, state and accessibility gates: four-part errors with banned-phrase test, shared Skeleton and EmptyState, screen-reader pass, browser and device matrix, 320px in CI | F220, F225, F221, F223 | Partly done in slice 6f: shared Skeleton, EmptyState and four-part ErrorPanel, banned-phrase test, static 320px reflow test, axe scenarios. Not done: screen-reader pass, browser and device matrix, real 320px in CI | M |
| 1.32 | Audit read side, remainder. **Done (ADR 0028):** actor, target and request-id filters, total, field diff for non-secret fields, fail-closed reads, links between related events. Left: non-admin actors, installation actor rendering, export-before-delete, audit-failure-fails-action | F222 | Admin `/audit` filters, pages, diffs and fails closed | M |
| 1.33 | Usability gate | F226 | Blocked on participants, a real Slack and GitHub path and finished setup screens (group 3) | L |

## 2. P1 required for an unassisted nontechnical V1

Order: identity and recovery first (a user who cannot sign in cannot be helped), then the setup
path, then noise control, then the rest.

| # | Slice | Features | Gap | Size |
| --- | --- | --- | --- | --- |
| 2.1 | Auth policy, remainder. Built (ADR 0030): the policy, canonicalisation, resend, reset, invitation, passkey and rate-limit rules are shown through the real handler; explicit reset, verification and invitation lifetimes; a passkey sign-in no longer creates a session for an unverified email. Left: email-volume monitoring, a provider migration plan and a real Cloudflare Email Sending run (F17); a notice email after a reset (F18); a prompt to re-register after a passkey counter regression, passkey-only recovery and a real-device WebAuthn run (F19); a test that the web client never logs the address (F16); a check that the accept UI never creates a second workspace (F21) | F16, F17, F18, F19, F21 | Behaviour is now shown against a recorder and a software authenticator, not against real mail or a real device | S to M |
| 2.3 | Audit coverage, remainder. Built (ADR 0030): member, invitation, role and session events. Left: making the Better Auth rows atomic with their change (they are written by an `after` hook), and a pending-invitations list with cancel on the Team page | F28, F27 (follow-up), F236 | Audit covers integrations, denials, membership and sessions; the rest of F236 is unchanged | S |
| 2.4 | Ingress accounting follow-ups: keying per connection (F27), billing-grade metering | F29 | Usage accounting (best effort, apart from the abuse counters) and the full-route GitHub 429 test are built (ADR 0028) | S |
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
| 2.18 | ADR process, remainder: a CI check of external-claim URLs in ADRs (the five decision ADRs 0031 to 0035 and the ADR heading and numbering check are built) | F14 | The URL check does not exist | S |

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
| 2.24 | Supply chain, remainder: OIDC deploy (unverified whether Workers supports it; `docs/SUPPLY_CHAIN.md`). Built: `npm audit signatures` and `--ignore-scripts` in CI, install-script review | F239 | Needs a Cloudflare docs read and a staging try, and a decision on any CI deploy credential | S |
| 2.25 | Incident response, remainder: rehearsal, a monitored contact, response targets, an automatic evidence hold, a sign-up kill switch; `security.txt` stays as generated (contact is the GitHub advisory form). Built: S1 to S4 playbooks, postmortem template, evidence-preservation rule | F242 | Never rehearsed; no owner watches the contact | M |
| 2.26 | Email failure handling: quota counter and alert, suppression list, bounce handling, DKIM/SPF record names (limits doc `docs/EMAIL_LIMITS.md` is written) | F235 | Handling not built; matters once mail volume exists | M |

## 3. Blocked on external access

Each of these needs something only the owner can provide. Nothing below can be closed by writing
more code alone; the code half is listed in groups 1 and 2.

| Needs | Blocks | Features | What to do once available |
| --- | --- | --- | --- |
| **Real GitHub App** (registered, private key, webhook secret, slug, client id and secret) | Real-provider end-to-end for the first source; installation tokens; delivery-failure polling and reconciliation; real fixtures | F55, F65, F66, F69, F72, F56 and F68 (real-App runs), F79 (GitHub half) | Register per `docs/GITHUB_APP.md`; set the `REPLACE_WITH_*` values; capture and sanitise real payloads; build JWT and installation-token cache (F66, buildable earlier with test keys), then poller and reconciliation |
| **Staging Cloudflare account** (D1 id, queues, secrets, Workers Paid for 14-day DLQ retention) | Environment separation; rollback rehearsal; **migration 0026 rehearsal on a real D1 (blocking)**; KEK rotation rehearsal; tenant-isolation drill; real D1 and Queues behaviour; verifying `_headers` and the assets layer on a deployment; paging | F03, F05 (rehearsal), F07 (retention), F34 (Secrets Store tier), F37 (rehearsal), F200 (paging test), F201 (rehearsal), F233 (drill), F240 | Create `env.staging`, deploy, run the drills in `docs/RELEASE_GATES.md`; **before any production apply, rehearse migration 0026 (preflight, freeze, bookmark, apply, verify, forced failure, restore): blocking** (the tenant drill is `scripts/tenant-isolation-drill.mjs`, unrun) |
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
