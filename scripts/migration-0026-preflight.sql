-- Preflight for migration 0026 (tenant contract). READ-ONLY: SELECTs only.
--
--   wrangler d1 execute lumi-noti --remote --json --file scripts/migration-0026-preflight.sql > preflight.json
--   node scripts/migration-0026-preflight.mjs preflight.json [--ack-orphans <exact count>]
--
-- One row per check: (check, n). The evaluator decides what blocks. The orphan counts are ESTIMATES
-- of what the migration will quarantine (they follow the same derivation rules but do not replay
-- the backfill in order); `legacy_orphaned_rows` after applying is the truth.
--
-- "valid organization" = a non-empty organization_id that equals an organization.id EXACTLY.
-- An id that differs only by case is not valid: the migration does not guess, it quarantines.
-- ONE FILE, MANY STATEMENTS: each is its own query of at most 3 compound SELECT terms (workerd's SQLite allows 5;
-- node:sqlite allows 500, which is why tests/migration-0026-d1.test.ts asserts it statically). wrangler --json
-- returns one result set per statement and the .mjs flattens them.

-- ---- row counts (the size ceiling) ----
SELECT 'total:integrations' AS "check", COUNT(*) AS n FROM integrations
UNION ALL SELECT 'total:deliveries', COUNT(*) FROM deliveries
UNION ALL SELECT 'total:notification_outbox', COUNT(*) FROM notification_outbox;

SELECT 'total:held_events' AS "check", COUNT(*) AS n FROM held_events
UNION ALL SELECT 'total:routing_decisions', COUNT(*) FROM routing_decisions
UNION ALL SELECT 'total:noise_open_failures', COUNT(*) FROM noise_open_failures;

-- ---- rows that will be QUARANTINED (they stay in <table>_old until finalize) ----
-- Effective tenant after the migration's backfill, replayed in order (integration from its source, delivery from the
-- integration, outbox row from the delivery else the payload's integration). A derived id that is not an
-- organization row is still quarantined, so "derivable" means derivable to a REAL organization.
WITH i1 AS (
  SELECT i.id, NULLIF(CASE WHEN i.organization_id IS NULL OR i.organization_id = ''
         THEN (SELECT s.organization_id FROM sources s WHERE s.id = i.source_id) ELSE i.organization_id END, '') AS org
  FROM integrations i),
d1 AS (
  SELECT d.id, NULLIF(CASE WHEN d.organization_id IS NULL OR d.organization_id = ''
         THEN (SELECT i1.org FROM i1 WHERE i1.id = d.integration_id) ELSE d.organization_id END, '') AS org
  FROM deliveries d),
o1 AS (
  SELECT x.id, NULLIF(CASE WHEN x.organization_id IS NULL OR x.organization_id = ''
         THEN COALESCE((SELECT d1.org FROM d1 WHERE d1.id = x.id),
                       (SELECT i1.org FROM i1 WHERE i1.id = CASE WHEN json_valid(x.payload_json)
                                                                 THEN json_extract(x.payload_json, '$.integrationId') END))
         ELSE x.organization_id END, '') AS org
  FROM notification_outbox x)
-- ---- row counts (the size ceiling) ------------------------------------------------------------
SELECT 'orphan:integrations' AS "check", COUNT(*) AS n FROM i1
  WHERE org IS NULL OR NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = i1.org)
UNION ALL SELECT 'orphan:deliveries', COUNT(*) FROM d1
  WHERE org IS NULL OR NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = d1.org)
UNION ALL SELECT 'orphan:notification_outbox', COUNT(*) FROM o1
  WHERE org IS NULL OR NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = o1.org);

SELECT 'orphan:held_events' AS "check", COUNT(*) AS n FROM held_events h
  WHERE h.organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = h.organization_id)
UNION ALL SELECT 'orphan:routing_decisions', COUNT(*) FROM routing_decisions r
  WHERE r.organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = r.organization_id)
UNION ALL SELECT 'orphan:noise_open_failures', COUNT(*) FROM noise_open_failures n
  WHERE n.organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = n.organization_id);

-- ---- state that blocks applying ----
SELECT 'blocker:foreign_keys_off' AS "check", 1 - foreign_keys AS n FROM pragma_foreign_keys
UNION ALL SELECT 'blocker:old_tables_present', COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN
  ('integrations_old','deliveries_old','notification_outbox_old','held_events_old','routing_decisions_old','noise_open_failures_old');

-- ---- organization ids that differ from a real one only by case (quarantined, never corrected) ----
SELECT 'case_mismatch:integrations' AS "check", COUNT(*) AS n FROM integrations t
  WHERE t.organization_id <> '' AND NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = t.organization_id)
    AND EXISTS (SELECT 1 FROM organization o WHERE lower(o.id) = lower(t.organization_id))
UNION ALL SELECT 'case_mismatch:deliveries', COUNT(*) FROM deliveries t
  WHERE t.organization_id <> '' AND NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = t.organization_id)
    AND EXISTS (SELECT 1 FROM organization o WHERE lower(o.id) = lower(t.organization_id))
UNION ALL SELECT 'case_mismatch:notification_outbox', COUNT(*) FROM notification_outbox t
  WHERE t.organization_id <> '' AND NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = t.organization_id)
    AND EXISTS (SELECT 1 FROM organization o WHERE lower(o.id) = lower(t.organization_id));

SELECT 'case_mismatch:held_events' AS "check", COUNT(*) AS n FROM held_events t
  WHERE t.organization_id <> '' AND NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = t.organization_id)
    AND EXISTS (SELECT 1 FROM organization o WHERE lower(o.id) = lower(t.organization_id))
UNION ALL SELECT 'case_mismatch:routing_decisions', COUNT(*) FROM routing_decisions t
  WHERE t.organization_id <> '' AND NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = t.organization_id)
    AND EXISTS (SELECT 1 FROM organization o WHERE lower(o.id) = lower(t.organization_id))
UNION ALL SELECT 'case_mismatch:noise_open_failures', COUNT(*) FROM noise_open_failures t
  WHERE t.organization_id <> '' AND NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = t.organization_id)
    AND EXISTS (SELECT 1 FROM organization o WHERE lower(o.id) = lower(t.organization_id));

-- ---- cross-tenant anomalies the migration KEEPS (each row has a valid organization) ----
-- Decision: kept, not quarantined. Each row is valid on its own; the migration cannot know which of the two
-- organizations is right. Review every one.
SELECT 'review:delivery_org_differs_from_integration_org' AS "check", COUNT(*) AS n FROM deliveries d
  JOIN integrations i ON i.id = d.integration_id
  WHERE d.organization_id IN (SELECT id FROM organization) AND i.organization_id IN (SELECT id FROM organization)
    AND d.organization_id <> i.organization_id
UNION ALL SELECT 'review:integration_org_differs_from_source_org', COUNT(*) FROM integrations i
  JOIN sources s ON s.id = i.source_id
  WHERE i.organization_id IN (SELECT id FROM organization) AND i.organization_id <> s.organization_id
UNION ALL SELECT 'review:deliveries_of_quarantined_integrations', COUNT(*) FROM deliveries d
  JOIN integrations i ON i.id = d.integration_id
  WHERE d.organization_id IN (SELECT id FROM organization)
    AND (i.organization_id IS NULL OR i.organization_id = ''
         OR NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = i.organization_id))
    AND NOT ((i.organization_id IS NULL OR i.organization_id = '')
             AND EXISTS (SELECT 1 FROM sources s WHERE s.id = i.source_id));
