-- =============================================================================
-- 0024 — Credential lifecycle (docs/adr/0022-credential-lifecycle-and-boot.md, spec 03 F39, F40)
-- =============================================================================
-- * `credential_fingerprint` (integrations, sources): 8 characters of base32(SHA-256(secret)),
--   written when a credential is sealed so a customer can match it in their provider's console
--   without Noti ever showing it again (F39). One-way; NULL on rows sealed before this release
--   until the credential is next entered. Never consulted for authorization.
-- * `sources.credentials_revoked_at`: a source whose signing secret must be treated as burned
--   (F40). The source is also disabled, so ingress (which already refuses a disabled endpoint)
--   needs no change; the timestamp is what keeps it from being switched back on until a NEW
--   secret has been entered. Integrations reuse `credentials_quarantined_at` with the reason
--   `revoked`, because every delivery path already refuses a quarantined row.
--
-- DEPLOY ORDER: apply BEFORE deploying the Worker that reads these columns.
-- Expand-only. ROLLBACK: the previous Worker ignores the columns.
-- =============================================================================

ALTER TABLE integrations ADD COLUMN credential_fingerprint TEXT;
ALTER TABLE sources ADD COLUMN credential_fingerprint TEXT;
ALTER TABLE sources ADD COLUMN credentials_revoked_at TEXT;
