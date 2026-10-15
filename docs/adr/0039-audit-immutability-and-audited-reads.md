# ADR 0039: Audit immutability, audited reads and redaction of audit rows

Status: Accepted · Date: 2026-10-15 · Implements slice 2.22 of [`docs/specs/REMAINING.md`](../specs/REMAINING.md): F236
(`docs/specs/15-security-and-compliance.md`), with the cross-check against F28 (`02`). Builds on [ADR 0019](0019-workspace-switcher-audit-log.md),
[ADR 0028](0028-ingress-contract-and-audit-read.md) and [ADR 0036](0036-credential-destruction-and-boot-hygiene.md).
**Reverses one decision of ADR 0028** (section 4.6, "decided against: auditing reads of the audit log"). No migration.

## Context

F236 asks four things of the audit log: that it is append-only in code, that every read of it is itself audited, that
the metadata is redacted before it is stored, and that a silent stop in writing is detectable. The state before this slice:

- The schema (migration 0008) refuses `UPDATE` with a trigger. It does not refuse `DELETE`, on purpose: organization
  deletion cascades to the log, and the retention purge deletes by age. Nothing in the repository checked the
  application's own statements.
- `GET /api/audit` recorded nothing about itself. ADR 0028 decided against it on the reasoning that a read "changes
  nothing" and that the limiter bounds it. That reasoning answers a different question. A log that no one can see being
  read cannot show who looked at a customer's history, and F236's own acceptance is that "an audit log anyone can read
  is not an audit log".
- Neither the writer nor the reader applied the F12 scrubber. `serialiseMetadata` stored string values as they were given,
  and the reader cut them to length without removing anything. A token or a URL path passed in a value would have been
  stored and returned.
- No heartbeat or completeness counter existed beyond the failed-write counter (`ops_state.audit_write_failures`).

## Decisions

### 1. Append-only is enforced in code, and the enforcement is tested

`tests/security/audit-append-only.test.ts` parses every `.ts`, `.mjs` and `.js` file under `src/` and `scripts/` with the
TypeScript compiler API and reads each string literal, template and interpolation position. A statement that names
`audit_events` after `UPDATE` or `DELETE FROM` must be on an explicit allow-list, with its reason:

| Site | Statement | Why it may run |
| --- | --- | --- |
| `src/pipeline/retention.ts` (`PURGE_AUDIT_SQL`) | literal `DELETE` | The audit retention window (F237). Age only; never a `key.destroy` row. |
| `src/pipeline/purge.ts` (`boundedDeletes`) | interpolated `DELETE FROM ${table}` | The organization purge drains the workspace's rows before its own row is removed. |

No statement `UPDATE`s `audit_events`. Interpolated sites are listed as well (the outbox constant and the expired-auth
tables are shown not to reach it), so a new interpolated statement fails the test until it is reviewed. The test also
fails on a stale entry, and a self-test pins the scanner's own behaviour on synthetic source.

Behaviourally, the migrated schema refuses `UPDATE` (the test asserts it on a row the real writer wrote), and it is pinned
that the schema does **not** refuse `DELETE`. A delete-refusing trigger would break both purges, so it is not a fix
available here; the static test is the guard.

Limits, stated: the scan sees SQL written as literals. A statement assembled from non-literal pieces is seen only through
its trailing keyword. D1 has no per-table grants, so this is convention plus a test, as F236 says.

### 2. Every read of the audit log is an audit row, written before the rows are read

Each `GET /api/audit` that is authorised and within the rate limit writes one `audit.read` row (new action, subject type
`organization`, subject id the workspace, actor the admin, outcome `success`) **before** the query runs, through the same
`auditStatement` every other writer uses (so it carries the request id, and the request IP and user agent as the other
admin actions do).

- **Metadata is names, not values:** `{ filters: [...], continued: boolean }`. `filters` lists the filter fields that were
  set (`action`, `outcome`, `actor`, `target`, `targetType`, `correlationId`, `from`, `to`); their values are never
  recorded. `continued` is true for a later page. The allow-list (`SUMMARY_FIELDS`) shows exactly these two keys.
- **Fail closed.** If the row cannot be written, the read is answered `503` with the same body as any failed read and
  no events (`audit_read_failed`, code `read_not_recorded`). An evidence read that cannot be evidenced is not answered.
- **Refused requests write no read row.** A `403` writes the `access.denied` row it always wrote. A `429` writes nothing:
  no row was read. A `422` (bad filter) returns before the write.
- **Every page is a row.** A later page is recorded as `continued: true`. The count of rows is bounded by the existing
  limit of 120 reads a minute per person (`AUDIT_READS_PER_MINUTE`).
- **Visible to the workspace.** The row is in the workspace's log like any other event, so an admin sees the reads of the
  log, with the names of the filters used. It is tenant-scoped, as all rows are.
- **Retention applies to these rows as to every other row** (`AUDIT_RETENTION_DAYS`, default 365). No new retention class.

This reverses ADR 0028 section 4.6. The cost is accepted and visible: the log grows by one row per read, and each read
of the first page counts itself in `total`. The dashboard fetches once and on an explicit refresh, so it does not write
rows on a timer.

