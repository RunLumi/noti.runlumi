-- =============================================================================
-- 0026 — Tenant contract: NOT NULL + foreign key on organization_id
--        (docs/adr/0021, docs/specs/02 F25, docs/specs/15 F233)
-- =============================================================================
-- Until now only NEW writes were forced to carry an organization (insert triggers from 0008,
-- NOT NULL on later tables); legacy rows could still hold NULL, and six tables had no foreign
-- key to organization(id), so a dangling id was representable. This is the CONTRACT step of
-- expand / backfill / contract (0006 expanded, 0008 added triggers):
--
--   integrations, deliveries, notification_outbox   organization_id TEXT  (nullable, no FK)
--   held_events, routing_decisions, noise_open_failures  organization_id TEXT NOT NULL (no FK)
--      become   organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE
--
-- THIS FILE NEVER DESTROYS AN ORIGINAL. It contains no DROP, DELETE or TRUNCATE of any of the six
-- tables or of `<table>_old` (tests/migration-0026.test.ts scans for that). Each original is
-- RENAMED aside to `<table>_old` and STAYS there, with every row it held, until an operator
-- finalizes with scripts/migration-0026-finalize.mjs after reconciling `_old` against the live table
-- row for row (docs/RUNBOOK.md). The first version of this file dropped `<table>_old` behind a
-- foreign-key guard; that guard was defeatable (a runner that carries on after an error re-ran the
-- file over a leftover `_old`; foreign keys off; `PRAGMA defer_foreign_keys`), so the DROP was
-- removed instead of defended.
--
-- WHAT D1 DOES WITH A FILE THAT FAILS PART WAY IS NOT DOCUMENTED (the Cloudflare migrations,
-- best-practices and limits pages say nothing about per-file transactions or abort-on-error;
-- UNVERIFIED, see docs/adr/0021). sqlite3's own default is to carry on after an error. So the file
-- is written to be safe in BOTH worlds:
--
--   * Tripwires first (section 0). Each is an INSERT into a CHECK-constrained table, so a runner
--     that aborts on error stops there with a named constraint in the message:
--       foreign_keys_must_be_on                       PRAGMA foreign_keys is not 1
--       legacy_alter_table_must_be_off                PRAGMA legacy_alter_table is not 0
--       old_tables_from_an_earlier_run_...            a `<table>_old` already exists
--       all_six_tenant_tables_must_exist              a live table is missing (half-applied state)
--   * A runner that CARRIES ON must not run the dependents of a tripped wire. Two gates do that:
--       _gate_0026_ok        created by `CREATE TABLE ... AS SELECT CASE WHEN <every tripwire passes>
--                            THEN 1 ELSE abs(-9223372036854775808) END`: the ELSE branch raises
--                            "integer overflow" at run time, so the table EXISTS only if nothing
--                            tripped. Every backfill, quarantine and copy statement has
--                            `AND EXISTS (SELECT 1 FROM _gate_0026_ok)`: with no such table it fails
--                            to compile and touches nothing.
--       _gate_0026_verified  the same trick over the count verification (section 4).
--     Every ALTER TABLE ... RENAME is blocked until both exist: the view `_gate_0026_poison` selects
--     from them, and SQLite refuses a RENAME while any view in the schema references a missing table
--     ("error in view _gate_0026_poison: no such table"). (PRAGMA legacy_alter_table=ON skips that
--     check; it is a tripwire.) A tripped file therefore renames nothing and copies nothing.
--   * Re-running is safe. Scratch objects are dropped IF EXISTS first; the quarantine is
--     idempotent; every copy is rebuilt from the live table. Over a leftover `<table>_old` the
--     tripwire fires and nothing else runs: restore or finalize first (docs/RUNBOOK.md).
--   * It still must run in a write freeze (docs/RUNBOOK.md): a row written between the copy and the
--     swap would be missing from the new table. The swap-time recount (`_swap_verify`) and the
--     finalize step both detect that; the row itself is safe in `<table>_old`.
--
-- Steps, in order:
--   0. Hygiene for a re-run, tripwires, gates, quarantine table, snapshot of every index and trigger
--      about to be dropped (so recovery can recreate them verbatim).
--   1. BACKFILL only where the tenant is DERIVABLE from our own rows, never guessed:
--        integrations          <- its source (sources.organization_id), when it has a source_id
--        deliveries            <- the integration they were routed to
--        notification_outbox   <- the delivery with the same id, else the integration named in
--                                 the payload
--      Nothing is ever assigned from a repository name or any sender-supplied field: that is
--      the defect (D3) the tenant boundary exists to remove. An id that differs from an
--      organization id only by case is NOT corrected (that would be a guess): it is quarantined.
--   2. QUARANTINE every row that still has no valid organization (NULL, empty, or an id with no
--      organization row). Such a row was already unroutable and unreachable through every API
--      (all of them are organization-scoped). It is recorded in `legacy_orphaned_rows` with
--      NON-SECRET metadata only (no ciphertext, no key material, no event payload; every
--      free-text field cut to 200 characters so the record cannot be refused for being long).
--      The row itself leaves the live table, but it is NOT deleted: it stays, credentials and
--      payload included, in `<table>_old` until finalize (a temporary table, docs/DATA_RETENTION.md),
--      and afterwards only through D1 Time Travel.
--   3. BUILD the replacement tables with the constraint and copy every surviving row in rowid
--      order (rowid is used as recency by src/api/deliveries.ts).
--   4. VERIFY: a failing INSERT into a CHECK-constrained table (`row_counts_must_match`) aborts
--      the file where D1 aborts on error, and `_gate_0026_verified` keeps every rename blocked
--      where it does not.
--   5. SWAP per table: rename the original aside (`<table>_old`), rename the copy into place, move
--      the indexes and triggers (those on the original follow the rename and would collide, so they
--      are dropped from `<table>_old`; they are in `_snapshot_0026`), create them on the new table.
--   6. VERIFY THE SWAP and remove the scratch objects (never an `_old` table).
--
-- Every column, default, CHECK, index and trigger that 0001..0025 gave these tables is carried
-- over in the same column order (tests/migration-0026.test.ts diffs sqlite_master before and
-- after and fails on any difference other than the intended constraint). The insert triggers
-- are kept: NOT NULL does not reject '' and the trigger messages are what callers see.
-- sources_delete_integrations is a trigger on `sources` that names `integrations`; SQLite
-- rewrites such triggers when a table is renamed, so it is dropped and recreated straight after
-- the integrations rename (see 0018).
--
-- Nothing references these tables by foreign key, and the new foreign keys point AT organization.
-- With ON DELETE CASCADE, deleting an organization now removes its rows even if the explicit
-- bounded purge (src/pipeline/purge.ts) has not drained them; the purge still drains them first,
-- in bounded batches, and also clears any `_old` rows of that organization.
--
-- SIZE: each table is copied in one statement. D1 documents a 30 second limit per query and
-- warns that one statement touching hundreds of thousands of rows exceeds it; apply only below
-- the ceiling in docs/RUNBOOK.md (purge deliveries by retention first).
--
-- ROLLBACK: restore with scripts/migration-0026-recover.mjs (renames each `<table>_old` back and
-- recreates the indexes and triggers from `_snapshot_0026`), valid only until traffic has resumed
-- on the new tables; after that, D1 Time Travel to the bookmark taken BEFORE applying
-- (docs/RUNBOOK.md). Removed orphan rows are in `<table>_old` until finalize.
-- =============================================================================

