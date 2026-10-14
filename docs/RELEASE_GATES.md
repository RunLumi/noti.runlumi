# Release gates

Living checklist. Last reconciled with [`PROGRESS.md`](PROGRESS.md) on 2026-10-14, after
slice S3 (compliance documentation). It supersedes the earlier "gates for PR #1" list; every item from that list is still
here with its current status.

Current state: **engineering alpha**. Do not describe anything as production-ready, secure or
audited until every gate in section 1 is **done** for the release in question (spec 15 F240,
`AGENTS.md` release rule). No formal security audit has been performed.

Status: **done** (shipped and covered by tests), **partly** (gap named), **not done**.
A missing evidence link means the gate is not done. A red gate blocks the merge; an exception
needs a named owner, a written rationale and an entry in the register in
[`THREAT_MODEL.md`](THREAT_MODEL.md) (section 7).

## 1. Mandatory gates (F240)

| Gate | Evidence required | Status | State today |
| --- | --- | --- | --- |
| Real-provider end-to-end | A staging run through the actual GitHub App and a real Lark, Slack and Teams destination: create, test, deliver, inspect, retry, with run links | not done | Never run. The local GitHub App settings were placeholders (PROGRESS, slice 6a) |
| Tenant isolation | The F233 drill (org A attempts to read, update and delete org B's integration, destination, delivery, dead letter and audit rows by id) plus static query checks, and a Time Travel restore re-drill | partly | Done: tenant resolution only from the verified installation; `organization_id` NOT NULL with a foreign key on every tenant table (migration 0026, ADR 0021); a static test that every query on a tenant table has an organization predicate, with a reviewed allowlist (`tests/security/tenant-query-scope.test.ts`); a route-to-guard registry and test (`tests/security/route-capability.test.ts`, `docs/AUTHORIZATION.md`); the drill over every route on a fake D1, in both directions (`tests/drill/`). **Not done:** the staging drill (`scripts/tenant-isolation-drill.mjs` exists and has **never been run**), the Time Travel re-drill, migration 0026 on a real D1, audit of unknown-installation 403s |
| Secret handling | No secret or webhook URL in logs, dead letters, previews or exports; KEK custody and rotation rehearsed | partly | Redaction layer, log tests, export test, static console guard (`tests/security/`). A test proves no column, queue message or log line holds a KEK; deleting a connection is proven to make its secret unrecoverable; a foreign-environment KEK is refused at boot (ADR 0022). KEK rotation and KEK destruction have a runbook (`IMPLEMENTATION.md`, `RUNBOOK.md`) and a guarded script but have not been rehearsed in staging; no review has been done |
| Predeploy and smoke | `npm run deploy` refuses leftover required placeholders and ends with a `/health` and `/health/ready` smoke check that fails with a rollback instruction | partly | `scripts/predeploy-check.mjs`, `scripts/smoke-health.mjs`, `tests/config.placeholders.test.ts` (CI fails on a placeholder under a non-allow-listed key). Never run against a real deployment; `wrangler rollback` is UNVERIFIED for this account |
| Ingress outage handling | A D1 or deployment fault that refuses webhooks is recoverable | not done | Ingress is gated only on D1 and GitHub does not redeliver automatically, so an ingress outage needs **manual GitHub redelivery** for its window (docs/RUNBOOK.md, "After an ingress outage"). No ingress counter shows which window was missed. A config outage longer than about 2.6 hours dead-letters in-flight deliveries, which are recovered only by manual replay |
| Rollback rehearsal | Deploy, migrate, roll back, executed | not done | Migrations are additive and the v0 credential columns are kept for rollback (ADR 0004); per-migration reversibility is tabulated in `RUNBOOK.md` (some steps are not reversible). A rehearsal has not been performed |
| Migration 0026 (tenant contract) rehearsal | On a real D1: `scripts/migration-0026-preflight.sql` and `.mjs`, `MAINTENANCE_MODE` freeze, Time Travel bookmark, apply, the verification queries in `docs/RUNBOOK.md`, a deliberately failed run to confirm the foreign-key guard refuses the DROP, and a Time Travel restore | **BLOCKING, not done** | Never applied to a real D1. D1's behaviour on a file that fails part way (transaction, abort or carry on) and the foreign-key guard are **UNVERIFIED**: Cloudflare's migrations, best-practices and limits pages do not state them. Do not apply to production until this passes on staging |

## 2. Carried over from the PR #1 list

| Item | Status | Note |
| --- | --- | --- |
| CI typecheck and unit tests green; lockfile committed | done | `ci.yml` runs `npm ci`, format, lint, both typechecks, web build, tests, bundle check |
| Signed-webhook, invalid-payload and duplicate-delivery tests | partly | Signature verification has known-answer and tamper tests; route tests cover unknown and suspended installations and tenant routing; redelivery dedup is tested. A single signed-request pass through the Hono app for oversize and invalid JSON was not confirmed |
| D1 outbox transactions and queue retry/reconciliation under injected failures | partly | `tests/pipeline/reliability.test.ts` injects ledger and send failures against a SQLite-backed D1 fake. Not run against real D1 or Queues |
| Replace shared GitHub secret and repository-name-only routing with per-installation authorization | done | Slices 1 and 3b. The webhook secret is still App-wide (AR-13); tenant comes from the verified installation |
| Validate Lark signing and card schema, Slack and Teams with real destinations | not done | Adapters are fixture-tested only (ADR 0006) |
| Authenticated destination setup with encryption at creation | done | Slices 2 and 3a, dashboard in 6a |
| No secret values or webhook URLs in logs or failed-delivery errors | partly | Tested for the consumer path and the redactor; see section 1 |
| D1 database id, queues, secrets and a staging deploy configured | not done | `wrangler.jsonc` still carries `REPLACE_WITH_*` placeholders |
| Dead-letter and permanent-failure terminal states | done | ADR 0005; exhausted deliveries reach `dead_lettered` |
| Document rollback and migrations | partly | Key rotation rollback is documented; no general migration rollback procedure |

## 3. Security hardening checklist (slice S)

| Control | Status | Evidence |
| --- | --- | --- |
| Security headers on Worker responses | done | `src/security/headers.ts`, `tests/security/headers.test.ts` |
| SPA headers and strict CSP | partly | The Worker serves the shell with `SPA_HEADERS` plus script hashes (`src/web/shell.ts`, ADR 0017); static files use `web/public/_headers`. Sign-in, onboarding, overview and integrations loaded with no CSP violations on the production build in a real browser; other signed-in screens not exercised. **Whether the assets layer applies `_headers` to `/assets/*` on a real deployment is unconfirmed** |
| Webhook ingress flood control (F29) | partly | `ingressLimiter` is implemented and unit-tested; it is **not wired into the route** (follow-up in PROGRESS) |
| CI pinned actions, read-only permissions, concurrency | done | `ci.yml`, asserted by `tests/security/config-guards.test.ts` |
| Production dependency audit gate | done | `npm run audit:gate`; exception list is empty (`docs/SECURITY.md`) |
| Dependency review on PRs | partly | Job present but `continue-on-error` until it has run green |
| Dependabot | done | `.github/dependabot.yml` |
| `SECURITY.md` disclosure policy | partly | Present. Private vulnerability reporting must be enabled in repository settings (not verified) |
| `/.well-known/security.txt` (F242) | partly | Generated by the Worker per request (`src/web/security-txt.ts`), so `Expires` is always 90 days ahead and nothing can expire or be shadowed by a static asset; Contact is the GitHub private advisory form. Tested through `worker.fetch` (never the SPA shell, HEAD and 405, agrees with `SECURITY.md`). **Not verified on a deployment:** the response and its headers; that private vulnerability reporting is on; that anyone watches it |
| Retention matrix (F237) | partly | `src/compliance/retention.ts` is the single source; a test fails when a migration table is missing or a claimed removal mechanism does not exist; `docs/DATA_RETENTION.md` is generated and drift-tested. Hourly `expired_auth_purge` added for sessions, verification records, install states and auth rate-limit rows. **Open:** expired invitations and the retired `auth_*` tables are not purged; no per-workspace downward retention setting; no staleness alerts on the jobs (F190); never run against real D1 |
| Data-subject access and erasure (F238) | partly | `GET /api/workspace/me/data-export`, `DELETE /api/workspace/me` with step-up (session under 10 minutes old, else `reauth_required` and a re-sign-in in the dashboard), notice email, pending invitations preserved (`docs/DSAR.md`). Tested over the Node SQLite fake with a faked session, and in the dashboard with a mock API. **Open:** no real-session or real-D1 test; step-up is a recent sign-in, not a second factor, and there is no undo (AR-41); audit rows keep actor id, IP and user agent (AR-40); no correction or restriction mechanism; deadlines and roles are the operator's |
| Subprocessor and data-flow inventory | partly | `docs/SUBPROCESSORS.md`, derived from the code. Contracts, DPAs, regions and the public list are the operator's |
| Threat model and risk register | done | `THREAT_MODEL.md` (own analysis, not an audit) |
| Static guards (console, origin checks, config secrets, XSS sinks) | done | `tests/security/static-guards.test.ts` |
| `npm audit signatures`, install-script review, OIDC deploy | not done | F239 |
| Abuse alerting, audit coverage of unknown-installation 403s | not done | F231, F233 |
| Incident runbooks | partly | Availability and delivery-loss runbook (`RUNBOOK.md`) and a security incident skeleton (`INCIDENT_RESPONSE.md`: severity classes, playbooks tied to the real rotation and revocation mechanisms, evidence handling). Neither has been rehearsed; no on-call, no monitored contact, no automatic evidence hold; response targets are unset; several Cloudflare behaviours UNVERIFIED (F242) |
| Delivery SLIs, stall detection, retention (spec 13) | partly | `GET /api/observability/summary`, cron stall log line and bounded retention are tested against the Node SQLite fake only (ADR 0011). No paging, no `job_runs`, no ingress counter; nothing is measured against a real deployment, so no SLI may be published externally |
| Assets layer with `html_handling: none` and `not_found_handling: none` serves only fingerprinted files and `/_shell.html`, and sends every other path to the Worker (ADR 0017) | not done | Checked in local workerd only. Verify on a staging deployment: `/signin`, `/x.js` (404 with the baseline headers, `no-store`) and `/_serverFn/x` all answer from the Worker |
| `_headers` rules reach `/assets/*` on a real deployment (immutable cache, CSP, `nosniff`) | not done | Local workerd applies them; no deployed response has been inspected |
| Live queue message and DLQ message processed through the Vite-built Worker entry (`src/worker.ts`) | not done | The bundle exports `fetch`, `scheduled` and `queue` (asserted by `verify:worker-bundle`) and both consumers are in the built config; no message has been consumed through this entry |
| Production can never render through TanStack Start (ADR 0017 decision 5) | partly | Behavioural tests (`tests/web/worker.test.ts`) cover the Worker entry; not exercised against a real deployment. Start's server handler is also reachable only when the shell is absent, on a loopback host, with the exact build header |

## 3b. Not done for compliance (spec 15 F237, F238, F242), stated so it is not assumed

Data processing agreement templates; legal review of any document here; the legal-basis and
controller or processor decisions (every matrix row says "to be decided by the operator"); a
privacy policy; breach-notification decisions; a penetration test; SOC 2, ISO 27001 or any other
certification or audit (none exists, none is claimed); audit evidence of any kind; a monitored
security contact; rehearsals of the incident playbooks and of account erasure on real Cloudflare.

## 4. Known limitations

- **At-least-once delivery.** The outbox can enqueue a row more than once if the Worker
  crashes between `Queue.send` and the D1 update. Claims, the ledger and dedup keys bound this;
  provider requests may still be duplicated after a timeout (AR-5).
- Outbox reconciliation runs every minute and ingress also attempts prompt dispatch.
- Destinations: Lark, Slack and Teams adapters exist and are fixture-tested; real-provider
  behaviour is unvalidated.
- Delivery log and test send in the dashboard are not built (slice 6b).
