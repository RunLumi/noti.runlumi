-- =============================================================================
-- 0010 — GitHub App install flow, repository scope, lifecycle (F56, F57, F67, F68)
-- =============================================================================
-- (0009 is reserved for delivery reliability, developed in parallel.)
--
-- One-time states for the install → verify flow. Only the SHA-256 of a state is stored,
-- so a database read does not yield a usable state. `pkce_verifier` is the PKCE secret for
-- the OAuth leg; it is single-use, expires with the state, and is useless without the
-- authorization code GitHub sends only to the user's browser.
CREATE TABLE IF NOT EXISTS github_auth_states (
  state_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK(purpose IN ('install','verify')),
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  claimed_installation_id TEXT,
  pkce_verifier TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS github_auth_states_expiry ON github_auth_states(expires_at);

-- Repositories an installation may route, for `repository_selection = 'selected'` (F67).
CREATE TABLE IF NOT EXISTS github_installation_repositories (
  installation_row_id TEXT NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  PRIMARY KEY (installation_row_id, repository_id)
);
CREATE INDEX IF NOT EXISTS github_installation_repositories_name
  ON github_installation_repositories(installation_row_id, full_name COLLATE NOCASE);

ALTER TABLE github_installations ADD COLUMN suspended_at TEXT;
ALTER TABLE github_installations ADD COLUMN updated_at TEXT;
ALTER TABLE github_installations ADD COLUMN bound_by TEXT;
-- GitHub's numeric account id: stable across renames, unlike account_login.
ALTER TABLE github_installations ADD COLUMN account_id TEXT;
-- 0 when the stored repository set may be incomplete (e.g. the selection switched from
-- 'all' to 'selected' and GitHub's event listed only the delta). Ingress still checks the
-- stored set — failing closed — and the dashboard asks for a reconnect to resync.
ALTER TABLE github_installations ADD COLUMN repositories_complete INTEGER NOT NULL DEFAULT 1;

-- Installations GitHub told us were deleted before any workspace bound them. A bind of a
-- tombstoned installation is refused, closing the verify→bind race with 'deleted'.
CREATE TABLE IF NOT EXISTS github_installation_tombstones (
  installation_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (installation_id, app_id)
);

-- An installation is bound to exactly one workspace, forever, unless an explicit audited
-- action unbinds it (F56). The database refuses a silent rebind.
CREATE TRIGGER IF NOT EXISTS github_installations_no_rebind
BEFORE UPDATE OF organization_id ON github_installations
WHEN NEW.organization_id IS NOT OLD.organization_id
BEGIN
  SELECT RAISE(ABORT, 'github_installations.organization_id cannot change');
END;