-- --- 0. hygiene for a re-run, tripwires, gates --------------------------------
-- The poison-view gate below relies on SQLite's modern ALTER TABLE ... RENAME, which checks every view
-- and trigger. The sqlite3 shell defaults to the legacy behaviour (no check), so say so explicitly; D1
-- documents this pragma. The tripwire further down still verifies it took effect (a runner that ignores
-- pragmas fails there).
PRAGMA legacy_alter_table=OFF;

-- Scratch only: copies, verification rows, tripwire tables, gates, and the guard tables of the first
-- version of this file. NEVER a `<table>_old`, never `_snapshot_0026`.
DROP VIEW IF EXISTS _gate_0026_poison;
DROP TABLE IF EXISTS _gate_0026_ok;
DROP TABLE IF EXISTS _gate_0026_verified;
DROP TABLE IF EXISTS _fk_required;
DROP TABLE IF EXISTS _alter_mode;
DROP TABLE IF EXISTS _old_absent;
DROP TABLE IF EXISTS _live_present;
DROP TABLE IF EXISTS _contract_verify;
DROP TABLE IF EXISTS _swap_verify;
DROP TABLE IF EXISTS _guard_integrations;
DROP TABLE IF EXISTS integrations_v4;
DROP TABLE IF EXISTS _guard_deliveries;
DROP TABLE IF EXISTS deliveries_v4;
DROP TABLE IF EXISTS _guard_notification_outbox;
DROP TABLE IF EXISTS notification_outbox_v4;
DROP TABLE IF EXISTS _guard_held_events;
DROP TABLE IF EXISTS held_events_v4;
DROP TABLE IF EXISTS _guard_routing_decisions;
DROP TABLE IF EXISTS routing_decisions_v4;
DROP TABLE IF EXISTS _guard_noise_open_failures;
DROP TABLE IF EXISTS noise_open_failures_v4;

-- While either gate table is missing, every ALTER TABLE ... RENAME in this database fails.
CREATE VIEW _gate_0026_poison AS SELECT 1 FROM _gate_0026_ok, _gate_0026_verified;

-- Tripwire: foreign keys must be enforced (the new constraints and the cascade rely on it).
CREATE TABLE _fk_required (
  on_ INTEGER NOT NULL CONSTRAINT foreign_keys_must_be_on CHECK (on_ = 1)
);
INSERT INTO _fk_required SELECT foreign_keys FROM pragma_foreign_keys;
DROP TABLE _fk_required;

-- Tripwire: legacy ALTER TABLE behaviour skips the schema check the gate relies on.
CREATE TABLE _alter_mode (
  legacy INTEGER NOT NULL CONSTRAINT legacy_alter_table_must_be_off CHECK (legacy = 0)
);
INSERT INTO _alter_mode SELECT legacy_alter_table FROM pragma_legacy_alter_table;
DROP TABLE _alter_mode;

-- Tripwire: an `_old` table means an earlier run left the originals aside. Finalize or restore first.
CREATE TABLE _old_absent (
  n INTEGER NOT NULL CONSTRAINT old_tables_from_an_earlier_run_must_be_finalized_or_restored_first CHECK (n = 0)
);
INSERT INTO _old_absent
SELECT COUNT(*) FROM sqlite_master
WHERE type = 'table' AND name IN
  ('integrations_old','deliveries_old','notification_outbox_old','held_events_old','routing_decisions_old','noise_open_failures_old');
DROP TABLE _old_absent;

