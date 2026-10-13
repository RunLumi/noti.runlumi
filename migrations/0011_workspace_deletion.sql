-- =============================================================================
-- 0011 — Workspace deletion and export (docs/specs/02-identity-tenancy.md F30; N3)
-- =============================================================================
-- Two-phase deletion: a request soft-stops the workspace (its integrations are disabled,
-- remembered here so a cancel restores exactly what was on), then after the retention
-- window a cron job purges every tenant row and finally the organization itself.
--
-- This table deliberately has NO foreign key to organization: it is the purge ledger and
-- must outlive the organization, as evidence that (and when) the purge completed. It holds
-- ids and timestamps only.
CREATE TABLE IF NOT EXISTS workspace_deletions (
  organization_id TEXT PRIMARY KEY,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  purge_after INTEGER NOT NULL,
  disabled_integration_ids TEXT NOT NULL DEFAULT '[]',
  cancelled_at TEXT,
  purge_started_at TEXT,
  purged_at TEXT
);
CREATE INDEX IF NOT EXISTS workspace_deletions_due ON workspace_deletions(purge_after)
  WHERE cancelled_at IS NULL AND purged_at IS NULL;

-- The last-admin triggers from 0005 abort the ON DELETE CASCADE from organization to
-- member, which made deletion impossible at the database level. They are recreated with
-- one narrow exemption: a purge that has started for that organization.
DROP TRIGGER IF EXISTS "member_preserve_admin_delete";
CREATE TRIGGER "member_preserve_admin_delete"
BEFORE DELETE ON "member"
WHEN OLD."role" = 'admin'
 AND NOT EXISTS (
   SELECT 1 FROM "member" WHERE "organization_id" = OLD."organization_id"
     AND "id" <> OLD."id" AND "role" = 'admin'
 )
 AND NOT EXISTS (
   SELECT 1 FROM workspace_deletions WHERE organization_id = OLD."organization_id"
     AND purge_started_at IS NOT NULL AND cancelled_at IS NULL
 )
BEGIN SELECT RAISE(ABORT, 'organization requires an admin'); END;
