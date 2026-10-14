-- Reconciliation for migration 0026 (tenant contract): the kept originals (`<table>_old`) against the
-- live tables, one row per check (check, n). READ-ONLY: SELECTs only. Run by scripts/migration-0026-finalize.mjs,
-- which refuses to drop anything unless these rows reconcile (docs/RUNBOOK.md, docs/adr/0021):
--
--   node scripts/migration-0026-finalize.mjs --database lumi-noti --remote            # check, changes nothing
--   node scripts/migration-0026-finalize.mjs --database lumi-noti --remote --apply    # check, then drop
--
-- ONE FILE, MANY STATEMENTS: each is a separate query of at most 4 compound SELECT terms (workerd's SQLite
-- allows 5; node:sqlite allows 500, which is why this is also asserted statically). The .mjs runs them one by one.
-- Needs all six `<table>_old` to exist (the .mjs probes first). Per table T:
--   old        rows in T_old, the original as it was when 0026 renamed it aside
--   live       rows in T now
--   (deliveries and notification_outbox compare the columns 0026 created, by name: later migrations add
--   columns to the live tables only, e.g. 0027 correlation_id, and `SELECT *` would not line up.)
--   identical  T_old rows that exist in T with EVERY column equal (INTERSECT compares whole rows,
--              blobs and NULLs included: a stronger check than a per-row hash sum)
--   same_id    T_old rows whose id exists in T (identical, or changed since)
--   quarantined T_old rows that are not in T and have a legacy_orphaned_rows entry (kept + quarantined = original)
--   live_only  rows in T that T_old never had (written since the swap)
--   quarantine_also_live  quarantine entries whose id is ALSO live (never expected)
-- fk:violations is DATABASE-WIDE (PRAGMA foreign_key_check): a violation anywhere blocks, on purpose.
-- Strict (default): changed (same_id - identical), missing (old - same_id - quarantined), live_only and
-- quarantine_also_live must all be 0. Traffic that resumed on the new tables makes the first and third
-- non-zero legitimately; the .mjs then needs --ack-drift with their exact sum.

SELECT 'fk:foreign_keys' AS "check", foreign_keys AS n FROM pragma_foreign_keys
UNION ALL SELECT 'fk:violations', COUNT(*) FROM pragma_foreign_key_check;

