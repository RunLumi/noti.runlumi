-- =============================================================================
-- 0018 — Discord and the signed customer webhook as destination kinds
--        (docs/adr/0014, docs/specs/09 F107, F115, F116)
-- =============================================================================
-- `integrations.destination` was CHECK(destination IN ('lark','slack','teams')) since 0012.
-- SQLite cannot alter a CHECK in place, so the table is rebuilt, exactly as 0012 did. The
-- ONLY change is the CHECK list. Everything else is carried over verbatim, including what
-- was added after 0012 (a test diffs the schema before and after and fails on any other
-- difference):
--
--   columns   0001 id, repo, event_types, destination, webhook_ciphertext, enabled
--             0002 lark_secret_ciphertext
--             0006 organization_id
--             0007 key_salt, dek_wrapped, kek_version, webhook_envelope,
--                  lark_secret_envelope, credentials_quarantined_at,
--                  credentials_quarantine_reason
--             0008 name, destination_host, created_by, created_at, updated_at
--             0015 filters_json (with its json_valid / length CHECK)
--             0017 source_id
--   indexes   integrations_repo, integrations_org_idx, integrations_kek_version,
--             integrations_org_created (0001-0008), integrations_source (0017)
--   triggers  integrations_org_required_insert, integrations_org_immutable (0008),
--             integrations_source_same_org, integrations_source_immutable (0017).
--             Dropped with the table, so recreated at the end.
--   elsewhere sources_delete_integrations (0017) is a trigger ON `sources` whose body names
--             `integrations`. It is not dropped with this table, but SQLite re-parses every
--             trigger when a table is renamed, and one that names a table which momentarily
--             does not exist fails the rename ("error in trigger sources_delete_integrations:
--             no such table: main.integrations", reproduced). It is dropped first and
--             recreated last.
--
-- The custom webhook's signing secret reuses the existing `lark_secret_envelope` column (the
-- sealed field is named `signing_secret` in its AAD whichever destination owns it), so no
-- column is added. Nothing references `integrations` by foreign key.
--
-- ROLLBACK: the previous Worker only writes 'lark', 'slack' and 'teams', all still accepted,
-- so rolling the Worker back keeps working against this schema, but it cannot deliver a
-- 'discord' or 'generic_webhook' row: disable those integrations first. Restoring the old
-- CHECK is another rebuild that must first delete or retarget those rows.
-- =============================================================================

DROP TRIGGER sources_delete_integrations;

CREATE TABLE integrations_v3 (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  event_types TEXT NOT NULL,
  destination TEXT NOT NULL CHECK(destination IN ('lark','slack','teams','discord','generic_webhook')),
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
  updated_at TEXT,
  filters_json TEXT
  CHECK(filters_json IS NULL OR (json_valid(filters_json) AND length(filters_json) <= 8192)),
  source_id TEXT
);

INSERT INTO integrations_v3(
  id,repo,event_types,destination,webhook_ciphertext,enabled,lark_secret_ciphertext,
  organization_id,key_salt,dek_wrapped,kek_version,webhook_envelope,lark_secret_envelope,
  credentials_quarantined_at,credentials_quarantine_reason,
  name,destination_host,created_by,created_at,updated_at,filters_json,source_id)
SELECT
  id,repo,event_types,destination,webhook_ciphertext,enabled,lark_secret_ciphertext,
  organization_id,key_salt,dek_wrapped,kek_version,webhook_envelope,lark_secret_envelope,
  credentials_quarantined_at,credentials_quarantine_reason,
  name,destination_host,created_by,created_at,updated_at,filters_json,source_id
FROM integrations;

DROP TABLE integrations;
ALTER TABLE integrations_v3 RENAME TO integrations;

CREATE INDEX integrations_repo ON integrations(repo,enabled);
CREATE INDEX integrations_org_idx ON integrations(organization_id);
CREATE INDEX integrations_kek_version ON integrations(kek_version);
CREATE INDEX integrations_org_created ON integrations(organization_id, created_at);
CREATE INDEX integrations_source ON integrations(source_id, enabled);

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

CREATE TRIGGER integrations_source_same_org
BEFORE INSERT ON integrations
WHEN NEW.source_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sources WHERE id = NEW.source_id AND organization_id = NEW.organization_id)
BEGIN
  SELECT RAISE(ABORT, 'integrations.source_id must reference a source in the same organization');
END;

CREATE TRIGGER integrations_source_immutable
BEFORE UPDATE OF source_id ON integrations
WHEN NEW.source_id IS NOT OLD.source_id
BEGIN
  SELECT RAISE(ABORT, 'integrations.source_id cannot change')
  WHERE OLD.source_id IS NOT NULL;
  SELECT RAISE(ABORT, 'integrations.source_id must reference a source in the same organization')
  WHERE NEW.source_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM sources WHERE id = NEW.source_id AND organization_id = NEW.organization_id);
END;

CREATE TRIGGER sources_delete_integrations
AFTER DELETE ON sources
BEGIN
  DELETE FROM integrations WHERE source_id = OLD.id AND organization_id = OLD.organization_id;
END;
