-- =============================================================================
-- 0008 — Integrations API metadata, tenant contract, audit events
-- =============================================================================
-- docs/specs/02-identity-tenancy.md F25 (contract), F26, F28; 00-current-state.md D2, D12.
--
-- PART 1: non-secret integration metadata written by the API.
--   destination_host is the hostname only (e.g. hooks.slack.com). It is not a secret and
--   lets the dashboard identify a destination without decrypting anything.
ALTER TABLE integrations ADD COLUMN name TEXT;
ALTER TABLE integrations ADD COLUMN destination_host TEXT;
ALTER TABLE integrations ADD COLUMN created_by TEXT;
ALTER TABLE integrations ADD COLUMN created_at TEXT;
ALTER TABLE integrations ADD COLUMN updated_at TEXT;

CREATE INDEX IF NOT EXISTS integrations_org_created ON integrations(organization_id, created_at);

-- PART 2: tenant contract for integrations, enforced by the database.
--   A NOT NULL column constraint would need a table rebuild that fails on any legacy row
--   still lacking an organization. Triggers give the same guarantee for every new write
--   now; the legacy rows remain readable (and unroutable) until the backfill. A later
--   migration replaces these triggers with NOT NULL + FOREIGN KEY once no NULLs remain.
CREATE TRIGGER IF NOT EXISTS integrations_org_required_insert
BEFORE INSERT ON integrations
WHEN NEW.organization_id IS NULL OR NEW.organization_id = ''
BEGIN
  SELECT RAISE(ABORT, 'integrations.organization_id is required');
END;

CREATE TRIGGER IF NOT EXISTS integrations_org_immutable
BEFORE UPDATE OF organization_id ON integrations
WHEN OLD.organization_id IS NOT NULL AND OLD.organization_id <> '' AND NEW.organization_id IS NOT OLD.organization_id
BEGIN
  SELECT RAISE(ABORT, 'integrations.organization_id cannot change');
END;

-- PART 3: append-only audit log (F28).
--   organization_id is NULL only for a denial whose target workspace does not exist; a
--   probe against a real workspace is recorded against that workspace so its admins see it.
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organization(id) ON DELETE CASCADE,
  actor_id TEXT,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('success','denied')),
  ip TEXT,
  user_agent TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(length(metadata_json) <= 4096),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS audit_events_org_created ON audit_events(organization_id, created_at);

CREATE TRIGGER IF NOT EXISTS audit_events_append_only_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;
-- UPDATE is refused. DELETE is NOT blocked: organization deletion cascades, and a
-- retention job will need it. This is an append-only *application* log, not a
-- tamper-evident one; tamper evidence (hash chaining / external sink) is future work.

-- PART 4: fixed-window counters for API abuse limits (not billing quotas; F29 keeps
-- those separate). Rows are keyed per actor and window and pruned by age.
CREATE TABLE IF NOT EXISTS api_rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);