-- Tripwire: all six live tables exist (a half-applied earlier run has renamed one away).
CREATE TABLE _live_present (
  n INTEGER NOT NULL CONSTRAINT all_six_tenant_tables_must_exist CHECK (n = 6)
);
INSERT INTO _live_present
SELECT COUNT(*) FROM sqlite_master
WHERE type = 'table' AND name IN
  ('integrations','deliveries','notification_outbox','held_events','routing_decisions','noise_open_failures');
DROP TABLE _live_present;

-- The gate: exists only if every tripwire above holds right now. abs(-9223372036854775808) raises
-- "integer overflow", which fails the statement and creates nothing.
CREATE TABLE _gate_0026_ok AS
SELECT CASE WHEN (SELECT foreign_keys FROM pragma_foreign_keys) = 1
             AND (SELECT legacy_alter_table FROM pragma_legacy_alter_table) = 0
             AND (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN
                   ('integrations_old','deliveries_old','notification_outbox_old','held_events_old','routing_decisions_old','noise_open_failures_old')) = 0
             AND (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN
                   ('integrations','deliveries','notification_outbox','held_events','routing_decisions','noise_open_failures')) = 6
            THEN 1 ELSE abs(-9223372036854775808) END AS ok;

CREATE TABLE IF NOT EXISTS legacy_orphaned_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_table TEXT NOT NULL CHECK(source_table IN
    ('integrations','deliveries','notification_outbox','held_events','routing_decisions','noise_open_failures')),
  row_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('organization_missing','organization_not_found')),
  detail_json TEXT NOT NULL CHECK(json_valid(detail_json) AND length(detail_json) <= 2048),
  quarantined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS legacy_orphaned_rows_table ON legacy_orphaned_rows(source_table, quarantined_at);

-- Every index and trigger this file is about to drop and recreate, verbatim, so recovery
-- (scripts/migration-0026-recover.mjs) can put them back on a restored original. DDL only: no tenant data.
-- Rows are replaced only while the gate is open (a tripped re-run never overwrites the snapshot that a
-- restore needs), but missing rows are ALWAYS added (INSERT OR IGNORE), so the snapshot is never empty even
-- when a tripwire fired.
CREATE TABLE IF NOT EXISTS _snapshot_0026 (
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  tbl_name TEXT NOT NULL,
  sql TEXT NOT NULL,
  PRIMARY KEY (type, name)
);
DELETE FROM _snapshot_0026 WHERE EXISTS (SELECT 1 FROM _gate_0026_ok);
INSERT OR IGNORE INTO _snapshot_0026(type, name, tbl_name, sql)
SELECT type, name, tbl_name, sql FROM sqlite_master
WHERE type IN ('index','trigger') AND sql IS NOT NULL
  AND (tbl_name IN ('integrations','deliveries','notification_outbox','held_events','routing_decisions','noise_open_failures')
       OR name = 'sources_delete_integrations');

-- --- 1. backfill (derivable tenants only) ------------------------------------
UPDATE integrations
SET organization_id = (SELECT s.organization_id FROM sources s WHERE s.id = integrations.source_id)
WHERE (organization_id IS NULL OR organization_id = '')
  AND source_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM sources s WHERE s.id = integrations.source_id)
  AND EXISTS (SELECT 1 FROM _gate_0026_ok);

UPDATE deliveries
SET organization_id = (
  SELECT i.organization_id FROM integrations i
  WHERE i.id = deliveries.integration_id AND i.organization_id IS NOT NULL AND i.organization_id <> '')
WHERE (organization_id IS NULL OR organization_id = '')
  AND EXISTS (
    SELECT 1 FROM integrations i
    WHERE i.id = deliveries.integration_id AND i.organization_id IS NOT NULL AND i.organization_id <> '')
  AND EXISTS (SELECT 1 FROM _gate_0026_ok);

UPDATE notification_outbox
SET organization_id = COALESCE(
  (SELECT d.organization_id FROM deliveries d
   WHERE d.id = notification_outbox.id AND d.organization_id IS NOT NULL AND d.organization_id <> ''),
  (SELECT i.organization_id FROM integrations i
   WHERE i.id = CASE WHEN json_valid(notification_outbox.payload_json)
                     THEN json_extract(notification_outbox.payload_json, '$.integrationId') END
     AND i.organization_id IS NOT NULL AND i.organization_id <> ''))
WHERE (organization_id IS NULL OR organization_id = '')
  AND EXISTS (SELECT 1 FROM _gate_0026_ok);


-- --- 2. quarantine what is left (metadata only; idempotent) ------------------
INSERT INTO legacy_orphaned_rows(source_table, row_id, reason, detail_json)
SELECT 'integrations', id,
  CASE WHEN organization_id IS NULL OR organization_id = '' THEN 'organization_missing' ELSE 'organization_not_found' END,
  json_object('repo', substr(repo, 1, 200), 'destination', substr(destination, 1, 200), 'enabled', enabled, 'name', substr(name, 1, 200),
              'created_at', substr(created_at, 1, 200), 'source_id', substr(source_id, 1, 200))
FROM integrations
WHERE (organization_id IS NULL OR organization_id = ''
   OR NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = integrations.organization_id))
  AND NOT EXISTS (SELECT 1 FROM legacy_orphaned_rows q WHERE q.source_table = 'integrations' AND q.row_id = integrations.id)
  AND EXISTS (SELECT 1 FROM _gate_0026_ok);

