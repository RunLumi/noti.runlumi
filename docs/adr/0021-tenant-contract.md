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
   `row_counts_must_match`, so where D1 aborts a failed file it aborts here, before anything is renamed.
4. **Swap, safe without atomicity.** The Cloudflare migrations, best-practices and limits pages do not say
   whether a file runs in a transaction or whether a failed statement stops it (**UNVERIFIED**; they do
   document 30 seconds per query, 100 KB per statement and chunks of about 1,000 rows for large
   changes). sqlite3's own default carries on after an error, and SQL has no conditional DROP, so the
   first version of this file (verify, then DROP, then RENAME) could drop an original after a failed
   verify, and could lose a row written by a live Worker between the copy and the DROP. The file is
   now structured so that no failure, and no concurrent write, can destroy the original: the original is
   RENAMED aside (`<table>_old`), the verified copy takes its name, and `DROP TABLE <table>_old` is
   guarded by a temporary foreign key (a one-row child table pointing at the original) that is released
   only by a `DELETE ... WHERE` that recounts the original against the copy at that moment. A mismatch,
   a late row or an earlier failure leaves the guard, and the DROP itself errors with `FOREIGN KEY
   constraint failed`, leaving every original row in `<table>_old`. The mechanism assumes D1 enforces
   foreign keys (its documented default; **UNVERIFIED** here). Tests run the file under three runners:
   inside a transaction, stopping at the first error with no wrapper, and carrying on after errors,
   each with a sabotaged copy and with a row written after the verify. The file is also re-runnable: its
   scratch objects are dropped `IF EXISTS`, the quarantine is idempotent, copies are in `rowid` order
   (`src/api/deliveries.ts` reads rowid as recency). It carries every column added by 0024 (`integrations.credential_fingerprint`) and 0025 (`deliveries.duplicate_of`, `suppressed_reason`, `possible_duplicate`, `provider_message_id`, with their CHECKs); the schema-diff test over the whole chain fails when a later migration adds one it does not carry. `event_dedup`, `delivery_attempts` and `destination_health` (0025) were already NOT NULL with a foreign key and are not rebuilt; attempt rows of a quarantined delivery are removed later as orphans by the retention job (ADR 0023), and each free-text field in the quarantine is cut to
   200 characters (a 2,400-character legacy repo previously overflowed the record's CHECK).
   It must still run in a write freeze: `MAINTENANCE_MODE=true` answers 503 with Retry-After on every route
   but the probes, skips cron and retries queue batches. A late row would be refused by the guard, but the
   live Worker would then be running on an incomplete table until an operator restored from Time Travel.
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
  has not happened. The migration is written not to depend on atomicity (the DROP is guarded, see decision A4), but that
  guard has never been exercised on D1, and rehearsal on staging is a blocking release item. The runbook
  says how to freeze writers, bookmark, recount, verify and recover.
- **The staging drill has not been run**, nor the Time Travel re-drill; there is no staging environment.
- **Every cross-tenant probe is not audited:** recording is capped at 20 a minute per user by ADR 0019,
  so a scan cannot flood another workspace's log. F233 says every attempt is audited; this is a decision
  to take (REMAINING 1.23), not a silent deviation.
- Repository functions that take the organization as a typed parameter (F26) do not exist; queries are
  inline and checked by the scanner.
- `integrations.repo` is still the routing key for GitHub-bound integrations, narrowed inside the tenant.
