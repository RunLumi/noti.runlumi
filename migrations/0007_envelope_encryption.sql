-- =============================================================================
-- 0007 — Envelope encryption columns (docs/specs/03-secrets-and-crypto.md F33–F37)
-- =============================================================================
-- Expand-only. The v0 columns (`webhook_ciphertext`, `lark_secret_ciphertext`) stay
-- readable until the scheduled migration job reports zero v0 rows; that job clears
-- them in the same UPDATE that writes the v1 envelope, so a row is never half-written.
--
--   key_salt              16-byte HKDF salt, stored in the clear (it is not a secret)
--   dek_wrapped           per-connection DEK wrapped under HKDF(KEK, salt, org)
--   kek_version           KEK version that wrapped the DEK (the rewrap worklist key)
--   webhook_envelope      v1 envelope of the destination URL, AAD-bound to the row
--   lark_secret_envelope  v1 envelope of the Lark signing secret, if any
--   credentials_quarantined_at / _reason
--                         set when a row will not decrypt; the row stops delivering
--                         loudly instead of being skipped silently
-- =============================================================================

ALTER TABLE integrations ADD COLUMN key_salt BLOB;
ALTER TABLE integrations ADD COLUMN dek_wrapped BLOB;
ALTER TABLE integrations ADD COLUMN kek_version INTEGER;
ALTER TABLE integrations ADD COLUMN webhook_envelope BLOB;
ALTER TABLE integrations ADD COLUMN lark_secret_envelope BLOB;
ALTER TABLE integrations ADD COLUMN credentials_quarantined_at TEXT;
ALTER TABLE integrations ADD COLUMN credentials_quarantine_reason TEXT;

CREATE INDEX IF NOT EXISTS integrations_kek_version ON integrations(kek_version);

-- Outbox rows the dispatcher cannot parse are marked rather than retried forever.
-- SQLite cannot alter a CHECK constraint in place, so the table is rebuilt. Rows written
-- before this release carried destination ciphertext in payload_json (D5); it is removed
-- during the copy, for dispatched rows as well as pending ones, so retiring the legacy
-- key actually retires every copy it can open.
CREATE TABLE notification_outbox_v2 (
  id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','dispatched','invalid')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dispatched_at TEXT,
  organization_id TEXT
);
INSERT INTO notification_outbox_v2(id,payload_json,state,created_at,dispatched_at,organization_id)
  SELECT id,
         CASE WHEN json_valid(payload_json)
              THEN json_remove(payload_json,'$.ciphertext','$.larkSecretCiphertext','$.destination')
              ELSE payload_json END,
         state,created_at,dispatched_at,organization_id
  FROM notification_outbox;
DROP TABLE notification_outbox;
ALTER TABLE notification_outbox_v2 RENAME TO notification_outbox;
CREATE INDEX IF NOT EXISTS notification_outbox_pending ON notification_outbox(state,created_at);
CREATE INDEX IF NOT EXISTS notification_outbox_org_idx ON notification_outbox(organization_id);