INSERT INTO legacy_orphaned_rows(source_table, row_id, reason, detail_json)
SELECT 'deliveries', id,
  CASE WHEN organization_id IS NULL OR organization_id = '' THEN 'organization_missing' ELSE 'organization_not_found' END,
  json_object('integration_id', substr(integration_id, 1, 200), 'state', substr(state, 1, 200), 'attempts', attempts,
              'created_at', substr(created_at, 1, 200), 'updated_at', substr(updated_at, 1, 200), 'last_error_code', substr(last_error_code, 1, 200))
FROM deliveries
WHERE (organization_id IS NULL OR organization_id = ''
   OR NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = deliveries.organization_id))
  AND NOT EXISTS (SELECT 1 FROM legacy_orphaned_rows q WHERE q.source_table = 'deliveries' AND q.row_id = deliveries.id)
  AND EXISTS (SELECT 1 FROM _gate_0026_ok);

INSERT INTO legacy_orphaned_rows(source_table, row_id, reason, detail_json)
SELECT 'notification_outbox', id,
  CASE WHEN organization_id IS NULL OR organization_id = '' THEN 'organization_missing' ELSE 'organization_not_found' END,
  json_object('state', substr(state, 1, 200), 'created_at', substr(created_at, 1, 200), 'last_error_code', substr(last_error_code, 1, 200))
FROM notification_outbox
WHERE (organization_id IS NULL OR organization_id = ''
   OR NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = notification_outbox.organization_id))
  AND NOT EXISTS (SELECT 1 FROM legacy_orphaned_rows q WHERE q.source_table = 'notification_outbox' AND q.row_id = notification_outbox.id)
  AND EXISTS (SELECT 1 FROM _gate_0026_ok);

INSERT INTO legacy_orphaned_rows(source_table, row_id, reason, detail_json)
SELECT 'held_events', id,
  'organization_not_found',
  json_object('integration_id', substr(integration_id, 1, 200), 'state', substr(state, 1, 200), 'held_at', held_at, 'event_type', substr(event_type, 1, 200))
FROM held_events
WHERE (organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = held_events.organization_id))
  AND NOT EXISTS (SELECT 1 FROM legacy_orphaned_rows q WHERE q.source_table = 'held_events' AND q.row_id = held_events.id)
  AND EXISTS (SELECT 1 FROM _gate_0026_ok);

INSERT INTO legacy_orphaned_rows(source_table, row_id, reason, detail_json)
SELECT 'routing_decisions', id,
  'organization_not_found',
  json_object('integration_id', substr(integration_id, 1, 200), 'event_type', substr(event_type, 1, 200), 'outcome', substr(outcome, 1, 200),
              'decided_at', decided_at)
FROM routing_decisions
WHERE (organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = routing_decisions.organization_id))
  AND NOT EXISTS (SELECT 1 FROM legacy_orphaned_rows q WHERE q.source_table = 'routing_decisions' AND q.row_id = routing_decisions.id)
  AND EXISTS (SELECT 1 FROM _gate_0026_ok);

INSERT INTO legacy_orphaned_rows(source_table, row_id, reason, detail_json)
SELECT 'noise_open_failures', CAST(id AS TEXT),
  'organization_not_found',
  json_object('integration_id', substr(integration_id, 1, 200), 'opened_at', opened_at)
FROM noise_open_failures
WHERE (organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = noise_open_failures.organization_id))
  AND NOT EXISTS (SELECT 1 FROM legacy_orphaned_rows q WHERE q.source_table = 'noise_open_failures' AND q.row_id = CAST(noise_open_failures.id AS TEXT))
  AND EXISTS (SELECT 1 FROM _gate_0026_ok);

-- --- 3. rebuild with the constraint -------------------------------------------
CREATE TABLE integrations_v4 (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  event_types TEXT NOT NULL,
  destination TEXT NOT NULL CHECK(destination IN ('lark','slack','teams','discord','generic_webhook')),
  webhook_ciphertext TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  lark_secret_ciphertext TEXT,
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  key_salt BLOB,
  dek_wrapped BLOB,
  kek_version INTEGER,
  webhook_envelope BLOB,
  lark_secret_envelope BLOB,
  credentials_quarantined_at TEXT,
  credentials_quarantine_reason TEXT,
  name TEXT,
  destination_host TEXT,
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT,
  filters_json TEXT
  CHECK(filters_json IS NULL OR (json_valid(filters_json) AND length(filters_json) <= 8192)),
  source_id TEXT,
  noise_json TEXT
  CHECK(noise_json IS NULL OR (json_valid(noise_json) AND length(noise_json) <= 2048)),
  credential_fingerprint TEXT
);

INSERT INTO integrations_v4(
  id,repo,event_types,destination,webhook_ciphertext,enabled,lark_secret_ciphertext,
  organization_id,key_salt,dek_wrapped,kek_version,webhook_envelope,lark_secret_envelope,
  credentials_quarantined_at,credentials_quarantine_reason,
  name,destination_host,created_by,created_at,updated_at,filters_json,source_id,noise_json,credential_fingerprint)
SELECT
  id,repo,event_types,destination,webhook_ciphertext,enabled,lark_secret_ciphertext,
  organization_id,key_salt,dek_wrapped,kek_version,webhook_envelope,lark_secret_envelope,
  credentials_quarantined_at,credentials_quarantine_reason,
  name,destination_host,created_by,created_at,updated_at,filters_json,source_id,noise_json,credential_fingerprint
FROM integrations
WHERE organization_id IS NOT NULL AND organization_id <> ''
  AND EXISTS (SELECT 1 FROM organization o WHERE o.id = integrations.organization_id)
  AND EXISTS (SELECT 1 FROM _gate_0026_ok)
ORDER BY rowid;

