-- =============================================================================
-- 0015 — Per-integration routing filters and routing provenance
--        (docs/adr/0010-routing-filters.md, docs/specs/10-routing-and-filtering.md)
-- =============================================================================
-- 1. integrations.filters_json: the closed filter model, a versioned JSON document, NULL when
--    the integration has no filters. This is an ADD COLUMN, not a table rebuild (contrast with
--    0007, 0009, 0012, which had to change a CHECK): a rebuild would drop and recreate the
--    integrations_org_required_insert / integrations_org_immutable triggers and every index
--    for no benefit. The CHECK only admits valid JSON of bounded size; deeper validation is the
--    API's job and is repeated when a stored document is read.
--
-- 2. routing_decisions: one row per integration considered for an event (delivered or
--    filtered, with the reason). Ids, a closed reason vocabulary and timestamps only: no payload,
--    no field values and no compared literals. `id` is the deterministic delivery id for
--    (dedup key, integration), so a provider redelivery cannot duplicate a row.
--
--    The table carries organization_id with no foreign key, like `deliveries`: it is purged by
--    the bounded per-tick workspace purge (src/pipeline/purge.ts TENANT_TABLES) and by the
--    30-day retention job (src/routing/provenance.ts), not by an unbounded cascade.
--
-- ROLLBACK: the old Worker ignores both. Dropping filters_json needs a table rebuild, so the
-- column is simply left NULL-able and unused after a Worker rollback; `DROP TABLE
-- routing_decisions` is safe at any time. NOTE a rollback re-enables delivery of events the
-- filters were suppressing.
-- =============================================================================

ALTER TABLE integrations ADD COLUMN filters_json TEXT
  CHECK(filters_json IS NULL OR (json_valid(filters_json) AND length(filters_json) <= 8192));

CREATE TABLE routing_decisions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('delivered','filtered')),
  filter_id TEXT,
  reason TEXT NOT NULL,
  unknown_fact INTEGER NOT NULL DEFAULT 0 CHECK(unknown_fact IN (0,1)),
  decided_at INTEGER NOT NULL,
  CHECK(outcome = 'delivered' OR filter_id IS NOT NULL)
);

CREATE INDEX routing_decisions_integration
  ON routing_decisions(organization_id, integration_id, decided_at DESC, id DESC);
CREATE INDEX routing_decisions_decided ON routing_decisions(decided_at);
