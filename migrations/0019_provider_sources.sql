-- =============================================================================
-- 0019 — Provider-specific inbound sources: GitLab and Stripe (docs/adr/0015, spec 06)
-- =============================================================================
-- `sources.kind` was CHECK(kind IN ('generic')) since 0017. SQLite cannot alter a CHECK in
-- place, so the table is rebuilt (the approach of 0007, 0009 and 0012). Two columns are added
-- at the same time, both NULL for generic sources:
--
--   auth_mode  gitlab only: 'signing_token' (Standard Webhooks signature) or 'secret_token'
--              (plain `X-Gitlab-Token`). Chosen by the person who pasted the credential, never
--              guessed from its shape.
--   livemode   stripe only: 1 live, 0 test. Test and live are separate sources with separate
--              signing secrets (spec 06 F84); an event whose livemode differs is not delivered.
--
-- Preserved from 0017: every column, both indexes, and the three triggers
-- (sources_org_required_insert, sources_org_immutable, sources_delete_integrations). Triggers
-- are dropped with the table, so they are recreated at the end.
--
-- The two triggers ON integrations that SELECT FROM sources (integrations_source_same_org,
-- integrations_source_immutable) are dropped first and recreated unchanged: SQLite re-parses
-- the schema when a table is renamed and refuses a trigger whose referenced table is missing.
-- `integrations.source_id` is a plain column (no foreign key), so no integration row changes.
--
-- 0018 is reserved by another change (extended destinations); the numbers need not be
-- contiguous.
--
-- ROLLBACK: the previous Worker only creates 'generic' sources and ignores the two new
-- columns, so it keeps working against this schema, but it cannot ingest a 'gitlab' or
-- 'stripe' source: disable those sources before rolling the Worker back. Restoring the old
-- CHECK is another rebuild that must first delete the non-generic rows (and, through the
-- delete trigger, their integrations).
-- =============================================================================

DROP TRIGGER integrations_source_same_org;
DROP TRIGGER integrations_source_immutable;

CREATE TABLE sources_v2 (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('generic','gitlab','stripe')),
  name TEXT NOT NULL,
  endpoint_id TEXT NOT NULL UNIQUE CHECK(length(endpoint_id) >= 22),
  secret_envelope BLOB NOT NULL,
  key_salt BLOB NOT NULL,
  dek_wrapped BLOB NOT NULL,
  kek_version INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_received_at TEXT,
  secret_rotated_at TEXT,
  reused_id_rejections INTEGER NOT NULL DEFAULT 0,
  last_reuse_rejected_at TEXT,
  auth_mode TEXT CHECK(auth_mode IS NULL OR auth_mode IN ('signing_token','secret_token')),
  livemode INTEGER CHECK(livemode IS NULL OR livemode IN (0,1))
);

INSERT INTO sources_v2(
  id,organization_id,kind,name,endpoint_id,secret_envelope,key_salt,dek_wrapped,kek_version,
  enabled,created_by,created_at,updated_at,last_received_at,secret_rotated_at,
  reused_id_rejections,last_reuse_rejected_at)
SELECT
  id,organization_id,kind,name,endpoint_id,secret_envelope,key_salt,dek_wrapped,kek_version,
  enabled,created_by,created_at,updated_at,last_received_at,secret_rotated_at,
  reused_id_rejections,last_reuse_rejected_at
FROM sources;

DROP TABLE sources;
ALTER TABLE sources_v2 RENAME TO sources;

CREATE INDEX sources_org_created ON sources(organization_id, created_at);
CREATE INDEX sources_kek_version ON sources(kek_version);

CREATE TRIGGER sources_org_required_insert
BEFORE INSERT ON sources
WHEN NEW.organization_id IS NULL OR NEW.organization_id = ''
BEGIN
  SELECT RAISE(ABORT, 'sources.organization_id is required');
END;

CREATE TRIGGER sources_org_immutable
BEFORE UPDATE OF organization_id ON sources
WHEN NEW.organization_id IS NOT OLD.organization_id
BEGIN
  SELECT RAISE(ABORT, 'sources.organization_id cannot change');
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