CREATE TABLE deliveries_v4 (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','sent','accepted','retrying','dead_lettered','suppressed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  last_error_code TEXT,
  dedup_key TEXT,
  replay_of TEXT,
  replay_count INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  claimed_at INTEGER,
  next_attempt_at INTEGER,
  first_attempt_at INTEGER,
  last_attempt_at INTEGER,
  dead_lettered_at INTEGER,
  created_at TEXT,
  body_hash TEXT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK(is_test IN (0,1)),
  duplicate_of TEXT,
  suppressed_reason TEXT
  CHECK(suppressed_reason IS NULL OR suppressed_reason IN ('duplicate','claim_conflict','provider_idempotency')),
  possible_duplicate INTEGER NOT NULL DEFAULT 0 CHECK(possible_duplicate IN (0,1)),
  provider_message_id TEXT
  CHECK(provider_message_id IS NULL OR length(provider_message_id) <= 200)
);

INSERT INTO deliveries_v4(
  id,integration_id,state,attempts,last_error,updated_at,organization_id,last_error_code,dedup_key,
  replay_of,replay_count,claim_token,claimed_at,next_attempt_at,first_attempt_at,last_attempt_at,
  dead_lettered_at,created_at,body_hash,is_test,duplicate_of,suppressed_reason,possible_duplicate,
  provider_message_id)
SELECT
  id,integration_id,state,attempts,last_error,updated_at,organization_id,last_error_code,dedup_key,
  replay_of,replay_count,claim_token,claimed_at,next_attempt_at,first_attempt_at,last_attempt_at,
  dead_lettered_at,created_at,body_hash,is_test,duplicate_of,suppressed_reason,possible_duplicate,
  provider_message_id
FROM deliveries
WHERE organization_id IS NOT NULL AND organization_id <> ''
  AND EXISTS (SELECT 1 FROM organization o WHERE o.id = deliveries.organization_id)
  AND EXISTS (SELECT 1 FROM _gate_0026_ok)
ORDER BY rowid;

CREATE TABLE notification_outbox_v4 (
  id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','dispatched','invalid')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dispatched_at TEXT,
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  claimed_at INTEGER,
  lease_token TEXT,
  lease_expires_at INTEGER,
  not_before INTEGER,
  last_error_code TEXT
);

INSERT INTO notification_outbox_v4(
  id,payload_json,state,created_at,dispatched_at,organization_id,claimed_at,lease_token,
  lease_expires_at,not_before,last_error_code)
SELECT
  id,payload_json,state,created_at,dispatched_at,organization_id,claimed_at,lease_token,
  lease_expires_at,not_before,last_error_code
FROM notification_outbox
WHERE organization_id IS NOT NULL AND organization_id <> ''
  AND EXISTS (SELECT 1 FROM organization o WHERE o.id = notification_outbox.organization_id)
  AND EXISTS (SELECT 1 FROM _gate_0026_ok)
ORDER BY rowid;

CREATE TABLE held_events_v4 (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL,
  hold_reason TEXT NOT NULL CHECK(hold_reason IN ('quiet_hours','digest','grouped')),
  group_key TEXT NOT NULL CHECK(length(group_key) = 32),
  state TEXT NOT NULL DEFAULT 'held' CHECK(state IN ('held','claimed','released','failed')),
  release_at INTEGER NOT NULL,
  held_at INTEGER NOT NULL,
  claim_token TEXT,
  claim_expires_at INTEGER,
  -- Poison-row handling: each failed or abandoned release attempt counts; the row is not due again
  -- until retry_after, and after 5 attempts it becomes 'failed' (kept, visible, never released).
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error_class TEXT CHECK(last_error_class IS NULL OR length(last_error_class) <= 40),
  retry_after INTEGER NOT NULL DEFAULT 0,
  released_at INTEGER,
  released_in TEXT,
  event_type TEXT NOT NULL CHECK(length(event_type) <= 100),
  title TEXT NOT NULL CHECK(length(title) <= 300),
  url TEXT NOT NULL CHECK(length(url) <= 1000),
  repo TEXT NOT NULL CHECK(length(repo) <= 200),
  actor TEXT NOT NULL CHECK(length(actor) <= 100),
  status TEXT NOT NULL CHECK(status IN ('success','failure','warning','info')),
  summary TEXT NOT NULL CHECK(length(summary) <= 280),
  resolved INTEGER NOT NULL DEFAULT 0 CHECK(resolved IN (0,1))
);

INSERT INTO held_events_v4(
  id,organization_id,integration_id,hold_reason,group_key,state,release_at,held_at,claim_token,
  claim_expires_at,attempts,last_error_class,retry_after,released_at,released_in,event_type,title,url,
  repo,actor,status,summary,resolved)
SELECT
  id,organization_id,integration_id,hold_reason,group_key,state,release_at,held_at,claim_token,
  claim_expires_at,attempts,last_error_class,retry_after,released_at,released_in,event_type,title,url,
  repo,actor,status,summary,resolved
FROM held_events
WHERE organization_id <> '' AND EXISTS (SELECT 1 FROM organization o WHERE o.id = held_events.organization_id)
  AND EXISTS (SELECT 1 FROM _gate_0026_ok)
ORDER BY rowid;

CREATE TABLE routing_decisions_v4 (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('delivered','filtered')),
  filter_id TEXT,
  reason TEXT NOT NULL,
  unknown_fact INTEGER NOT NULL DEFAULT 0 CHECK(unknown_fact IN (0,1)),
  decided_at INTEGER NOT NULL,
  CHECK(outcome = 'delivered' OR filter_id IS NOT NULL)
);

