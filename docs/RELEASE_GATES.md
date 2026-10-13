# Release gates

Living checklist. Last reconciled with [`PROGRESS.md`](PROGRESS.md) on 2026-10-13, after
slice S. It supersedes the earlier "gates for PR #1" list; every item from that list is still
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
| Tenant isolation | The F233 drill (org A attempts to read, update and delete org B's integration, destination, delivery, dead letter and audit rows by id) plus static query checks, and a Time Travel restore re-drill | partly | Tenant resolution comes only from the verified installation and every query is scoped (slices 1, 3a, tests under `tests/`). The staging drill and a static every-query-filters-by-org check are not done |
| Secret handling | No secret or webhook URL in logs, dead letters, previews or exports; KEK custody and rotation rehearsed | partly | Redaction layer, log tests, export test, static console guard (`tests/security/`). KEK rotation has a runbook (`IMPLEMENTATION.md`) but has not been rehearsed; no review has been done |
| Rollback rehearsal | Deploy, migrate, roll back, executed | not done | Migrations are additive and the v0 credential columns are kept for rollback (ADR 0004); per-migration reversibility is tabulated in `RUNBOOK.md` (some steps are not reversible). A rehearsal has not been performed |

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
| SPA headers and strict CSP | partly | `web/public/_headers`; signed-out screens loaded with no CSP violations in a real browser; signed-in screens not exercised. **Deployment of the `_headers` file to the static host is unconfirmed** |
| Webhook ingress flood control (F29) | partly | `ingressLimiter` is implemented and unit-tested; it is **not wired into the route** (follow-up in PROGRESS) |
| CI pinned actions, read-only permissions, concurrency | done | `ci.yml`, asserted by `tests/security/config-guards.test.ts` |
| Production dependency audit gate | done | `npm run audit:gate`; two dated exceptions for dev-only tinypool (`docs/SECURITY.md`) |
| Dependency review on PRs | partly | Job present but `continue-on-error` until it has run green |
| Dependabot | done | `.github/dependabot.yml` |
| `SECURITY.md` disclosure policy | partly | Present. Private vulnerability reporting must be enabled in repository settings (not verified) |
| Threat model and risk register | done | `THREAT_MODEL.md` (own analysis, not an audit) |
| Static guards (console, origin checks, config secrets, XSS sinks) | done | `tests/security/static-guards.test.ts` |
| `npm audit signatures`, install-script review, OIDC deploy | not done | F239 |
| Abuse alerting, audit coverage of unknown-installation 403s | not done | F231, F233 |
| Incident runbooks, `security.txt` | partly | Availability and delivery-loss runbook exists (`RUNBOOK.md`, never rehearsed, several Cloudflare behaviours UNVERIFIED). Security incident response and `security.txt` are not done (F242) |
| Delivery SLIs, stall detection, retention (spec 13) | partly | `GET /api/observability/summary`, cron stall log line and bounded retention are tested against the Node SQLite fake only (ADR 0011). No paging, no `job_runs`, no ingress counter; nothing is measured against a real deployment, so no SLI may be published externally |

## 4. Known limitations

- **At-least-once delivery.** The outbox can enqueue a row more than once if the Worker
  crashes between `Queue.send` and the D1 update. Claims, the ledger and dedup keys bound this;
  provider requests may still be duplicated after a timeout (AR-5).
- Outbox reconciliation runs every minute and ingress also attempts prompt dispatch.
- Destinations: Lark, Slack and Teams adapters exist and are fixture-tested; real-provider
  behaviour is unvalidated.
- Delivery log and test send in the dashboard are not built (slice 6b).
