-- Delivery log (slice 6b). The list is `WHERE organization_id = ? ORDER BY updated_at DESC, id DESC`
-- and the Overview summary counts one workspace's rows by `created_at` window. Without these
-- indexes both are served from the single-column organization index and a sort or scan of the
-- whole workspace. The summary query names deliveries_org_created (INDEXED BY), so apply this
-- migration before deploying the Worker that uses it.
-- Additive and idempotent: no rows change, so rollback is `DROP INDEX` for each.
CREATE INDEX IF NOT EXISTS deliveries_org_updated ON deliveries(organization_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS deliveries_org_created ON deliveries(organization_id, created_at);