INSERT INTO routing_decisions_v4(
  id,organization_id,integration_id,event_type,outcome,filter_id,reason,unknown_fact,decided_at)
SELECT
  id,organization_id,integration_id,event_type,outcome,filter_id,reason,unknown_fact,decided_at
FROM routing_decisions
WHERE organization_id <> '' AND EXISTS (SELECT 1 FROM organization o WHERE o.id = routing_decisions.organization_id)
  AND EXISTS (SELECT 1 FROM _gate_0026_ok)
ORDER BY rowid;

CREATE TABLE noise_open_failures_v4 (
  id INTEGER PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL,
  key_hash TEXT NOT NULL CHECK(length(key_hash) = 32),
  opened_at INTEGER NOT NULL,
  UNIQUE(organization_id, integration_id, key_hash)
);

INSERT INTO noise_open_failures_v4(id,organization_id,integration_id,key_hash,opened_at)
SELECT id,organization_id,integration_id,key_hash,opened_at
FROM noise_open_failures
WHERE organization_id <> '' AND EXISTS (SELECT 1 FROM organization o WHERE o.id = noise_open_failures.organization_id)
  AND EXISTS (SELECT 1 FROM _gate_0026_ok);

-- --- 4. verify the copy against the live original (loud: aborts where D1 aborts) ---
-- One INSERT per row: workerd's SQLite allows at most 5 compound SELECT terms (node:sqlite allows 500, so
-- tests/migration-0026-d1.test.ts runs the real `wrangler d1 migrations apply --local`).
CREATE TABLE _contract_verify (
  tbl TEXT NOT NULL,
  balanced INTEGER NOT NULL CONSTRAINT row_counts_must_match CHECK(balanced = 1)
);
INSERT INTO _contract_verify(tbl, balanced)
SELECT 'integrations',
  (SELECT COUNT(*) FROM integrations) = (SELECT COUNT(*) FROM integrations_v4) + (SELECT COUNT(*) FROM integrations o WHERE o.organization_id IS NULL OR o.organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization g WHERE g.id = o.organization_id))
  AND NOT EXISTS (SELECT 1 FROM integrations o WHERE (o.organization_id IS NULL OR o.organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization g WHERE g.id = o.organization_id))
    AND NOT EXISTS (SELECT 1 FROM legacy_orphaned_rows q WHERE q.source_table = 'integrations' AND q.row_id = o.id));
INSERT INTO _contract_verify(tbl, balanced)
SELECT 'deliveries',
  (SELECT COUNT(*) FROM deliveries) = (SELECT COUNT(*) FROM deliveries_v4) + (SELECT COUNT(*) FROM deliveries o WHERE o.organization_id IS NULL OR o.organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization g WHERE g.id = o.organization_id))
  AND NOT EXISTS (SELECT 1 FROM deliveries o WHERE (o.organization_id IS NULL OR o.organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization g WHERE g.id = o.organization_id))
    AND NOT EXISTS (SELECT 1 FROM legacy_orphaned_rows q WHERE q.source_table = 'deliveries' AND q.row_id = o.id));
INSERT INTO _contract_verify(tbl, balanced)
SELECT 'notification_outbox',
  (SELECT COUNT(*) FROM notification_outbox) = (SELECT COUNT(*) FROM notification_outbox_v4) + (SELECT COUNT(*) FROM notification_outbox o WHERE o.organization_id IS NULL OR o.organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization g WHERE g.id = o.organization_id))
  AND NOT EXISTS (SELECT 1 FROM notification_outbox o WHERE (o.organization_id IS NULL OR o.organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization g WHERE g.id = o.organization_id))
    AND NOT EXISTS (SELECT 1 FROM legacy_orphaned_rows q WHERE q.source_table = 'notification_outbox' AND q.row_id = o.id));
INSERT INTO _contract_verify(tbl, balanced)
SELECT 'held_events',
  (SELECT COUNT(*) FROM held_events) = (SELECT COUNT(*) FROM held_events_v4) + (SELECT COUNT(*) FROM held_events o WHERE o.organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization g WHERE g.id = o.organization_id))
  AND NOT EXISTS (SELECT 1 FROM held_events o WHERE (o.organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization g WHERE g.id = o.organization_id))
    AND NOT EXISTS (SELECT 1 FROM legacy_orphaned_rows q WHERE q.source_table = 'held_events' AND q.row_id = o.id));
INSERT INTO _contract_verify(tbl, balanced)
SELECT 'routing_decisions',
  (SELECT COUNT(*) FROM routing_decisions) = (SELECT COUNT(*) FROM routing_decisions_v4) + (SELECT COUNT(*) FROM routing_decisions o WHERE o.organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization g WHERE g.id = o.organization_id))
  AND NOT EXISTS (SELECT 1 FROM routing_decisions o WHERE (o.organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization g WHERE g.id = o.organization_id))
    AND NOT EXISTS (SELECT 1 FROM legacy_orphaned_rows q WHERE q.source_table = 'routing_decisions' AND q.row_id = o.id));
INSERT INTO _contract_verify(tbl, balanced)
SELECT 'noise_open_failures',
  (SELECT COUNT(*) FROM noise_open_failures) = (SELECT COUNT(*) FROM noise_open_failures_v4) + (SELECT COUNT(*) FROM noise_open_failures o WHERE o.organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization g WHERE g.id = o.organization_id))
  AND NOT EXISTS (SELECT 1 FROM noise_open_failures o WHERE (o.organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization g WHERE g.id = o.organization_id))
    AND NOT EXISTS (SELECT 1 FROM legacy_orphaned_rows q WHERE q.source_table = 'noise_open_failures' AND q.row_id = CAST(o.id AS TEXT)));

