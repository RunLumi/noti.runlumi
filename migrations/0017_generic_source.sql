-- =============================================================================
-- 0017 — Generic inbound webhook source (docs/specs/06 F73–F90, docs/adr/0012)
-- =============================================================================
-- A `source` is a customer-owned system that POSTs JSON events to Noti with a Standard
-- Webhooks signature. Expand-only: one new table, one nullable column, two indexes.
--
-- * `endpoint_id` is the public, non-secret part of the ingest URL. It is NOT authorization:
--   the signature is. It only selects which secret to verify against.
-- * The signing secret is sealed with the envelope scheme (ADR 0004): AAD binds
--   org + source id + field `signing_secret` + purpose `source.signing`. There is no
--   plaintext column. Deleting the row deletes the wrapped DEK (crypto-shredding).
-- * Tenant contract identical to `integrations` (0008/0012): organization_id is NOT NULL,
--   refused on insert if blank and immutable afterwards. It also cascades from the
--   organization, so the purge-coverage guard accepts it; purge.ts additionally drains it
--   in bounded batches.
-- * `integrations.source_id` marks an integration that routes events from a source instead
--   of a GitHub repository. Such rows carry the sentinel repo `source:<source id>` (a value
--   no GitHub `owner/name` can equal, because it contains ':'), so the GitHub ingress query
--   `WHERE repo=?` can never select them. GitHub routing is otherwise untouched.
--
-- `deliveries.body_hash`: SHA-256 (hex) of the raw request body of a generic event, stored with
-- the dedup row so a webhook-id reused with a DIFFERENT body is refused (409) instead of being
-- silently swallowed as a duplicate. NULL for every other delivery.
--
-- ROLLBACK: the previous Worker ignores both the table and the column. To remove them:
--   DROP TABLE sources; (and, SQLite >= 3.35) ALTER TABLE integrations DROP COLUMN source_id;
-- Integrations with a non-NULL source_id must be deleted first; the old Worker would
-- otherwise see them as GitHub integrations that can never match an event (harmless).
-- =============================================================================

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('generic')),
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
  -- Events refused because their webhook-id was already accepted with a different body.
  -- A visible counter, so a sender that reuses ids hears about it (review M3).
  reused_id_rejections INTEGER NOT NULL DEFAULT 0,
  last_reuse_rejected_at TEXT
);

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

ALTER TABLE integrations ADD COLUMN source_id TEXT;
CREATE INDEX integrations_source ON integrations(source_id, enabled);

-- An integration may only reference a source of its own workspace; the API checks this too,
-- and the database refuses it regardless of which code path writes the row.
CREATE TRIGGER integrations_source_same_org
BEFORE INSERT ON integrations
WHEN NEW.source_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sources WHERE id = NEW.source_id AND organization_id = NEW.organization_id)
BEGIN
  SELECT RAISE(ABORT, 'integrations.source_id must reference a source in the same organization');
END;

ALTER TABLE deliveries ADD COLUMN body_hash TEXT;

-- source_id is set once, at creation, and never reassigned or cleared: moving an integration
-- between sources would redirect events across the source boundary. (An UPDATE that leaves it
-- unchanged is allowed.) Setting it from NULL must also satisfy the same-organization rule.
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

-- No orphans: an integration bound to a source cannot outlive it, whichever path deletes the
-- source (the API, an organization cascade, a manual cleanup). The API additionally requires
-- an explicit `cascade` for a source that still has integrations.
CREATE TRIGGER sources_delete_integrations
AFTER DELETE ON sources
BEGIN
  DELETE FROM integrations WHERE source_id = OLD.id AND organization_id = OLD.organization_id;
END;