-- ---- integrations (two statements: workerd's SQLite allows at most 5 compound SELECT terms) ----
SELECT 'old:integrations' AS "check", COUNT(*) AS n FROM integrations_old
UNION ALL SELECT 'live:integrations', COUNT(*) FROM integrations
UNION ALL SELECT 'identical:integrations', COUNT(*) FROM (SELECT * FROM integrations_old INTERSECT SELECT * FROM integrations)
UNION ALL SELECT 'same_id:integrations', COUNT(*) FROM integrations_old o WHERE EXISTS (SELECT 1 FROM integrations l WHERE l.id = o.id);

SELECT 'quarantined:integrations' AS "check", COUNT(*) AS n FROM integrations_old o
  WHERE NOT EXISTS (SELECT 1 FROM integrations l WHERE l.id = o.id)
    AND EXISTS (SELECT 1 FROM legacy_orphaned_rows q WHERE q.source_table = 'integrations' AND q.row_id = CAST(o.id AS TEXT))
UNION ALL SELECT 'live_only:integrations', COUNT(*) FROM integrations l WHERE NOT EXISTS (SELECT 1 FROM integrations_old o WHERE o.id = l.id)
UNION ALL SELECT 'quarantine_also_live:integrations', COUNT(*) FROM integrations l
  WHERE EXISTS (SELECT 1 FROM legacy_orphaned_rows q WHERE q.source_table = 'integrations' AND q.row_id = CAST(l.id AS TEXT));

-- ---- deliveries (two statements: workerd's SQLite allows at most 5 compound SELECT terms) ----
SELECT 'old:deliveries' AS "check", COUNT(*) AS n FROM deliveries_old
UNION ALL SELECT 'live:deliveries', COUNT(*) FROM deliveries
UNION ALL SELECT 'identical:deliveries', COUNT(*) FROM (SELECT id,integration_id,state,attempts,last_error,updated_at,organization_id,last_error_code,dedup_key,replay_of,replay_count,claim_token,claimed_at,next_attempt_at,first_attempt_at,last_attempt_at,dead_lettered_at,created_at,body_hash,is_test,duplicate_of,suppressed_reason,possible_duplicate,provider_message_id FROM deliveries_old INTERSECT SELECT id,integration_id,state,attempts,last_error,updated_at,organization_id,last_error_code,dedup_key,replay_of,replay_count,claim_token,claimed_at,next_attempt_at,first_attempt_at,last_attempt_at,dead_lettered_at,created_at,body_hash,is_test,duplicate_of,suppressed_reason,possible_duplicate,provider_message_id FROM deliveries)
UNION ALL SELECT 'same_id:deliveries', COUNT(*) FROM deliveries_old o WHERE EXISTS (SELECT 1 FROM deliveries l WHERE l.id = o.id);

SELECT 'quarantined:deliveries' AS "check", COUNT(*) AS n FROM deliveries_old o
  WHERE NOT EXISTS (SELECT 1 FROM deliveries l WHERE l.id = o.id)
    AND EXISTS (SELECT 1 FROM legacy_orphaned_rows q WHERE q.source_table = 'deliveries' AND q.row_id = CAST(o.id AS TEXT))
UNION ALL SELECT 'live_only:deliveries', COUNT(*) FROM deliveries l WHERE NOT EXISTS (SELECT 1 FROM deliveries_old o WHERE o.id = l.id)
UNION ALL SELECT 'quarantine_also_live:deliveries', COUNT(*) FROM deliveries l
  WHERE EXISTS (SELECT 1 FROM legacy_orphaned_rows q WHERE q.source_table = 'deliveries' AND q.row_id = CAST(l.id AS TEXT));

-- ---- notification_outbox (two statements: workerd's SQLite allows at most 5 compound SELECT terms) ----
SELECT 'old:notification_outbox' AS "check", COUNT(*) AS n FROM notification_outbox_old
UNION ALL SELECT 'live:notification_outbox', COUNT(*) FROM notification_outbox
UNION ALL SELECT 'identical:notification_outbox', COUNT(*) FROM (SELECT id,payload_json,state,created_at,dispatched_at,organization_id,claimed_at,lease_token,lease_expires_at,not_before,last_error_code FROM notification_outbox_old INTERSECT SELECT id,payload_json,state,created_at,dispatched_at,organization_id,claimed_at,lease_token,lease_expires_at,not_before,last_error_code FROM notification_outbox)
UNION ALL SELECT 'same_id:notification_outbox', COUNT(*) FROM notification_outbox_old o WHERE EXISTS (SELECT 1 FROM notification_outbox l WHERE l.id = o.id);

SELECT 'quarantined:notification_outbox' AS "check", COUNT(*) AS n FROM notification_outbox_old o
  WHERE NOT EXISTS (SELECT 1 FROM notification_outbox l WHERE l.id = o.id)
    AND EXISTS (SELECT 1 FROM legacy_orphaned_rows q WHERE q.source_table = 'notification_outbox' AND q.row_id = CAST(o.id AS TEXT))
UNION ALL SELECT 'live_only:notification_outbox', COUNT(*) FROM notification_outbox l WHERE NOT EXISTS (SELECT 1 FROM notification_outbox_old o WHERE o.id = l.id)
UNION ALL SELECT 'quarantine_also_live:notification_outbox', COUNT(*) FROM notification_outbox l
  WHERE EXISTS (SELECT 1 FROM legacy_orphaned_rows q WHERE q.source_table = 'notification_outbox' AND q.row_id = CAST(l.id AS TEXT));

-- ---- held_events (two statements: workerd's SQLite allows at most 5 compound SELECT terms) ----
SELECT 'old:held_events' AS "check", COUNT(*) AS n FROM held_events_old
UNION ALL SELECT 'live:held_events', COUNT(*) FROM held_events
UNION ALL SELECT 'identical:held_events', COUNT(*) FROM (SELECT * FROM held_events_old INTERSECT SELECT * FROM held_events)
UNION ALL SELECT 'same_id:held_events', COUNT(*) FROM held_events_old o WHERE EXISTS (SELECT 1 FROM held_events l WHERE l.id = o.id);

SELECT 'quarantined:held_events' AS "check", COUNT(*) AS n FROM held_events_old o
  WHERE NOT EXISTS (SELECT 1 FROM held_events l WHERE l.id = o.id)
    AND EXISTS (SELECT 1 FROM legacy_orphaned_rows q WHERE q.source_table = 'held_events' AND q.row_id = CAST(o.id AS TEXT))
UNION ALL SELECT 'live_only:held_events', COUNT(*) FROM held_events l WHERE NOT EXISTS (SELECT 1 FROM held_events_old o WHERE o.id = l.id)
UNION ALL SELECT 'quarantine_also_live:held_events', COUNT(*) FROM held_events l
  WHERE EXISTS (SELECT 1 FROM legacy_orphaned_rows q WHERE q.source_table = 'held_events' AND q.row_id = CAST(l.id AS TEXT));

-- ---- routing_decisions (two statements: workerd's SQLite allows at most 5 compound SELECT terms) ----
SELECT 'old:routing_decisions' AS "check", COUNT(*) AS n FROM routing_decisions_old
UNION ALL SELECT 'live:routing_decisions', COUNT(*) FROM routing_decisions
UNION ALL SELECT 'identical:routing_decisions', COUNT(*) FROM (SELECT * FROM routing_decisions_old INTERSECT SELECT * FROM routing_decisions)
UNION ALL SELECT 'same_id:routing_decisions', COUNT(*) FROM routing_decisions_old o WHERE EXISTS (SELECT 1 FROM routing_decisions l WHERE l.id = o.id);

SELECT 'quarantined:routing_decisions' AS "check", COUNT(*) AS n FROM routing_decisions_old o
  WHERE NOT EXISTS (SELECT 1 FROM routing_decisions l WHERE l.id = o.id)
    AND EXISTS (SELECT 1 FROM legacy_orphaned_rows q WHERE q.source_table = 'routing_decisions' AND q.row_id = CAST(o.id AS TEXT))
UNION ALL SELECT 'live_only:routing_decisions', COUNT(*) FROM routing_decisions l WHERE NOT EXISTS (SELECT 1 FROM routing_decisions_old o WHERE o.id = l.id)
UNION ALL SELECT 'quarantine_also_live:routing_decisions', COUNT(*) FROM routing_decisions l
  WHERE EXISTS (SELECT 1 FROM legacy_orphaned_rows q WHERE q.source_table = 'routing_decisions' AND q.row_id = CAST(l.id AS TEXT));

-- ---- noise_open_failures (two statements: workerd's SQLite allows at most 5 compound SELECT terms) ----
SELECT 'old:noise_open_failures' AS "check", COUNT(*) AS n FROM noise_open_failures_old
UNION ALL SELECT 'live:noise_open_failures', COUNT(*) FROM noise_open_failures
UNION ALL SELECT 'identical:noise_open_failures', COUNT(*) FROM (SELECT * FROM noise_open_failures_old INTERSECT SELECT * FROM noise_open_failures)
UNION ALL SELECT 'same_id:noise_open_failures', COUNT(*) FROM noise_open_failures_old o WHERE EXISTS (SELECT 1 FROM noise_open_failures l WHERE l.id = o.id);

SELECT 'quarantined:noise_open_failures' AS "check", COUNT(*) AS n FROM noise_open_failures_old o
  WHERE NOT EXISTS (SELECT 1 FROM noise_open_failures l WHERE l.id = o.id)
    AND EXISTS (SELECT 1 FROM legacy_orphaned_rows q WHERE q.source_table = 'noise_open_failures' AND q.row_id = CAST(o.id AS TEXT))
UNION ALL SELECT 'live_only:noise_open_failures', COUNT(*) FROM noise_open_failures l WHERE NOT EXISTS (SELECT 1 FROM noise_open_failures_old o WHERE o.id = l.id)
UNION ALL SELECT 'quarantine_also_live:noise_open_failures', COUNT(*) FROM noise_open_failures l
  WHERE EXISTS (SELECT 1 FROM legacy_orphaned_rows q WHERE q.source_table = 'noise_open_failures' AND q.row_id = CAST(l.id AS TEXT));
