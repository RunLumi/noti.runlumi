# ADR 0021: Tenant contract in the schema, and static proof of it

Status: Accepted · Date: 2026-10-14 · Implements (as migration 0026, renumbered from 0023 so it follows #51's 0024 and #53's 0025) the contract step of F25, the static half of F26 and
F233, and F232 (`docs/specs/02`, `docs/specs/15`); REMAINING slices 1.1, 1.20 and 1.23. Builds on
[ADR 0004](0004-envelope-encryption.md) (rows are crypto-shredded by deletion) and
[ADR 0008](0008-github-install-verification.md) (the tenant comes from the verified installation).

## Context

The tenant boundary was enforced in two places that could each fail silently:

1. **At rest, only for new writes.** `integrations`, `deliveries` and `notification_outbox` carried a
   nullable `organization_id` with no foreign key (migration 0006, the expand step). Insert triggers
   (0008) stopped new NULLs on integrations, but legacy rows could still hold NULL, a dangling id was
   representable, and three later tables (`held_events`, `routing_decisions`, `noise_open_failures`,
   0021) were NOT NULL with no foreign key.
2. **In code, by convention.** Every query was written with an `organization_id` predicate, and
   cross-workspace tests covered the routes that existed when they were written. Nothing failed if
   the next query or the next route forgot it.

The audit over the full migration chain (via the fake D1) found, before this change:

| Table | `organization_id` | Foreign key |
| --- | --- | --- |
| `integrations`, `deliveries`, `notification_outbox` | nullable | none |
| `held_events`, `routing_decisions`, `noise_open_failures` | NOT NULL | none |
| `sources`, `github_installations`, `github_auth_states`, `member`, `invitation` | NOT NULL | cascade |
| `audit_events` | nullable by design (a denial against a workspace that does not exist) | cascade |
| `workspace_deletions` | PRIMARY KEY, no FK by design (the purge ledger outlives the organization) | none |

## Decisions

### A. Migration 0026: contract, with derivation and quarantine, never a guess

`organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE` on the six tables above,
by rebuild (the same technique as 0009, 0012 and 0018). In order, in one file:

1. **Backfill only what is derivable from our own rows:** an integration from its source
   (`sources.organization_id`, itself NOT NULL), a delivery from the integration it was routed to, an
   outbox row from the delivery with the same id, else from the integration named in its payload. A
   tenant is **never** assigned from a repository name or any sender-supplied field: that is defect D3.
2. **Quarantine the rest.** A row with no valid organization (NULL, empty, or an id with no
   `organization` row) is moved to `legacy_orphaned_rows` with **metadata only**: no ciphertext, no key
   material, no event payload. Reasons: `organization_missing`, `organization_not_found`. These rows were
   already unroutable and unreachable through every API (all are organization-scoped), so nobody can
   have seen them; they leave the live tables with their credentials, which are then recoverable only through D1 Time Travel (never from the quarantine, which keeps no secrets), because no owner exists to be shown or re-use them.
   The alternatives were rejected: *deleting* loses the audit trail of what was dropped; *keeping the
   row under a sentinel organization* invents a tenant that holds secrets nobody can authorise;
   *failing the migration* leaves production unable to apply the contract because of rows that serve
   nobody. The table has no `organization_id` by design (it holds the rows that have none), is read by no
   code (a test fails if `src/` mentions it) and is dropped by an operator after review.
3. **Verify** the copy against the live original (kept + quarantined = original, and every orphan has
   its quarantine row). The check is an INSERT into a table whose CHECK constraint is named
   `row_counts_must_match`, so where D1 aborts a failed file it aborts here, before anything is renamed; a
   second gate keeps every rename blocked where it does not. After the swap the same recount runs against
   the kept `_old` (`swap_counts_must_match`). Counts only; the content comparison is finalize's.
4. **Swap, non-destructive, safe without atomicity.** The Cloudflare migrations, best-practices and limits
   pages do not say whether a file runs in a transaction or whether a failed statement stops it
   (**UNVERIFIED**; they do document 30 seconds per query, 100 KB per statement and chunks of about 1,000
   rows). sqlite3's own default carries on after an error, and SQL has no conditional DROP.
   **Design change (amended after a second independent review).** The first version renamed the original
   aside, then `DROP TABLE <t>_old` behind a temporary foreign-key guard released by a recount. Applied in
   scratch SQLite in three runner modes, with sabotage and foreign keys on and off, that guard failed:
   re-running over a leftover `_old` in a carrying-on runner dropped the originals (28 of 54 sabotage
   cases), foreign keys off dropped them (39 of 54), and `PRAGMA defer_foreign_keys=ON` inside a
   transaction defeated it too. A guard that depends on runner behaviour and pragmas is not a guard, so
   **the DROP was removed rather than defended**: migration 0026 contains no `DROP`, `DELETE` or
   `TRUNCATE` of an original or an `_old` table (a test scans the file), and the originals stay as
   `<table>_old` until an operator runs `scripts/migration-0026-finalize.mjs`, which reconciles each `_old`
   against its live table row for row (whole-row INTERSECT, kept + quarantined = original, nothing
   live-only, foreign keys on and clean) and only then drops. `scripts/migration-0026-recover.mjs` puts the
   originals back, with every index and trigger recreated verbatim from `_snapshot_0026` (DDL captured
   before anything is dropped).
   Because the originals can no longer be lost, the remaining job is to stop a carrying-on runner from
   leaving a half-swapped database. Tripwires at the top are inserts into CHECK-constrained tables
   (`foreign_keys_must_be_on`, `legacy_alter_table_must_be_off`, `old_tables_from_an_earlier_run_...`,
   `all_six_tenant_tables_must_exist`), so an aborting runner stops with a named error. For a runner that
   carries on, two gate tables are created only when nothing tripped (`CREATE TABLE ... AS SELECT CASE WHEN
   <ok> THEN 1 ELSE abs(-9223372036854775808) END`: the ELSE raises "integer overflow", so no table
   appears); every backfill, quarantine and copy has `AND EXISTS (SELECT 1 FROM _gate_0026_ok)` and fails
   to compile without it, and a view over both gates makes every `ALTER TABLE ... RENAME` fail ("error in
   view ... no such table") until both exist. Known hole: `legacy_alter_table=ON` skips that view check,
   so it is a tripwire for aborting runners and, for a carrying-on one, leaves empty copies swapped in
   with the originals whole in `_old` (recoverable). Tested under three runners (rolled back, aborting,
   carrying on) with foreign keys off, `defer_foreign_keys`, `legacy_alter_table`, a leftover `_old`, a
   sabotaged copy for each of the six tables, a row written after the verify, the process killed after every
   one of the file's statements (with a re-run in every mode afterwards), and recovery from each of those
   states (`tests/migration-0026-matrix.test.ts`). The file is re-runnable once `_old` is finalized or
   restored (scratch is dropped `IF EXISTS`, the quarantine is idempotent, copies are in `rowid` order).
   It carries every column added by 0024 and 0025; the schema-diff test fails when a later migration adds
   one it does not carry. `event_dedup`, `delivery_attempts` and `destination_health` (0025) were already NOT
   NULL with a foreign key and are not rebuilt; each free-text field in the quarantine is cut to 200
   characters.
   **Consequence: the `_old` tables are tenant data at rest** (including orphan rows with v0 credentials) and
   are covered as TEMPORARY in the retention matrix (drop within 7 days), cleared per workspace by the
   purge when present, flagged by a `/health/ready` warning (never a 503), and blocked by the preflight.
   The window still must be a write freeze. `MAINTENANCE_MODE` answers 503 with Retry-After, skips cron and
   hands queue messages back; but `retryAll` consumes a retry (main queue `max_retries` 5 at 300 s: about 25
   minutes, less for a message already retrying), so the runbook makes `wrangler queues pause-delivery` on
   both queues the primary freeze. The dead-letter consumer is now never gated (its queue has
   `max_retries` 1, so handing the message back dropped it before the ledger update).
5. **Recreate** every index and trigger. A schema diff test compares `sqlite_master` before and
   after: columns, defaults, primary keys, every CHECK clause, every index and trigger are identical;
   the only change is `organization_id` becoming NOT NULL with one foreign key (`tests/migration-0026.test.ts`).

The 0008 insert triggers stay: NOT NULL does not reject `''`, and the trigger messages are what callers
see. With cascade, deleting an organization now removes any straggler row in all six tables; the
bounded purge in `src/pipeline/purge.ts` still drains them first so the final delete stays small, and
the last-admin trigger exemption (migration 0011, `purge_started_at`) is unchanged
(`tests/api/workspace-lifecycle.test.ts` passes untouched apart from its helper seeds).

**Accepted exceptions, tested as the complete list:** `audit_events` (NULL organization for a denial
against a workspace that does not exist and for `workspace.purged`; foreign key with cascade present) and
`workspace_deletions` (no foreign key by design).

### B. Static proof that every query is scoped (`tests/security/tenant-query-scope.test.ts`)

The scanner (`tests/support/sql-scope.ts`) parses `src/` with the TypeScript compiler API, resolves SQL
written as literals (template literals, `+`, `${CONST}` interpolation of string constants, and
`${where.join(' AND ')}` over a const array literal, whose **initial** elements are the base predicate),
splits each statement into subquery and `UNION` scopes, and requires, for every SELECT, UPDATE, DELETE
and INSERT ... SELECT on a tenant table, an `organization_id` comparison to a bound value (`?`, `?N`, a
scoped subquery), either directly or through an `a.organization_id = b.organization_id` join to a table
that has one. INSERTs must name `organization_id` in their column list. The set of tenant tables is
**derived from the migrated schema**, not listed, so a new table with an `organization_id` is covered
the day it exists, and a new table without one must be explained in the test (17 are).

An **allowlist of 42 reviewed entries** covers statements that are tenant-agnostic by design: ingress
lookups keyed by a credential (endpoint id, installation id, OAuth state hash) whose row then supplies
the tenant, cron sweeps (KEK rotation, outbox and ledger discovery, stall detection, purge discovery),
age-based retention, and one subquery correlated by primary key to an org-scoped row. Every entry names
a file and a statement fragment, carries a reason, and **fails the test when it stops matching** (no
dead entries). The scanner is tested against 42 fixtures (it flags 26 shapes of unscoped SQL and passes
16 scoped ones) and against real files with their predicates stripped.

**Result: no genuinely unscoped query on tenant data was found.** Everything the scanner flagged was an
intended tenant-agnostic statement. That is a finding, not a placeholder; the value is that the next one
fails the build.

**Limits, stated where the scanner lives:** it cannot see SQL assembled at runtime other than the
patterns above; it proves an organization comparison exists, not that the bound value is the caller's
(the cross-workspace tests and the drill cover that); the few Drizzle queries in
`src/auth/workspace.ts` (membership resolution, keyed by the session's user) are not scanned; comma
joins are refused outright because it does not parse them.

### C. Route registry and route-to-capability test (F232)

`src/auth/route-policy.ts` lists every registered route with one of: a capability, any member, a
signed-in session, a signed webhook (with the verification call it must contain), Better Auth, or public
(`GET /health` only). `tests/security/route-capability.test.ts` compares it with `app.routes` of the
real app (the file that was missing a route fails) and with a parse of the source (a literal registration
that is not in the registry fails), then parses each handler for the guard its entry claims (a
`gate`/`mutationGate`/`authorize` call with that capability literal, a session lookup, a signature
verification). It also proves it can fail: a doctored policy is rejected. `docs/AUTHORIZATION.md` carries
two tables generated from `permissions.ts` and the registry; a test fails when they drift, and
`npm run docs:authorization` rewrites them. Every defined domain capability is enforced by at least one
route and covered by `tests/auth/permissions.test.ts`.

### D. The isolation drill, in two runners over one plan

`scripts/lib/drill-plan.mjs` builds the attack plan from the route registry: as a member of workspace A,
name B (`?org=`), put B's ids in the path, name B's source in a body, and read collection routes. The
fake-D1 suite (`tests/drill/tenant-isolation.test.ts`, 113 tests) runs it in both directions and for a
plain member as well as admins, asserting a 404 (or a 403 only where A's own role lacks the capability),
no B identifier anywhere in the response, **no row changed in either workspace**, and **nothing sent to
B's destination**. A control run proves each request would have succeeded for its owner. Ingress is
drilled too (A's secret on B's endpoint, an unsigned post, an unknown GitHub installation). The same
plan is the staging runner (`scripts/tenant-isolation-drill.mjs`), env-driven, read-only unless asked.

## Consequences

- Cross-workspace data can no longer be written by mistake at the schema level, and a deleted
  organization takes its rows with it.
- A new tenant table, query or route fails a named test until someone decides, and writes down, how it is
  scoped. Allowlist entries are the reviewable list of "unscoped by design".
- Tests that insert tenant rows now seed an `organization` row first (the fake D1 enforces foreign keys,
  as D1 does). Six existing test files were adjusted; one expectation changed from "the dispatcher
  ignores a tenant-less outbox row" to "the schema refuses it".

## Not done, said plainly

- **The backfill is not chunked** (F25 asks for ~1,000-row chunks). Each table is copied in one
  statement. That is acceptable only while the tables are small; no production data exists yet. Before
  applying to a database with a large `deliveries` table, run the pre-flight and the manual chunked
  backfill in `docs/RUNBOOK.md`. The copy itself remains one statement per table.
- **Not run on a real D1.** Atomic rollback of a failed migration, foreign-key behaviour during the
  rebuild, statement-size and time limits are assumptions (**UNVERIFIED**), and the rollback rehearsal
  has not happened. The migration is written not to depend on atomicity (nothing is dropped until finalize, see decision A4), but that
  tripwires, gates and the `pragma_*` functions have never been exercised on D1, and rehearsal on staging is a blocking release item. The runbook
  says how to freeze writers, bookmark, recount, verify and recover.
- **The staging drill has not been run**, nor the Time Travel re-drill; there is no staging environment.
- **Every cross-tenant probe is not audited:** recording is capped at 20 a minute per user by ADR 0019,
  so a scan cannot flood another workspace's log. F233 says every attempt is audited; this is a decision
  to take (REMAINING 1.23), not a silent deviation.
- Repository functions that take the organization as a typed parameter (F26) do not exist; queries are
  inline and checked by the scanner.
- `integrations.repo` is still the routing key for GitHub-bound integrations, narrowed inside the tenant.
