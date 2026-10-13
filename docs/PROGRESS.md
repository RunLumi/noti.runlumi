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
| 3 | Tenant-scoped integrations API with write-time validation; GitHub App install flow; `organization_id` NOT NULL contract | F26–F29, F56–F58, F72 | D2 (contract), D9, D12, D16, N6 | ⬜ | — |
| 4 | Delivery reliability: atomic claim, error taxonomy, bounded retries, dead letter, manual redelivery | F169–F190 | D4, D10, D11 | ⬜ | — |
| 5 | Destination capability model; Slack and Teams adapters | F91–F104 | D8 | ⬜ | — |
| 6 | Dashboard: setup wizard, integrations, delivery log, test send | F205–F226 | — | ⬜ | — |
| 7 | Routing rules and filters | F119–F140 | — | ⬜ | — |
| 8 | Grouping, digests and noise control | F141–F168 | — | ⬜ | — |
| 9 | Observability and runbook | F191–F204 | — | ⬜ | — |
| 10 | Additional sources and destinations, gated on demand evidence | F73–F90, F105–F120 | — | ⬜ | — |

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
