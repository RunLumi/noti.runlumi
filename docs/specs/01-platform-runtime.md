# 01 — Platform & Runtime

> Cloudflare limits below were read from official docs on **2026-10-13**. Where Cloudflare's
> own docs contradict themselves, both readings are recorded and we state which we build on.
> Re-verify before trusting any number here. Source of record: `docs/specs/README.md#sources`.

## Constraints we design against

| Fact | Value | Source |
| --- | --- | --- |
| **D1 is single-threaded per database** | "Each individual D1 database is inherently single-threaded, and processes queries one at a time." Max throughput = `1 / query duration` | [d1/platform/limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 max DB size | 10 GB Paid / 500 MB Free — **cannot be increased** | same |
| D1 max bound params per query | 100 | same |
| D1 max row size | 2 MB | same |
| D1 queries per Worker invocation | 1000 Paid / 50 Free | same |
| D1 batch = real transaction | "Batched statements are SQL transactions… it aborts or rolls back the entire sequence." | [d1/worker-api](https://developers.cloudflare.com/d1/worker-api/d1-database/) |
| D1 write auto-retry | **Reads only.** Writes are NOT auto-retried | [d1/best-practices/retry-queries](https://developers.cloudflare.com/d1/best-practices/retry-queries/) |
| Queues message size | 128 KB (incl. ~100 B metadata) | [queues/platform/limits](https://developers.cloudflare.com/queues/platform/limits/) |
| Queues ordering | **"Queues does not guarantee that messages will be delivered to a consumer in the same order in which they are published."** | [queues/how-queues-works](https://developers.cloudflare.com/queues/reference/how-queues-works/) |
| Queues delivery | At least once; one active consumer per queue | same |
| Queues batch retry | **All-or-nothing by default** — override with per-message `ack()`/`retry()` | same |
| Queues built-in backoff | **None.** Docs ship an *example* backoff function you implement yourself | same |
| Queues retention | ≤14 d Paid, **hard 24 h Free** | same |
| Queues per-queue throughput | 5,000 msg/s | same |
| Queues concurrent invocations | 250 (push consumers) | same |
| Workers CPU/invocation | 10 ms Free / 30 s default Paid (→5 min via `limits.cpu_ms`) | [workers/platform/limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Workers simultaneous connections | **6** per invocation | same |
| Workers env vars | 64 Free / **128 Paid** per Worker, 5 KB each | same |
| Secrets Store | **Not a per-tenant vault.** Fixed named account-level secrets, async `get()` | [secrets-store](https://developers.cloudflare.com/secrets-store/) |
| Rate Limiting binding | **Per-Cloudflare-location**, "not an accurate accounting system". `period` ∈ {10, 60} | [rate-limit](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) |
| Local: consumer concurrency | **"Consumer concurrency is not supported while running locally."** | [queues/local-development](https://developers.cloudflare.com/queues/configuration/local-development/) |

### Documented contradictions — we build on the conservative reading

| Topic | Conflict | Our position |
| --- | --- | --- |
| Cron trigger count | Limits page: "**per account** 5/250". Cron page: "**per Worker**". | Treat as account-wide. Use 1 cron. |
| Cron CPU | Limits: 30 s (<1 h interval). Pricing: 15 min. | Assume **30 s**. Keep crons cheap and frequent. |
| Workflows concurrency | Table: 50,000 Paid. Prose 2 paragraphs below: 10,000. | Not used in V1 (see F14 decision). |

---

## F01 — Reproducible toolchain

**Priority** P0 · **Status** 🟡 lockfile + CI `npm ci` (`.github/workflows/ci.yml`); `format`, `format:check`, `lint`, `typecheck`, `test`, `test:coverage`, `verify`, `check` scripts in `package.json`; strict TS with `noUncheckedIndexedAccess`/`noImplicitOverride`/`exactOptionalPropertyTypes` (`tsconfig.json`, ADR 0027, asserted by `tests/platform/gates.test.ts`); not built: no script named `build` (it is `build:web`), clean-clone run only proven by CI · **Fixes** D14

**Story** As a maintainer, I want one command that reproduces the toolchain exactly, so that CI and my laptop disagree about nothing.

**Acceptance**
- [ ] A committed lockfile. CI runs `npm ci`, never `npm install`.
- [ ] `package.json` exposes `format`, `format:check`, `lint`, `typecheck`, `test`, `test:coverage`, `build`, `check`.
- [ ] `npm run check` runs every gate in dependency order and fails on the first failure.
- [ ] `tsconfig.json` adds `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes`.
- [ ] `npm ci && npm run check` passes on a clean clone with no `node_modules`.

**Design** — Enable `noUncheckedIndexedAccess` deliberately. It is what currently allows
`src/index.ts:20` (`keyHex.match(/../g)!`) and `:20` (`state.results`) to compile with a
non-null assertion that can be violated at runtime. Turning it on will surface existing
holes; fix each rather than adding `!`.

**Errors** — none; this is a build-time concern.

**Security** — `npm audit --audit-level=high` in CI. Pin `wrangler` to the version used for
migrations so local and remote schema agree.

**Tests** — CI is the test. A test asserting our own tooling is theatre.

**Deps** — blocks F02.

---

## F02 — CI gates

**Priority** P0 · **Status** 🟡 CI on PR and `main`: `npm ci`, audit gate, format, lint, both typechecks, web build, tests, worker-bundle guard; concurrency cancel and read-only permissions asserted by `tests/security/config-guards.test.ts`; separate `integration` job (real `wrangler d1 migrations apply --local`) and a coverage floor in `vitest.config.ts` (ADR 0027); not built: a deliberately red PR per gate has not been run, merge-blocking is repository settings (unverified) · **Fixes** D14

**Story** As a maintainer, I want every documented check enforced, so that "we ran the
checks" cannot be a claim about something nobody runs.

**Acceptance**
- [ ] On PR and on push to `main`: `npm ci` → `format:check` → `lint` → `typecheck` → `test` → `build`.
- [ ] Integration tests run as a separate job that needs no secrets and no network.
- [ ] Coverage is reported and a **floor** is enforced (set the floor at the current
      number; it may only go up. A lowered floor must be a deliberate, reviewed commit).
- [ ] Concurrency group cancels superseded PR runs.
- [ ] `permissions: contents: read` retained; no `pull_request_target`.
- [ ] Merge is blocked on red.

**Design** — Two jobs, not one. `unit` is fast and hermetic. `integration` boots
`wrangler dev` against local D1 + local Queues. Conflating them makes the fast feedback
loop slow, and people then skip running it.

**Critical caveat from research** — *"Consumer concurrency is not supported while running
locally"* and D1's `overloaded` behaviour is **not emulated**. Therefore F08's concurrency
and D1-contention claims **cannot be proven by CI alone** and require a staging drill.
This is recorded so nobody later reports a green checkboard as coverage of contention.

**Errors** — failing jobs must print the failing command and the relevant tail, not the
full ANSI log.

**Security** — Secrets only from repository secrets on trusted branches. Never from forks.

**Tests** — a deliberate PR that violates each gate must go red. Verify once per gate.

**Deps** — F01, F13 (for error taxonomy assertions).

---

## F03 — Environment separation

**Priority** P0 · **Status** ❌ only `local` (`.dev.vars.example`) and one production-shaped `wrangler.jsonc` with `REPLACE_WITH_*` placeholders; no `env.staging`, no separate D1/queues/keys/GitHub App; needs a staging Cloudflare account (see `docs/RELEASE_GATES.md`)

**Story** As an operator, I want three isolated environments, so that a staging test can
never send a real customer a real notification.

**Acceptance**
- [ ] `local` (`.dev.vars`, local D1, local Queues), `staging`, `production`.
- [ ] Staging and production use **separate D1 databases, separate queues, separate
      encryption keys, separate GitHub Apps** and separate sending domains.
- [ ] No production secret is readable from staging. Enforced by distinct Worker secrets,
      not by convention.
- [ ] `docs/IMPLEMENTATION.md` has no step requiring a manual D1 row insert (today's step 6).

**Design** — Use Wrangler environments in one config rather than three configs, so binding
names cannot drift. Secrets are set per-environment via `wrangler secret put --env`.

**Errors** — a Worker that boots with a key belonging to another environment must refuse to
serve. This is F04.

**Security** — the staging→production path must be a pull request with review. No
`wrangler deploy` from a laptop for production; use CI with a protected environment.

**Tests** — deploy staging, run the full E2E against a staging GitHub App and a **staging
Lark/Slack/Teams group**. Confirm nothing lands in the production groups.

**Deps** — F04, F05.

---

## F04 — Configuration validation at boot

**Priority** P0 · **Status** 🟡 `src/platform/config.ts` `assertConfig(env)` returns binding names only and runs at the `fetch` (tiered guard: only D1 stops ingress), `queue` (per-message backoff) and `scheduled` (heartbeat first, then the tick fails visibly) entrypoints of `src/index.ts`; `/health` names no binding to an anonymous caller (names go to the log and the operator readiness view; `tests/platform/boot.test.ts`, ADR 0022, ADR 0036); `APP_ORIGIN` and `BETTER_AUTH_SECRET` are an auth tier that stops `/api` and `/github` but not ingress, the GitHub App bindings are named warnings, and unknown extra keys are logged once per isolate (`src/platform/config.ts`, `src/platform/config-keys.ts`, `tests/platform/boot-hygiene.test.ts`, ADR 0036); `.dev.vars.example` vs source drift tests (`tests/config.dev_vars.test.ts`). Not built: there is no `email` entrypoint · **Fixes** D1

**Story** As a maintainer, I want the Worker to fail loudly and immediately when its
configuration is wrong, so that a wrong secret name is a crash, not a silent 503.

**Acceptance**
- [ ] Every required binding and secret is asserted at module scope or in a single
      `assertConfig(env)` called by every entrypoint (`fetch`, `queue`, `scheduled`,
      `email`).
- [ ] `ENCRYPTION_KEY` is **hex-encoded exactly**; `ENCRYPTION_KEY_BASE64` is
      base64-encoded exactly. Both fail with a message naming the expected format.
- [ ] `/health` returns `503` with the **names** of missing variables and never their values.
- [ ] A test parses `.dev.vars.example` and asserts every key it declares appears in `Bindings`.

**Design** — One source of truth for the secret contract. `.dev.vars.example` is generated
from, or asserted against, the `Bindings` type so the two can never drift again. D1 is a
real, already-shipped instance of that drift going unnoticed.

**Errors**
| Condition | Response |
| --- | --- |
| Missing required secret | `503`, body lists missing **names** |
| Malformed key (wrong encoding/length) | `503` on boot, `console.error` once, no request handling |
| Unknown extra keys | ignored, but logged at debug once |

**Security** — never echo a value. Error text is asserted in tests to contain no secret
material, which is a cheap regression guard against redaction rotting (F12).

**Tests**
- `missing_secret_returns_503_with_names`
- `bad_key_encoding_returns_503`
- `dev_vars_example_matches_bindings`
- `health_response_contains_no_secret_values`

**Deps** — F12 (redaction helper).

---

## F05 — Migration discipline

**Priority** P0 · **Status** 🟡 22 numbered forward-only migrations applied from zero on every test run (`tests/support/d1.ts`, `tests/migrations.test.ts`, `tests/migration-00*.test.ts`); additive/expand-contract practice and per-migration reversibility table in `docs/RUNBOOK.md` (PR #7, ADR 0004); `wrangler d1 migrations apply --local` from zero in the CI `integration` job and a per-migration SHA-256 sidecar seal (`migrations/*.sql.sha256`, compared with the base branch on PRs; ADR 0027; a check only, blocking once branch protection requires it, which is an open operator action); not built: rollback never rehearsed

**Story** As an operator, I want every schema change to be a reviewed, reversible,
forward-only file, so that migrations are deploys rather than incidents.

**Acceptance**
- [ ] Migrations are immutable once merged. A correction is a new numbered file.
- [ ] Every migration has a documented rollback. Destructive changes use
      expand/contract across **two** releases, never one.
- [ ] `PRAGMA defer_foreign_keys = true` where FK timing requires it
      ([d1/reference/migrations](https://developers.cloudflare.com/d1/reference/migrations/)).
- [ ] CI runs `wrangler d1 migrations apply --local` on a **fresh** database to prove the
      chain builds from zero, not only that it applies to an existing one.
- [ ] Migrations reference `database_name`, never the binding name.

**Design** — The current chain (`0001`–`0004`) creates `integrations` without any
`workspace_id`. Adding tenancy is a breaking change to a table that already exists in
some environments. Plan it as: `0005` add nullable `workspace_id` + backfill + FK →
`0006` enforce NOT NULL → later releases drop the legacy columns. Do not shortcut this by
recreating `0001`; environments have already applied it.

**Errors** — a failed migration must leave the database on the last good version and be
reported, not silently partial. Use Time Travel for production recovery
([d1/reference/time-travel](https://developers.cloudflare.com/d1/reference/time-travel/),
30-day window Paid, max 10 restores / 10 min).

**Security** — migrations may not contain secrets or real tenant ids.

**Tests** — fresh-DB migration test in CI; rollback rehearsal in staging before each
release that touches `deliveries` or `event_receipts`.

**Deps** — F03.

---

## F06 — Tenant-sharded D1 topology

**Priority** P1 · **Status** 🚫 deferred by design: V1 runs on one D1 database, there is no `dbFor(workspaceId)` and `env.DB` is used directly; every tenant table carries `organization_id` so sharding stays possible; the revisit signal (`overloaded` rate) is in `docs/RUNBOOK.md` and the SLI work (ADR 0011); the decision is recorded in ADR 0034

**Story** As an operator, I want to escape the single-writer bottleneck before real
customers feel it, so that growth does not require a database migration.

**Acceptance**
- [ ] All tenant-scoped queries resolve a database via one function,
      `dbFor(workspaceId)` — never a bare `env.DB`.
- [ ] Shard key is derived from `workspace_id` and recorded on every row, so a row can
      always be located.
- [ ] `env.DB` (unsharded) is not referenceable outside the sharding module.
- [ ] Cross-shard queries (e.g. a global admin view) go through an explicit, documented
      fan-out path and are rate-limited.

**Design** — Cloudflare's own guidance: D1 is "designed for horizontal scale out across
multiple, smaller (10 GB) databases, such as **per-user, per-tenant or per-entity
databases**", and you may create up to **50,000** on Paid. Because a D1 database is backed
by a single Durable Object, queue auto-scaling to 250 concurrent consumers against one
database does **not** yield 250× write throughput — it yields contention, and the
documented failure is an `overloaded` error once the internal queue fills. Crucially,
Queues scales **down** when the ratio of failed invocations rises, so a D1 overload storm
actively reduces consumer parallelism.

Sequence: ship V1 on one database (simpler, easier to migrate), instrument query counts and
`overloaded` rates from day one (F14/F18), and shard when the measured numbers justify it —
not before. Sharding is a routing-function change plus a migration, not a rewrite, provided
every table already carries `workspace_id` (F25).

**Errors**
| Condition | Handling |
| --- | --- |
| D1 `overloaded` | Retry with exponential backoff + jitter (F09) |
| Write failure "object to be reset" / "Network connection lost" | Same — D1 does not auto-retry writes |
| Unknown shard for an existing workspace | Fail closed, log `shard_resolution_failed`, alert |

**Security** — shard key must not be user-controllable; derive it, never accept it from a
request.

**Tests** — `dbFor` is deterministic and covers all shards; cross-tenant access is
impossible through the sharding layer. Shard-routing itself is tested in staging because
local D1 cannot reproduce contention.

**Deps** — F25 (every table has `workspace_id`). **Blocked by** F05.

---

## F07 — Queue topology split by failure domain

**Priority** P0 · **Status** 🟡 queue messages carry ids plus display text and never a credential (PR #7, ADR 0004); `noti-deliveries` plus `noti-dead-letters` with a minimal DLQ consumer (`wrangler.jsonc`, `src/pipeline/dead-letter.ts`); not built: no `noti-ingress` (ingress persists synchronously via `db.batch`) or `noti-redeliver` queue, no message-schema allowlist test, 14-day DLQ retention depends on Workers Paid (unverified) · **Fixes** D4 (topology half)

**Story** As an operator, I want ingestion never to queue behind a slow destination, so
that one broken Lark webhook cannot stop GitHub ingestion.

**Acceptance**
- [ ] Four queues with distinct consumers:

| Queue | Job | Retention | Notes |
| --- | --- | --- | --- |
| `noti-ingress` | verify signature → authorize → normalize → dedupe → persist | default | must never block on I/O to a destination |
| `noti-deliver` | render → POST → classify → retry/dead-letter | default | the only queue that does network egress |
| `noti-dead-letter` | hold exhausted deliveries for inspection | **14 d** | only possible on Paid — see caveat |
| `noti-redeliver` | operator-triggered replay | default | must never auto-expire a replay request |

- [ ] Queue messages carry **identifiers only** — never a secret, never a payload
      large enough to matter. See D5.
- [ ] Message body ≤ 4 KB by construction, against a 128 KB platform limit.

**Design** — Queues allows 10,000 per account at no extra cost and throughput is
per-queue (5,000 msg/s each), so splitting costs nothing and buys independent concurrency,
independent retry policy, and independent retention. The 14-day DLQ retention is the real
payoff: you cannot configure 14-day retention on the hot delivery path without paying for
it on every message.

**Caveat to state plainly** — retention is a hard 24 h on Workers **Free**. A 14-day DLQ
therefore requires Workers Paid ($5/mo minimum). Until we are on Paid, the DLQ retention
guarantee is 24 h and this must be stated in customer-facing documentation, not assumed.

**Errors** — queue at capacity (25 GB backlog) raises `Storage Limit Exceeded` at send
time. Catch it, mark the receipt `queue_full`, and retry from the reconciler.

**Security** — queue messages are plaintext at rest in Cloudflare's infrastructure. Treat
them as a potential leak surface: identifiers only (D5).

**Tests** — assert the message schema rejects any field not on an allowlist. This is a
cheap, high-value guard: it makes "a secret leaked into the queue" a test failure.

**Deps** — F13, F14.

---

## F08 — Consumer configuration and backoff

**Priority** P0 · **Status** ✅ per-message `ack()`/`retry({delaySeconds})` with our own full-jitter backoff and 24 h cap, `Retry-After` honoured, exhausted deliveries reach terminal `dead_lettered` (`src/pipeline/consumer.ts`, `src/delivery/retry.ts`, `tests/delivery/retry.test.ts`, `tests/pipeline/reliability.test.ts`, ADR 0005); deviates from the spec table by design: one delivery queue, batch 5, queue retries 5 plus a 13-attempt ledger budget · **Fixes** D4 (retry half), D11

**Story** As a user, I want a transient destination outage to be ridden out rather than
turned into five duplicate notifications, so that I trust the channel.

**Acceptance**
- [ ] Consumer settings are declared in `wrangler.jsonc` and justified in a comment.

| Setting | Ingress | Deliver | DLQ | Rationale |
| --- | --- | --- | --- | --- |
| `max_batch_size` | 25 | 10 | 1 | Batch buys D1 round trips, not batching downstream |
| `max_batch_timeout` | 5 s | 5 s | — | Default. 60 s trades real latency for invocation count |
| `max_retries` | 3 | **8** | 1 | Destinations throttle; see below |
| `dead_letter_queue` | — | `noti-dead-letter` | — | |
| `max_concurrency` | unset (auto) | unset (auto) | 1 | Cloudflare recommends unset |

- [ ] Backoff is computed by us. Queues has **no built-in backoff**; the docs ship an
      *example* `calculateExponentialBackoff(attempts, base)` that must be implemented.
- [ ] Every message is `ack()`ed individually on success. Relying on batch success is
      forbidden — default batch semantics are all-or-nothing, so one failure redelivers
      all ten and re-sends to destinations that already succeeded. That is user-visible
      duplicate spam.
- [ ] `retry({ delaySeconds })` is called with a jittered backoff, capped at 24 h.

**Design** — Why 8 retries and not the default 3: Slack, Teams and Lark throttle, and
throttling is *transient by nature*. With `retry_delay: 0` and 3 retries, all three land
within seconds while the destination is still throttling. Backoff with jitter is the
correct response to a rate limit, not more attempts. Cloudflare bills a read operation per
retry, so 9 ops instead of 3 is a real but small cost — and the DLQ is what keeps the
"no silent loss" promise honest.

**Errors** — a message that exhausts retries must land in a **terminal** state visible in
the dashboard. It must never be left in `retrying` (today's behaviour, D11).

**Security** — never log the destination URL in full; log the provider hostname and a
truncated path only (F12).

**Tests**
- `backoff_is_monotonic_and_within_cap`
- `backoff_includes_jitter` (seeded RNG)
- `partial_batch_failure_retries_only_failed_messages`
- `exhausted_delivery_reaches_terminal_dead_letter_state`

**Deps** — F07, F13.

---

## F09 — D1 write discipline

**Priority** P0 · **Status** 🟡 event, delivery and outbox rows are written in one `db.batch()` (`src/connectors/sources/github/route.ts`, `generic/route.ts`, `provider-route.ts`) and no D1 `exec()` is used; `withD1Retry` with full jitter and an `idempotent` contract wraps the ingress batch (`src/db/retry.ts`, `tests/db/retry.test.ts`, ADR 0022); `tests/security/bound-parameters.test.ts` guards that no SQL interpolates request data and holds `no_query_exceeds_100_bound_parameters`; the outbox claim, reclaim, dispatched mark, release and invalid-payload batch are retried with a per-statement `idempotent` choice (`src/pipeline/outbox.ts`, `tests/pipeline/outbox-retry.test.ts`, ADR 0036). Not built: overload is deliberately not retried (Cloudflare guidance), unlike the table above, and whether it should be is undecided until there is evidence

**Story** As an operator, I want one round trip per event and a retry path for failed
writes, so that D1's single-writer model does not become our throughput ceiling.

**Acceptance**
- [ ] Every event is persisted in **one `db.batch()`** covering the event row, delivery
      rows and outbox rows. Batch is a real transaction and rolls back as a unit
      ([d1/worker-api](https://developers.cloudflare.com/d1/worker-api/d1-database/)).
- [ ] A shared `withD1Retry(fn)` wraps **all** writes, using exponential backoff + jitter
      with full jitter, retrying only on retryable errors.
- [ ] No write uses `exec()` — the docs call it "less safe" and reserve it for
      maintenance.
- [ ] Every batch is sized so no single statement exceeds **100 bound parameters**.
- [ ] Indexed columns are declared deliberately; each index is accepted as a documented
      write-amplification cost ($1.00/M rows written).

**Design** — `batch()` pays the per-request overhead once, which is the single most
important lever available given a database that processes "queries one at a time". Batch
also gives atomicity for free: "the event row and its delivery rows are committed together
or not at all", which is precisely the outbox invariant F15 needs.

D1 auto-retries **read-only** queries twice. It does **not** retry writes. Transient write
failures (`Network connection lost`, `storage caused object to be reset`) must be handled by
us or the event is silently lost.

**Errors**
| Error | Retry? |
| --- | --- |
| `Network connection lost`, `storage caused object to be reset` | yes, with backoff + jitter |
| `overloaded` | yes, with backoff + jitter, and emit a metric |
| Constraint violation | **no** — programming error, surface it |

**Security** — no query interpolates user input; bindings only.

**Tests**
- `batch_failure_rolls_back_every_statement`
- `withD1Retry_retries_retryable_write_errors`
- `withD1Retry_does_not_retry_constraint_errors`
- `no_query_exceeds_100_bound_parameters` (static assertion over the query builders)

**Deps** — F08 (shares the backoff implementation).

---

## F10 — Health, readiness and diagnostics

**Priority** P0 · **Status** 🟡 `GET /health` is configuration only and stays 200 while D1 is down; `GET /health/ready` probes config, D1 (`SELECT 1`) and the queue binding and returns booleans only, 503 on failure, cached 5 s, routed to the API in a deployment (`src/index.ts`, `src/web/shell.ts`, `tests/platform/boot.test.ts`, `tests/web/worker-health.test.ts`, ADR 0022). The authenticated operator view `GET /api/observability/readiness` (a user on `PLATFORM_OPERATOR_USER_IDS`, else 404) names the failing binding per tier, the warnings and the unknown keys; `/health` no longer names any binding (`tests/platform/boot-hygiene.test.ts`, ADR 0036). Not built: no per-dependency error code beyond the booleans for an anonymous caller (deliberate)

**Story** As an operator, I want a health endpoint that distinguishes "process is up" from
"dependencies work", so that an outage is diagnosable without shell access.

**Acceptance**
- [ ] `GET /health` → liveness only. Cheap, no dependencies touched. Always `200` if the
      Worker is running.
- [ ] `GET /health/ready` → readiness. Checks config (F04), a trivial D1 query, and queue
      binding presence. `503` with named failures.
- [ ] Neither endpoint reveals tenant counts, secret names' values, or internal hosts.
- [ ] Neither performs a destination network call.

**Design** — Today `/health` returns `{ok:true}` unconditionally, which would report
healthy while D1 is unreachable and every delivery is failing.

**Errors** — readiness returns a stable machine-readable code per dependency
(`config`, `d1`, `queue`) plus a human message.

**Security** — do not expose this publicly in production, or return the same 200
everywhere to unauthenticated callers while giving authenticated operators detail.

**Tests** — `health_is_200_when_d1_is_unavailable`; `ready_lists_failing_dependency_names`.

**Deps** — F04.

---

## F11 — Correlation IDs and structured logging

**Priority** P0 · **Status** 🟡 correlation id minted at ingress, echoed as `x-request-id`, `cf-ray` captured, carried in every `log()` line through `AsyncLocalStorage` (`src/platform/correlation.ts`, `src/platform/log.ts`, `tests/platform/correlation.test.ts`, `tests/api/observability.test.ts`); not built: id is not stored on D1 rows, not carried in queue messages, not shown in the delivery detail view, fixed key set not asserted

**Story** As a support engineer, I want one identifier to follow a notification from
webhook receipt to destination, so that a user report can be answered without guessing.

**Acceptance**
- [ ] One `correlation_id` (UUIDv4) minted at ingress and propagated through: D1 rows,
      queue message bodies, all log lines, delivery attempts and the user-visible
      delivery-detail view.
- [ ] `cf-ray` is captured alongside it, but never replaces it.
- [ ] Logs are structured JSON with a fixed key set: `ts, level, msg, correlation_id,
      workspace_id, integration_id, delivery_id, event_type, destination, outcome, error_code`.
- [ ] `workspace_id` and `delivery_id` are loggable; nothing on F12's denylist is.
- [ ] Log line size stays under the platform's **256 KB per request** cap.

**Design** — Mint at ingress rather than in the consumer so that verification failures —
which never reach a consumer — are still traceable. That is precisely the case a user
reports ("your webhook got a 401 and I can't tell why").

**Errors** — if a correlation ID cannot be propagated (e.g. message predates the field),
log `correlation_missing` once rather than silently continuing.

**Security** — see F12.

**Tests** — `correlation_id_is_stable_across_ingress_queue_and_consumer`;
`log_line_matches_expected_key_set`; `log_line_never_contains_denylisted_values`.

**Deps** — F12.

---

## F12 — Redaction layer

**Priority** P0 · **Status** ✅ `redact()` with word-level key denylist (including email, installation id, ciphertext), URL host-only scrubbing, token-format scrubbing, `[redacted]` never a prefix, error `name`/`code` kept, never throws (`src/platform/redact.ts`, `tests/platform/redact.test.ts`); every log line goes through it (`src/platform/log.ts`); static guards ban `console.log` and secret-bearing console calls (`tests/security/static-guards.test.ts`); no lint rule on `JSON.stringify` of provider responses · **Fixes** part of D6/RELEASE_GATES

**Story** As a customer, I want my webhook URL and tokens to never be written to logs or
error messages, so that a leaked log does not leak my credentials.

**Acceptance**
- [ ] One `redact()` helper is the **only** sanctioned way to construct an outbound log or
      error string. Direct `JSON.stringify` of a provider response is a lint error.
- [ ] Denylist by field name, applied recursively, covering at minimum:
      `webhook_url, url, secret, token, authorization, cookie, signature, sign, password,
      ciphertext, key, email, installation_id`.
- [ ] `email` is on the list by default — tenant PII must be opt-in to logs.
- [ ] Secrets render as `"[redacted]"`, never as a truncated prefix. A partial secret is
      still a secret.
- [ ] Redaction runs **before** the log call, not on the way to storage.
- [ ] Error objects crossing a boundary are redacted, preserving `name` and `code` but
      scrubbing `message`.

**Design** — Cloudflare caps logs at 256 KB/request and metering is per-GB, so redaction is
a cost control as well as a security control. Note the belt-and-braces ordering: redact at
the call site (F12) *and* sample at the edge (F19) — never rely on one.

**Errors** — if redaction itself throws, drop the fields rather than the log line. A log
that fails to emit is worse than a log with gaps.

**Security** — this feature *is* the security control. Its tests are the evidence.

**Tests**
- `redact_removes_nested_secret_fields`
- `redact_preserves_error_name_and_code`
- `redact_never_emits_a_secret_prefix`
- `log_output_contains_no_denylisted_key` (property-based over synthetic provider responses)

**Deps** — none. **Blocks** F11, F13.

---

## F13 — Error taxonomy and classification

**Priority** P0 · **Status** ✅ closed, versioned `ErrorCode` union with `retryable`, `user_actionable` and message per code, default `internal_error` (`src/platform/errors.ts`, `tests/platform/errors.test.ts`); provider classifiers map onto it (`src/connectors/destinations/*/classify.ts`, `src/delivery/classify.ts`, `tests/delivery/classify.test.ts`); dead letters record the terminal code (ADR 0005); free-text kept only as redacted diagnostic · **Fixes** D11

**Story** As an operator, I want every failure mapped to a stable error code with a
retry decision attached, so that permanent failures stop burning retries and users see an
actionable message instead of "HTTP 500".

**Acceptance**
- [ ] A closed enum of `error_code` values, versioned, with a default of
      `internal_error` and **no** free-text error stored as a primary classification.
- [ ] Each code declares `retryable: boolean`, `user_actionable: boolean`, and a
      user-facing message template.
- [ ] Every provider `classifyError` maps its documented error surface onto this enum
      (per-provider mappings are specified in the destination specs).
- [ ] Retry decisions use the enum, never `res.status >= 500` heuristics alone.
- [ ] A dead-lettered delivery records the terminal code and the user-facing message.

**Taxonomy (initial)**

| Code | Retryable | Meaning | User message |
| --- | --- | --- | --- |
| `signature_invalid` | no | Signature did not verify | — (never surfaces; internal) |
| `replay_detected` | no | Duplicate or stale delivery ID | — |
| `unauthorized_tenant` | no | Credential does not authorize this tenant | — (audit) |
| `destination_url_rejected` | no | SSRF policy violation | "This destination is not permitted." |
| `destination_credentials_invalid` | no | Provider rejected the credential | "Reconnect the destination." |
| `destination_revoked` | no | Webhook/channel deleted by user | "The destination was deleted. Reconnect it." |
| `destination_unauthorized` | no | Provider auth failure (401/403) | "Reconnect the destination." |
| `destination_rate_limited` | **yes** | 429 | "Rate limited — retrying." |
| `destination_unavailable` | **yes** | 5xx, network error | "Temporarily unavailable — retrying." |
| `destination_timeout` | **yes** | Request exceeded our deadline | — |
| `payload_too_large` | no | Exceeds provider limit | "This event is too large for the destination." |
| `render_failed` | no | No valid rendering for this capability set | "No supported format for this destination." |
| `config_invalid` | no | Integration config invalid | "Check the integration settings." |
| `internal_error` | yes | Unexpected | "Something went wrong. Our team has been notified." |

**Design** — `error_code` is a column with a check constraint or an app-level closed union
type. Free-text `last_error` is retained **only** as a redacted diagnostic alongside the
code, never as the classification. `Retry-After` is captured as a separate field when
present and honoured over our own backoff.

**Errors** — unmapped provider errors fall back to `destination_unavailable` if HTTP 5xx,
`internal_error` otherwise, and both raise a metric so the mapping can be completed.

**Security** — user-facing messages never contain provider response bodies, which
routinely echo back URLs and tokens.

**Tests** — table-driven test over the whole enum: every code has a message, and every
code's `retryable` flag matches its class. Plus per-provider mapping fixtures.

**Deps** — F12. **Blocks** F08, F20 (error surfacing in the dashboard).

---

## F14 — Architecture decision record process

**Priority** P1 · **Status** 🟡 ADRs in `docs/adr/` with Status/Context/Decision/Consequences sections, and a dated sources list and known-contradictions table in `docs/specs/README.md`; the five listed decisions are recorded (ADRs 0031 to 0035, numbers differ from the table below), and `scripts/check-docs.mjs` (run by `tests/docs/check-docs.test.ts`) checks ADR file names, unique numbering, title, Status line and headings (Context, Consequences and Revisit when from ADR 0031); built (ADR 0037, `tests/docs/check-docs.test.ts`): an offline check that every `http(s)://` URL in `docs/adr/` is https, parses, has no trailing punctuation and no whitespace in a link destination, and that ADRs 0031 to 0035 each cite an https source (the five now cite the Cloudflare and CloudEvents URLs, most read 2026-10-13 via `docs/specs/01`, and mark what was not re-read); not built: live link verification (no network in CI, and the agent sandbox could not reach developers.cloudflare.com on 2026-10-15) and the human re-read that each cited page supports its claim

**Story** As a maintainer, I want material decisions recorded with the alternatives and
revisit triggers, so that the reasoning survives the person who made it.

**Acceptance**
- [ ] New ADRs in `docs/adr/NNNN-<slug>.md` follow the existing template: Status,
      Decision, Why, Consequences, Revisit when.
- [ ] Any spec in `docs/specs/` that cites an external limit or API records the URL and
      the date it was read.
- [ ] `docs/specs/README.md#sources` lists every external source with its read date, and
      carries the list of **known Cloudflare doc contradictions** so the next reader does
      not rediscover them.

**Decisions to record now**
| ADR | Decision | Revisit trigger |
| --- | --- | --- |
| `0002` | Workers + D1 + Queues; **no** Durable Objects in V1 | Real cross-tenant contention metrics (F06) |
| `0003` | CloudEvents-compatible canonical envelope (F38) | Source catalogue expands past ~4 providers |
| `0004` | Secrets Store holds wrapping keys only; ciphertext lives in D1 | Secrets Store GA / per-tenant features |
| `0005` | At-least-once delivery is the contract; duplicates surfaced, never hidden | A destination offers true idempotency |
| `0006` | V1 ships on a single D1 database; sharding is deferred, not dismissed | `overloaded` errors or p95 query latency breaches |

**Errors** — an ADR whose referenced limit has no URL is treated as an unverified claim
and blocks release review.

**Security** — n/a.

**Tests** — n/a (process control). CI can at minimum assert `docs/adr/` files match the
template's required headings.

**Deps** — none.