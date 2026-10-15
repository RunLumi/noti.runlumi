# ADR 0044: Retention matrix enforcement, expired-invitation purge and the ledger period

Status: Accepted · Date: 2026-10-15 · Implements slice 1.22 of [`docs/specs/REMAINING.md`](../specs/REMAINING.md), F237 in
[spec 15](../specs/15-security-and-compliance.md). Reads F190 and F192 (job staleness, spec 13) as already built by
[ADR 0024](0024-job-runner-alerting.md). Builds on [ADR 0011](0011-observability.md) (the retention vars) and
[ADR 0030](0030-sessions-and-device-list.md) (the session lifetimes). Legal review of the wording is out of scope (group 3).

## Context

F237 asks for one retention table, an enforcement job for each row, a staleness alert for each job, a per-workspace
downward setting, and a resolved ledger period. Before this slice `src/compliance/retention.ts` already held a row for
every table and checked the removal mechanisms against the schema and the purge code. Reading it against the purge
code found four places where the table and the code disagreed, one row with no purge at all, and one spec row that the
accepted ADR 0011 contradicted.

- **Session.** The row said "until it expires (30 days)". The code also enforces a 90-day absolute lifetime from
  sign-in (ADR 0030), so 90 days is the outer bound a row can survive.
- **Verification.** The row said the lifetimes were "UNVERIFIED Better Auth defaults". They are explicit in
  `src/auth/session-policy.ts`: one hour each for email verification and password reset.
- **Outbox.** The row said rows of a retained delivery are kept "so it can be redelivered". The purge in
  `src/pipeline/outbox.ts` removes the rows of `sent`, `accepted` and `suppressed` deliveries after 7 days, and
  `planReplay` refuses those states anyway (`already_delivered`). Only dead-lettered and failed deliveries are replayed,
  and their rows are kept with the delivery.
- **Invitation.** The row was `not_enforced`: "kept until the workspace or the inviting account is deleted". F237 lists
  an expired-invitation purge as not built. An expired invitation cannot be accepted, so nothing usable is lost by
  removing it.
- **Ledger.** The spec table says the delivery ledger lasts "as long as the workspace exists". ADR 0011 (Accepted,
  2026-10-13) sets `DELIVERY_RETENTION_DAYS` to 90 by default, bounded 30 to 365, and spec 13 F197
  names 90 days as the delivery-metadata horizon. The SLIs, the bounded purge and the wrangler var are all built on
  that period.

## Decision

### 1. The ledger stays at 90 days, and the spec row is amended

The brief said to follow the spec where spec and code disagree, unless a higher-level decision exists. ADR 0011 is an
accepted decision about this exact number, and spec 13 agrees with it, so it is the higher-level decision. Moving the
ledger to workspace lifetime would make `deliveries` and `delivery_attempts` grow without bound on D1, would contradict
the 365-day maximum of the configurable var, and would change a customer-facing promise. That is a cost and product
decision for the operator, not something to take silently in a retention slice. The enforced value is 90 days by
default, configurable 30 to 365 (ADR 0011). The F237 table row now says so, and the spec status records the deviation.
If the operator wants workspace lifetime, that means a new bound and a cost review; it is not a constant change.

### 2. Invitations are purged 30 days after their expiry

`purgeExpiredAuthRecords` (run by `expired_auth_purge`, hourly) now deletes `invitation` rows whose `expires_at` is more
than `INVITATION_PURGE_AFTER_EXPIRY_MS` (30 days) in the past, whatever the status. The period is an engineering
judgment, recorded as one so the matrix has a number, and the operator should confirm it. The purge uses the same
bounded, resumable delete and the same unit canary as the other expiry deletes: an `expires_at` in seconds aborts the
pass (`expired_purge_aborted`) instead of removing every invitation. No migration is needed; the table and its
`expires_at` column already exist (`migrations/0005_better_auth.sql`). The table has no index on `expires_at`. It is
small, and the hourly scan is accepted for it in the same way as for `session`.

### 3. The matrix now says what the code does

- `session`: retention `until_expiry` at the 90-day absolute bound, with the 30-day idle expiry in the notes.
- `verification`: `until_expiry` at the explicit one-hour lifetime.
- `invitation`: `fixed` at 30 days after expiry, removed by `expired_auth_purge`.
- `notification_outbox`: the note now states that `sent`, `accepted` and `suppressed` rows go after 7 days, that
  `dead_lettered` and `failed` rows stay with their delivery because replay re-reads them (`src/delivery/redeliver.ts`),
  and that orphans go with the delivery retention. The header comment of `src/pipeline/retention.ts` said the same
  thing more loosely and is corrected.

### 4. Data the spec lists that the code does not store

`NOT_STORED` in `src/compliance/retention.ts` records three F237 rows as decisions, not gaps:

- **Raw provider payload** (7 days). Not stored. The request body is verified and parsed for the request and is not
  written to D1 or to a queue message. The stored thing is the rendered notification in `notification_outbox`.
