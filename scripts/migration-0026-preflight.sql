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

-- ---- row counts (the size ceiling) ------------------------------------------------------------
SELECT 'total:integrations' AS "check", COUNT(*) AS n FROM integrations
UNION ALL SELECT 'total:deliveries', COUNT(*) FROM deliveries
UNION ALL SELECT 'total:notification_outbox', COUNT(*) FROM notification_outbox
UNION ALL SELECT 'total:held_events', COUNT(*) FROM held_events
UNION ALL SELECT 'total:routing_decisions', COUNT(*) FROM routing_decisions
UNION ALL SELECT 'total:noise_open_failures', COUNT(*) FROM noise_open_failures

-- ---- rows that will be QUARANTINED (their credentials and payloads leave the live tables) -----
-- integrations: no valid organization, and not derivable from a source
UNION ALL SELECT 'orphan:integrations', COUNT(*) FROM integrations i
  WHERE (i.organization_id IS NULL OR i.organization_id = ''
         OR NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = i.organization_id))
    AND NOT ((i.organization_id IS NULL OR i.organization_id = '')
             AND EXISTS (SELECT 1 FROM sources s WHERE s.id = i.source_id))
-- deliveries: no valid organization, and not derivable from an integration that has one
UNION ALL SELECT 'orphan:deliveries', COUNT(*) FROM deliveries d
  WHERE (d.organization_id IS NULL OR d.organization_id = ''
         OR NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = d.organization_id))
    AND NOT ((d.organization_id IS NULL OR d.organization_id = '')
             AND EXISTS (SELECT 1 FROM integrations i WHERE i.id = d.integration_id
               AND ((i.organization_id IS NOT NULL AND i.organization_id <> '')
                    OR EXISTS (SELECT 1 FROM sources s WHERE s.id = i.source_id))))
UNION ALL SELECT 'orphan:notification_outbox', COUNT(*) FROM notification_outbox x
  WHERE (x.organization_id IS NULL OR x.organization_id = ''
         OR NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = x.organization_id))
    AND NOT ((x.organization_id IS NULL OR x.organization_id = '')
             AND (EXISTS (SELECT 1 FROM deliveries d WHERE d.id = x.id
                       AND ((d.organization_id IS NOT NULL AND d.organization_id <> '')
                            OR EXISTS (SELECT 1 FROM integrations i WHERE i.id = d.integration_id
                                 AND ((i.organization_id IS NOT NULL AND i.organization_id <> '')
                                      OR EXISTS (SELECT 1 FROM sources s WHERE s.id = i.source_id)))))
                  OR EXISTS (SELECT 1 FROM integrations i
                       WHERE i.id = CASE WHEN json_valid(x.payload_json)
                                         THEN json_extract(x.payload_json, '$.integrationId') END
                         AND ((i.organization_id IS NOT NULL AND i.organization_id <> '')
                              OR EXISTS (SELECT 1 FROM sources s WHERE s.id = i.source_id)))))
UNION ALL SELECT 'orphan:held_events', COUNT(*) FROM held_events h
  WHERE h.organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = h.organization_id)
UNION ALL SELECT 'orphan:routing_decisions', COUNT(*) FROM routing_decisions r
  WHERE r.organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = r.organization_id)
UNION ALL SELECT 'orphan:noise_open_failures', COUNT(*) FROM noise_open_failures n
  WHERE n.organization_id = '' OR NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = n.organization_id)

-- ---- organization ids that differ from a real one only by case (quarantined, never corrected) ---
UNION ALL SELECT 'case_mismatch:integrations', COUNT(*) FROM integrations t
  WHERE t.organization_id <> '' AND NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = t.organization_id)
    AND EXISTS (SELECT 1 FROM organization o WHERE lower(o.id) = lower(t.organization_id))
UNION ALL SELECT 'case_mismatch:deliveries', COUNT(*) FROM deliveries t
  WHERE t.organization_id <> '' AND NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = t.organization_id)
    AND EXISTS (SELECT 1 FROM organization o WHERE lower(o.id) = lower(t.organization_id))
UNION ALL SELECT 'case_mismatch:notification_outbox', COUNT(*) FROM notification_outbox t
  WHERE t.organization_id <> '' AND NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = t.organization_id)
    AND EXISTS (SELECT 1 FROM organization o WHERE lower(o.id) = lower(t.organization_id))
UNION ALL SELECT 'case_mismatch:held_events', COUNT(*) FROM held_events t
  WHERE t.organization_id <> '' AND NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = t.organization_id)
    AND EXISTS (SELECT 1 FROM organization o WHERE lower(o.id) = lower(t.organization_id))
UNION ALL SELECT 'case_mismatch:routing_decisions', COUNT(*) FROM routing_decisions t
  WHERE t.organization_id <> '' AND NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = t.organization_id)
    AND EXISTS (SELECT 1 FROM organization o WHERE lower(o.id) = lower(t.organization_id))
UNION ALL SELECT 'case_mismatch:noise_open_failures', COUNT(*) FROM noise_open_failures t
  WHERE t.organization_id <> '' AND NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = t.organization_id)
    AND EXISTS (SELECT 1 FROM organization o WHERE lower(o.id) = lower(t.organization_id))

-- ---- cross-tenant anomalies the migration KEEPS (each row has a valid organization) -----------
-- Decision: kept, not quarantined. Each row is valid on its own; the migration cannot know which of
-- the two organizations is right, and deleting history on a guess is worse. Review every one.
UNION ALL SELECT 'review:delivery_org_differs_from_integration_org', COUNT(*) FROM deliveries d
  JOIN integrations i ON i.id = d.integration_id
  WHERE d.organization_id IN (SELECT id FROM organization) AND i.organization_id IN (SELECT id FROM organization)
    AND d.organization_id <> i.organization_id
UNION ALL SELECT 'review:integration_org_differs_from_source_org', COUNT(*) FROM integrations i
  JOIN sources s ON s.id = i.source_id
  WHERE i.organization_id IN (SELECT id FROM organization) AND i.organization_id <> s.organization_id
-- history that will outlive the integration it points at (the integration is quarantined)
UNION ALL SELECT 'review:deliveries_of_quarantined_integrations', COUNT(*) FROM deliveries d
  JOIN integrations i ON i.id = d.integration_id
  WHERE d.organization_id IN (SELECT id FROM organization)
    AND (i.organization_id IS NULL OR i.organization_id = ''
         OR NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = i.organization_id))
    AND NOT ((i.organization_id IS NULL OR i.organization_id = '')
             AND EXISTS (SELECT 1 FROM sources s WHERE s.id = i.source_id));
