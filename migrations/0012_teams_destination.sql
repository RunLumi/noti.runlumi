-- =============================================================================
-- 0012 — Microsoft Teams as a destination kind (docs/adr/0006, docs/specs/07 F104)
-- =============================================================================
-- `integrations.destination` was CHECK(destination IN ('lark','slack')) since 0001. SQLite
-- cannot alter a CHECK in place, so the table is rebuilt (the same approach as 0007 and 0009
-- for other tables). Every column, row, index and trigger is preserved:
--
--   columns   0001 id, repo, event_types, destination, webhook_ciphertext, enabled
--             0002 lark_secret_ciphertext
--             0006 organization_id
--             0007 key_salt, dek_wrapped, kek_version, webhook_envelope,
--                  lark_secret_envelope, credentials_quarantined_at,
--                  credentials_quarantine_reason
--             0008 name, destination_host, created_by, created_at, updated_at
--   indexes   integrations_repo, integrations_org_idx, integrations_kek_version,
--             integrations_org_created
--   triggers  integrations_org_required_insert, integrations_org_immutable (0008). Triggers
--             are dropped together with the table, so they are recreated at the end.
--
-- Nothing references `integrations` by foreign key (`deliveries.integration_id` is a plain
-- column), so no PRAGMA foreign_keys handling is needed and no dependent row is touched.
-- The copy runs before the triggers exist, so a legacy row with no organization_id (kept
-- readable-but-unroutable by 0008) still copies.
--
-- ROLLBACK: the old Worker only writes 'lark' and 'slack', both still accepted, so rolling
-- the Worker back keeps working against this schema, but it cannot deliver a 'teams' row:
-- disable Teams integrations before rolling the Worker back. Restoring the old CHECK is
-- another table rebuild that must first delete or retarget any 'teams' rows.
-- =============================================================================

CREATE TABLE integrations_v2 (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  event_types TEXT NOT NULL,
  destination TEXT NOT NULL CHECK(destination IN ('lark','slack','teams')),
  webhook_ciphertext TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  lark_secret_ciphertext TEXT,
  organization_id TEXT,
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
  updated_at TEXT
);

INSERT INTO integrations_v2(
  id,repo,event_types,destination,webhook_ciphertext,enabled,lark_secret_ciphertext,
  organization_id,key_salt,dek_wrapped,kek_version,webhook_envelope,lark_secret_envelope,
  credentials_quarantined_at,credentials_quarantine_reason,
  name,destination_host,created_by,created_at,updated_at)
SELECT
  id,repo,event_types,destination,webhook_ciphertext,enabled,lark_secret_ciphertext,
  organization_id,key_salt,dek_wrapped,kek_version,webhook_envelope,lark_secret_envelope,
  credentials_quarantined_at,credentials_quarantine_reason,
  name,destination_host,created_by,created_at,updated_at
FROM integrations;

DROP TABLE integrations;
ALTER TABLE integrations_v2 RENAME TO integrations;

CREATE INDEX integrations_repo ON integrations(repo,enabled);
CREATE INDEX integrations_org_idx ON integrations(organization_id);
CREATE INDEX integrations_kek_version ON integrations(kek_version);
CREATE INDEX integrations_org_created ON integrations(organization_id, created_at);

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