- **Normalized envelope.** The event as delivered is that same rendered notification, so its period is the outbox
  row's period.
- **`semantic_dedup`** (7 days). No table exists. Repeats are recognised by `event_dedup` alone.

They appear in `docs/DATA_RETENTION.md` under "Not stored", and the test checks the schema for a column named for a
provider body (`body` and `raw` names, `*_json` request or response columns; `body_hash` is a digest and is allowed).

### 5. Machine checks added to the matrix test

`tests/compliance/retention.test.ts` now also asserts that:

- every `fixed` period names an exported constant in the file it names, and that constant is used by the purge code
  (outside `src/compliance/`), so a purge that hard-codes its own number, or a matrix row that points at a stale
  constant, fails;
- every cron job that deletes data is in `JOB_CADENCE` (`src/observability/cadence.ts`), the table the `job_stale`
  alert reads;
- `NOT_STORED` is well formed and the schema has no `semantic_dedup` table and no provider-body column.

The test also checks the session row against `SESSION_ABSOLUTE_SECONDS`. `tests/pipeline/expired-records.test.ts`
gained boundary tests for invitations: one kept inside the window and one removed outside it, every status, a seconds
timestamp that aborts the pass, and a bounded backlog that continues on the next tick.

### 6. Staleness (item 3 of the slice)

ADR 0024 already does this. `job_state` is written by every run, `readJobHealth` marks a job stale when its last healthy
run is older than three cadences, and `job_stale` is a critical alert in the registry. All thirteen cron jobs are in
`JOB_CADENCE`, including the seven that purge. Nothing was wired. The new test ties the deleting jobs to that table so a
purge cannot be added without a cadence. Gap: `job_stale` reports how many jobs are stale, not which; the names are in
`GET /api/observability/summary` and in `job_state`. Naming the job in the alert payload would touch the alert engine
and is left for a follow-up.

### 7. Per-workspace downward retention is not built

It needs a per-workspace value, and the only places to hold one without a migration are the free-form
`organization.metadata` text or an existing settings blob. Either way every purge statement would need a per-workspace
cutoff, because the purges are tenant-agnostic range deletes, and the dashboard would need to show the value and let the
admin change it. That is more than the slice, and this ADR does not add a column. Recorded as not done.

## Consequences

- The matrix, the generated doc, the code and the tests now agree on every row. The one exception is the explicit gaps
  listed below.
- Expired invitations stop accumulating. Erasing an account and workspace deletion behave as before.
- A reader of `DATA_RETENTION.md` now sees 90 days for the session row. That is the outer bound; the text says so.
- The ledger keeps its 90-day default. A customer who wants "as long as the workspace exists" will not get it from this
  change, and the spec no longer promises it.

## Not done

- **Per-workspace downward retention** (section 7).
- **Job name in the `job_stale` alert** (section 6).
- **Purge of accounts whose email was never verified.** The `user` row says "until the account is deleted". Such
  accounts stay until an operator deletes them (`docs/DSAR.md`). A purge would delete people's accounts, which needs a
  product and legal decision first.
- **Drops of the retired `auth_*` tables and `legacy_orphaned_rows`.** Both are documented gaps. The operator drops them
  by hand (`docs/RUNBOOK.md`).
- **Workers Logs and Cloudflare Email Sending retention.** Account settings, recorded as operator decisions.
- **Legal wording.** Out of scope (group 3).
- **Real D1.** `meta.changes` for DELETE, and the purge behaviour under D1 rather than the Node SQLite fake, are not
  verified here.

## Revisit when

- The operator decides the ledger period. A longer default, or workspace lifetime, needs a D1 size estimate and a
  change to the `DELIVERY_RETENTION_DAYS` bound (currently 365 at most), and then this ADR and spec 15 F237 change together.
- A per-workspace setting is wanted, or the plan tiers need different periods. Then pick a storage home for the value
  (a column needs a migration and its own review) and make every purge statement read it.
- A second data class is added to the schema. The matrix test fails until it has a row, so the decision cannot be skipped.
- Accounts with unverified email are allowed to age out. That is a product and legal decision, not a code change.

## Verification

Run on 2026-10-15 in this worktree (`npm ci --ignore-scripts` first):

- `npm run -s typecheck` and `npm run -s typecheck:web`: pass.
- `npx eslint` on the changed source and test files: pass.
- `npx prettier --check` on the changed files: pass.
- `npx vitest run tests/compliance/retention.test.ts tests/pipeline/expired-records.test.ts tests/observability tests/pipeline/retention.test.ts`:
  11 files, 229 tests, pass.
- `npm run -s docs:retention` regenerates `docs/DATA_RETENTION.md`, which is committed with this change.
- `npm run -s docs:check`: see the slice report for its result.
- `npm run -s test` (full unit suite): see the slice report for its result.

Not verified here: the purge against real D1 (`meta.changes` on DELETE, the bounded-loop assumption), and the invitation
purge against real Better Auth rows. Both are the fake D1 and the migration schema only.