### 3. Secret-shaped text is removed before storage and before display (F12)

- **Writer.** `serialiseMetadata` passes every string value and every string-list item through `scrubSecrets`
  (`src/platform/redact.ts`), and so does the user agent before its 256-character cut. A URL keeps only its scheme and
  host; a bearer or basic credential, a provider token prefix (GitHub, Slack, Stripe-style), a `whsec_` secret and a
  `key=value` or JSON pair whose key is a denied word are replaced with `[redacted]`. Keys are fixed identifiers in the
  code and are not scrubbed.
- **Reader.** `safeText` (every value the summary and the change lines show) scrubs before it cuts, so a row written before
  this change, or by any path that missed the writer, is clean on the way out.
- **Why a new non-truncating function.** `scrubString` cuts after scrubbing, which is right for logs. An audit value must
  keep its whole text or it would be silently shortened. `scrubSecrets` is the same scrubber without the cut; a value past
  the input cap is replaced with a truncation marker, never kept unscrubbed.
- **Tests.** `tests/security/audit-redaction.test.ts` writes fixture secrets (shaped like real ones, none a credential)
  through the writer and asserts the stored row and the stored strings are clean, that a legitimate value is unchanged, and
  that a legacy row written raw is clean in every response. Every string of every read response is checked against the
  scrubber itself.

### 4. Heartbeat and completeness: not done

F236 asks for "a completeness counter and a heartbeat ... so a job that silently stops writing is detectable". This is not
built, and not built on purpose for now:

- No audit write has a fixed cadence. Most rows follow a person's action. A heartbeat row written on a timer would be
  noise in the evidence, and a "no row in the last N minutes" alert would fire on every quiet workspace.
- A real completeness counter needs a per-workspace sequence number on each row, so that a gap is a fact and not a guess.
  That is a column, and a migration with a rollback is needed to add it. This slice does not add a migration.
- What exists is the failed-write counter (`ops_state.audit_write_failures`, read by the readiness check), which counts
  rows that could not be written. It does not count rows that were never attempted. The gap is stated, not closed.

### 5. Left open (F236's remainder, unchanged)

Fail-closed destructive actions (the F236 errors table: revocation, member removal and workspace deletion when the audit
write fails; not reviewed path by path in this slice); non-admin actors; atomic Better Auth member and invitation rows (REMAINING 2.3); export before delete; tamper
evidence (a hash chain or an external sink, which the migration 0008 comment already names as future work).

## Consequences

- **No migration.** The `action` column has no `CHECK`, so `audit.read` needs none. Rows written by this Worker are shown
  by an older Worker as an unknown action with no summary, and an older Worker writes no read rows: a rollback loses only
  the new reads, never data.
- Operators will see `audit.read` volume grow with dashboard use and with any script that pages the log. The 120 reads a
  minute per person stays the bound. A workspace that wants fewer rows should page with filters, not by refreshing.
- The admin's own reads are now evidence about that admin. Customers reading "who viewed my log" will see it, which is
  the point of F236; the dashboard label says "Audit log read", and its detail says "Later page of the same read".
- Vietnamese copy for the two new strings (`audit.action.audit.read`, `audit.detail.continued`) has not been reviewed by a
  native speaker, as with the rest of the audit copy (ADR 0028).

## Verification

Run here, against the fake D1 (Node's built-in SQLite) with the real migrations, through the real Worker routes:

- `tests/security/audit-append-only.test.ts`: the static scan over `src/` and `scripts/` (every allow-list entry is a
  real site, every site is listed), the scanner self-test, and the trigger on the migrated schema.
- `tests/api/audit-read-recorded.test.ts`: the row written per read (names, not values; request id; tenant scope), later
  pages, a refused member, a rate-limited read writing nothing, and a read that cannot be recorded answering 503 with no
  events.
- `tests/security/audit-redaction.test.ts`: writer and reader scrubbing with fixture secrets, and a clean-response check.
- Updated, with the reasons in the test files: `tests/api/audit.test.ts` and `tests/api/audit-read.test.ts` assert the
  seeded rows without the reads they cause, and their totals count the reads exactly; the cursor walk is longer, because
  a read can share a second with the row before it.

Not verified: against a real D1 (the trigger and the `DELETE` behaviour are the SQLite ones, and the D1 error strings are
not observed); the dashboard on a real screen reader; the Vietnamese copy by a person.

## Revisit when

- A per-workspace sequence number on `audit_events` is designed (with its migration and rollback). That is the point at
  which a completeness counter and an `audit_gap` alert can be exact (section 4).
- Customers or a regulator need the reads of the log to be shown to the workspace in a different form, or the read
  volume shows in D1 cost or latency: then batch the rows or coalesce reads per person and minute, and say so here.
- Tamper evidence is asked for: a hash chain, or a copy to a sink outside D1 (the migration 0008 comment names both).
- The purges can move to tombstones or a separate archive, so that a delete-refusing trigger becomes possible.

## Not done

- The completeness counter, the heartbeat and the `audit_gap` alert (section 4).
- The rest of F236 (section 5). The acceptance boxes in F236 stay unticked: the feature is partly built.
