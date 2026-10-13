-- =============================================================================
-- 0006 — Multi-organization membership, and tenant scoping for domain tables
-- =============================================================================
-- Two changes, both required to make a user belong to more than one workspace.
--
-- PART 1: drop the unique index that made multi-org impossible
--
-- `0005_better_auth.sql` created:
--     CREATE UNIQUE INDEX "member_one_org_per_user" ON "member"("user_id")
-- That constraint, not the Better Auth `organizationLimit` option, is what actually
-- prevented a second membership: Better Auth would raise on insert. Removing the
-- plugin-level cap alone (PR #5) therefore left the product broken — a user joining
-- a second workspace would still be rejected by the database.
--
-- docs/PRODUCT.md names audience #4, "Agency/operator: needs many customer
-- workspaces without cross-tenant leaks", which a single-workspace limit excludes.
-- Isolation must come from organization_id predicates on our own tables, never from
-- membership cardinality. See docs/specs/02-identity-tenancy.md F15.
--
-- PART 2: expand-phase tenant columns (F25)
--
-- No tenant-owned table carried an organization id, so the webhook route resolved
-- the destination by `integrations.repo` — a field chosen by the sender in the
-- request body. That is defect D2/D3 and it is the release gate.
--
-- This is the EXPAND step only: columns are added nullable and indexed. The
-- CONTRACT step (NOT NULL + foreign key) must be a later migration, applied after
-- the code that writes them has shipped and backfill has run. Doing both at once
-- would fail on any database that already has rows.
-- =============================================================================

-- --- Part 1: allow multiple organizations per user --------------------------
DROP INDEX IF EXISTS "member_one_org_per_user";
-- A plain index keeps the per-user lookup fast without imposing uniqueness.
CREATE INDEX IF NOT EXISTS "member_user_idx" ON "member"("user_id");
-- ...but one membership per (user, organization): a duplicate row would make role
-- checks ambiguous and double-count admins in the last-admin triggers.
CREATE UNIQUE INDEX IF NOT EXISTS "member_user_org_unique" ON "member"("user_id","organization_id");

-- --- Part 2: expand tenant columns ------------------------------------------
ALTER TABLE integrations ADD COLUMN organization_id TEXT;
ALTER TABLE deliveries ADD COLUMN organization_id TEXT;
ALTER TABLE notification_outbox ADD COLUMN organization_id TEXT;

CREATE INDEX IF NOT EXISTS "integrations_org_idx" ON integrations(organization_id);
CREATE INDEX IF NOT EXISTS "deliveries_org_idx" ON deliveries(organization_id);
CREATE INDEX IF NOT EXISTS "notification_outbox_org_idx" ON notification_outbox(organization_id);

-- --- GitHub App installations: the inbound tenant resolver -------------------
--
-- The signature alone proves "signed by whoever holds our App-wide webhook secret",
-- which is every installation of our App — it does not identify a tenant. This table
-- is what maps an inbound event to exactly one organization, and it is the only
-- authorized path from a webhook to a workspace.
--
-- `installation_id` is read from the verified payload BODY, never from
-- X-GitHub-Hook-Installation-Target-ID: GitHub documents those headers only as
-- "the resource where the webhook was created", and the sole worked example is a
-- repository webhook, so their meaning for an App webhook is undefined.
-- See docs/specs/05-source-github.md F59.
CREATE TABLE IF NOT EXISTS github_installations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK(account_type IN ('User','Organization')),
  repository_selection TEXT NOT NULL CHECK(repository_selection IN ('all','selected')),
  access_token_ciphertext TEXT,
  token_expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','uninstalled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(installation_id, app_id)
);

CREATE INDEX IF NOT EXISTS "github_installations_org_idx" ON github_installations(organization_id);
CREATE INDEX IF NOT EXISTS "github_installations_status_idx" ON github_installations(status);