-- Second gate. Exists only if all six rows above were inserted, i.e. every balance held. If the INSERT
-- above failed (so _contract_verify is empty) the CASE raises and the table is not created.
CREATE TABLE _gate_0026_verified AS
SELECT CASE WHEN (SELECT COUNT(*) FROM _contract_verify WHERE balanced = 1) = 6
            THEN 1 ELSE abs(-9223372036854775808) END AS ok;
DROP TABLE _contract_verify;

-- --- 5. swap, table by table. Originals are renamed aside and KEPT as `<table>_old` --------
-- Every ALTER TABLE ... RENAME below fails unless _gate_0026_ok and _gate_0026_verified exist.

-- integrations
ALTER TABLE integrations RENAME TO integrations_old;
ALTER TABLE integrations_v4 RENAME TO integrations;
-- The rename rewrote this trigger to name integrations_old; recreate it on the new table at once.
DROP TRIGGER IF EXISTS sources_delete_integrations;
CREATE TRIGGER sources_delete_integrations
AFTER DELETE ON sources
BEGIN
  DELETE FROM integrations WHERE source_id = OLD.id AND organization_id = OLD.organization_id;
END;
DROP INDEX IF EXISTS integrations_repo;
DROP INDEX IF EXISTS integrations_org_idx;
DROP INDEX IF EXISTS integrations_kek_version;
DROP INDEX IF EXISTS integrations_org_created;
DROP INDEX IF EXISTS integrations_source;
DROP TRIGGER IF EXISTS integrations_org_required_insert;
DROP TRIGGER IF EXISTS integrations_org_immutable;
DROP TRIGGER IF EXISTS integrations_source_same_org;
DROP TRIGGER IF EXISTS integrations_source_immutable;
CREATE INDEX integrations_repo ON integrations(repo,enabled);
CREATE INDEX integrations_org_idx ON integrations(organization_id);
CREATE INDEX integrations_kek_version ON integrations(kek_version);
CREATE INDEX integrations_org_created ON integrations(organization_id, created_at);
CREATE INDEX integrations_source ON integrations(source_id, enabled);

CREATE TRIGGER integrations_org_required_insert
BEFORE INSERT ON integrations
WHEN NEW.organization_id IS NULL OR NEW.organization_id = ''
BEGIN
  SELECT RAISE(ABORT, 'integrations.organization_id is required');
END;

CREATE TRIGGER integrations_org_immutable
BEFORE UPDATE OF organization_id ON integrations
WHEN OLD.organization_id IS NOT NULL AND OLD.organization_id <> '' AND NEW.organization_id IS NOT OLD.organization_id
BEGIN
  SELECT RAISE(ABORT, 'integrations.organization_id cannot change');
END;

CREATE TRIGGER integrations_source_same_org
BEFORE INSERT ON integrations
WHEN NEW.source_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sources WHERE id = NEW.source_id AND organization_id = NEW.organization_id)
BEGIN
  SELECT RAISE(ABORT, 'integrations.source_id must reference a source in the same organization');
END;

CREATE TRIGGER integrations_source_immutable
BEFORE UPDATE OF source_id ON integrations
WHEN NEW.source_id IS NOT OLD.source_id
BEGIN
  SELECT RAISE(ABORT, 'integrations.source_id cannot change')
  WHERE OLD.source_id IS NOT NULL;
  SELECT RAISE(ABORT, 'integrations.source_id must reference a source in the same organization')
  WHERE NEW.source_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM sources WHERE id = NEW.source_id AND organization_id = NEW.organization_id);
END;

-- deliveries
ALTER TABLE deliveries RENAME TO deliveries_old;
ALTER TABLE deliveries_v4 RENAME TO deliveries;
DROP INDEX IF EXISTS deliveries_org_idx;
DROP INDEX IF EXISTS deliveries_state_next;
DROP INDEX IF EXISTS deliveries_state_claimed;
DROP INDEX IF EXISTS deliveries_replay_of;
DROP INDEX IF EXISTS deliveries_org_created;
DROP INDEX IF EXISTS deliveries_state_created;
DROP INDEX IF EXISTS deliveries_org_updated;
CREATE INDEX deliveries_org_idx ON deliveries(organization_id);
CREATE INDEX deliveries_state_next ON deliveries(state,next_attempt_at);
CREATE INDEX deliveries_state_claimed ON deliveries(state,claimed_at);
CREATE INDEX deliveries_replay_of ON deliveries(replay_of);
CREATE INDEX deliveries_org_created ON deliveries(organization_id, created_at);
CREATE INDEX deliveries_state_created ON deliveries(state, created_at);
CREATE INDEX deliveries_org_updated ON deliveries(organization_id, updated_at DESC, id DESC);

-- notification_outbox
ALTER TABLE notification_outbox RENAME TO notification_outbox_old;
ALTER TABLE notification_outbox_v4 RENAME TO notification_outbox;
DROP INDEX IF EXISTS notification_outbox_pending;
DROP INDEX IF EXISTS notification_outbox_org_idx;
DROP INDEX IF EXISTS notification_outbox_lease;
DROP INDEX IF EXISTS notification_outbox_org_due;
CREATE INDEX notification_outbox_pending ON notification_outbox(state,created_at);
CREATE INDEX notification_outbox_org_idx ON notification_outbox(organization_id);
CREATE INDEX notification_outbox_lease ON notification_outbox(state,lease_expires_at);
CREATE INDEX notification_outbox_org_due ON notification_outbox(organization_id,state,not_before);

-- held_events
ALTER TABLE held_events RENAME TO held_events_old;
ALTER TABLE held_events_v4 RENAME TO held_events;
DROP INDEX IF EXISTS held_events_due;
DROP INDEX IF EXISTS held_events_state_due;
DROP INDEX IF EXISTS held_events_failed;
DROP INDEX IF EXISTS held_events_released_in;
DROP INDEX IF EXISTS held_events_released_at;
CREATE INDEX held_events_due ON held_events(organization_id, integration_id, state, release_at);
CREATE INDEX held_events_state_due ON held_events(state, release_at);
CREATE INDEX held_events_failed ON held_events(state, released_at) WHERE state = 'failed';
CREATE INDEX held_events_released_in ON held_events(organization_id, released_in) WHERE released_in IS NOT NULL;
CREATE INDEX held_events_released_at ON held_events(released_at) WHERE released_at IS NOT NULL;

-- routing_decisions
ALTER TABLE routing_decisions RENAME TO routing_decisions_old;
ALTER TABLE routing_decisions_v4 RENAME TO routing_decisions;
DROP INDEX IF EXISTS routing_decisions_integration;
DROP INDEX IF EXISTS routing_decisions_decided;
CREATE INDEX routing_decisions_integration
  ON routing_decisions(organization_id, integration_id, decided_at DESC, id DESC);
CREATE INDEX routing_decisions_decided ON routing_decisions(decided_at);

-- noise_open_failures
ALTER TABLE noise_open_failures RENAME TO noise_open_failures_old;
ALTER TABLE noise_open_failures_v4 RENAME TO noise_open_failures;
DROP INDEX IF EXISTS noise_open_failures_opened;
CREATE INDEX noise_open_failures_opened ON noise_open_failures(opened_at);

-- --- 6. verify the swap against the kept originals, then remove the scratch objects ----------
-- A row written to an original after the copy (a writer outside the freeze) shows up here as a count
-- that does not balance. Nothing is dropped either way: the row is in `<table>_old`.
CREATE TABLE _swap_verify (
  tbl TEXT NOT NULL,
  balanced INTEGER NOT NULL CONSTRAINT swap_counts_must_match CHECK(balanced = 1)
);
INSERT INTO _swap_verify(tbl, balanced)
SELECT 'tables', (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN
    ('integrations','deliveries','notification_outbox','held_events','routing_decisions','noise_open_failures',
     'integrations_old','deliveries_old','notification_outbox_old','held_events_old','routing_decisions_old','noise_open_failures_old')) = 12;
INSERT INTO _swap_verify(tbl, balanced)
SELECT 'integrations',
  (SELECT COUNT(*) FROM integrations_old) = (SELECT COUNT(*) FROM integrations) + (SELECT COUNT(*) FROM integrations_old o WHERE o.organization_id IS NULL OR o.organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization g WHERE g.id = o.organization_id));
INSERT INTO _swap_verify(tbl, balanced)
SELECT 'deliveries',
  (SELECT COUNT(*) FROM deliveries_old) = (SELECT COUNT(*) FROM deliveries) + (SELECT COUNT(*) FROM deliveries_old o WHERE o.organization_id IS NULL OR o.organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization g WHERE g.id = o.organization_id));
INSERT INTO _swap_verify(tbl, balanced)
SELECT 'notification_outbox',
  (SELECT COUNT(*) FROM notification_outbox_old) = (SELECT COUNT(*) FROM notification_outbox) + (SELECT COUNT(*) FROM notification_outbox_old o WHERE o.organization_id IS NULL OR o.organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization g WHERE g.id = o.organization_id));
INSERT INTO _swap_verify(tbl, balanced)
SELECT 'held_events',
  (SELECT COUNT(*) FROM held_events_old) = (SELECT COUNT(*) FROM held_events) + (SELECT COUNT(*) FROM held_events_old o WHERE o.organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization g WHERE g.id = o.organization_id));
INSERT INTO _swap_verify(tbl, balanced)
SELECT 'routing_decisions',
  (SELECT COUNT(*) FROM routing_decisions_old) = (SELECT COUNT(*) FROM routing_decisions) + (SELECT COUNT(*) FROM routing_decisions_old o WHERE o.organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization g WHERE g.id = o.organization_id));
INSERT INTO _swap_verify(tbl, balanced)
SELECT 'noise_open_failures',
  (SELECT COUNT(*) FROM noise_open_failures_old) = (SELECT COUNT(*) FROM noise_open_failures) + (SELECT COUNT(*) FROM noise_open_failures_old o WHERE o.organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization g WHERE g.id = o.organization_id));
DROP TABLE _swap_verify;
DROP VIEW IF EXISTS _gate_0026_poison;
DROP TABLE IF EXISTS _gate_0026_ok;
DROP TABLE IF EXISTS _gate_0026_verified;
-- Copies that were never swapped in (only when a tripwire or the verification stopped the swap).
DROP TABLE IF EXISTS integrations_v4;
DROP TABLE IF EXISTS deliveries_v4;
DROP TABLE IF EXISTS notification_outbox_v4;
DROP TABLE IF EXISTS held_events_v4;
DROP TABLE IF EXISTS routing_decisions_v4;
DROP TABLE IF EXISTS noise_open_failures_v4;
