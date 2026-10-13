-- =============================================================================
-- 0009 — Delivery reliability (docs/specs/12-delivery-reliability.md F172–F184)
-- =============================================================================
-- Numbered 0009: 0008 belongs to the integrations/audit slice. This migration touches only
-- `notification_outbox` and `deliveries`.
--
-- Both tables are rebuilt because SQLite cannot alter a CHECK constraint in place. Every
-- row is copied; indexes are recreated with the same names.
--
-- ROLLBACK: expand-only. No column is dropped and every state the previous Worker writes is
-- still accepted — in particular `deliveries.state = 'failed'` stays in the CHECK for one
-- release, and the new code reads it as `dead_lettered` (src/delivery/state.ts
-- `normalizeDeliveryState`). Rolling the Worker back to the slice 2 code therefore keeps
-- working against this schema. Removing 'failed' is a later contract migration, after this
-- code has been the only writer for a full release.
--
-- notification_outbox
--   state            + 'claimed' (F172 atomic claim)
--   claimed_at       epoch ms of the claim
--   lease_token      fencing token: only the lease holder may mark or release the row
--   lease_expires_at epoch ms; the reconciler reclaims an expired claim (F174)
--   not_before       epoch ms; a parked retry or a released send waits here until due
--   last_error_code  F13 taxonomy code of the last failed dispatch
--
-- deliveries
--   state            pending | claimed | sent | accepted | retrying | dead_lettered | suppressed
--                    (+ legacy 'failed', read as dead_lettered — see ROLLBACK)
--   claim_token      fences the consumer's outcome write to the claim that made the attempt
--   last_error_code  F13 taxonomy code; `last_error` stays the redacted minted diagnostic
--   dedup_key        F170 hex digest (NULL for rows written before this release)
--   replay_of        F182: the delivery this row replays
--   replay_count     how many replays of this row were requested (idempotency sequence)
--   next_attempt_at, first_attempt_at, last_attempt_at, claimed_at, dead_lettered_at: epoch ms
--   created_at       when the row was written
--
-- Copy rules
--   * Existing 'failed' rows become 'dead_lettered' with a code derived from last_error.
--     Unknown states also become 'dead_lettered' (internal_error): nothing is left in a
--     non-terminal limbo (F180).
--   * Rows with no organization_id (written before 0006) can never be routed safely: a
--     pending outbox row becomes 'invalid', and a non-terminal delivery becomes
--     'dead_lettered' with config_invalid, so they are visible instead of stranded.
-- =============================================================================

CREATE TABLE notification_outbox_v3 (
  id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','dispatched','invalid')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dispatched_at TEXT,
  organization_id TEXT,
  claimed_at INTEGER,
  lease_token TEXT,
  lease_expires_at INTEGER,
  not_before INTEGER,
  last_error_code TEXT
);
INSERT INTO notification_outbox_v3(id,payload_json,state,created_at,dispatched_at,organization_id,last_error_code)
  SELECT id,payload_json,
         CASE WHEN organization_id IS NULL AND state = 'pending' THEN 'invalid' ELSE state END,
         created_at,dispatched_at,organization_id,
         CASE WHEN organization_id IS NULL AND state = 'pending' THEN 'config_invalid' ELSE NULL END
  FROM notification_outbox;
DROP TABLE notification_outbox;
ALTER TABLE notification_outbox_v3 RENAME TO notification_outbox;
CREATE INDEX IF NOT EXISTS notification_outbox_pending ON notification_outbox(state,created_at);
CREATE INDEX IF NOT EXISTS notification_outbox_org_idx ON notification_outbox(organization_id);
CREATE INDEX IF NOT EXISTS notification_outbox_lease ON notification_outbox(state,lease_expires_at);
CREATE INDEX IF NOT EXISTS notification_outbox_org_due ON notification_outbox(organization_id,state,not_before);

CREATE TABLE deliveries_v2 (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','sent','accepted','retrying','dead_lettered','suppressed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  organization_id TEXT,
  last_error_code TEXT,
  dedup_key TEXT,
  replay_of TEXT,
  replay_count INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  claimed_at INTEGER,
  next_attempt_at INTEGER,
  first_attempt_at INTEGER,
  last_attempt_at INTEGER,
  dead_lettered_at INTEGER,
  created_at TEXT
);
INSERT INTO deliveries_v2(id,integration_id,state,attempts,last_error,updated_at,organization_id,last_error_code,created_at)
  SELECT id,integration_id,
         CASE
           WHEN organization_id IS NULL AND state IN ('pending','retrying') THEN 'dead_lettered'
           WHEN state IN ('pending','sent','retrying') THEN state
           ELSE 'dead_lettered'
         END,
         attempts,
         CASE
           WHEN organization_id IS NULL AND state IN ('pending','retrying') THEN 'organization_missing'
           ELSE last_error
         END,
         updated_at,organization_id,
         CASE
           WHEN organization_id IS NULL AND state IN ('pending','retrying') THEN 'config_invalid'
           WHEN state IN ('pending','sent') THEN NULL
           WHEN state = 'retrying' THEN 'internal_error'
           WHEN last_error = 'destination_credentials_invalid' THEN 'destination_credentials_invalid'
           WHEN last_error IN ('destination_not_allowed','destination_url_invalid') THEN 'destination_url_rejected'
           WHEN last_error IN ('integration_unavailable','malformed_envelope') THEN 'config_invalid'
           ELSE 'internal_error'
         END,
         updated_at
  FROM deliveries;
DROP TABLE deliveries;
ALTER TABLE deliveries_v2 RENAME TO deliveries;
CREATE INDEX IF NOT EXISTS deliveries_org_idx ON deliveries(organization_id);
CREATE INDEX IF NOT EXISTS deliveries_state_next ON deliveries(state,next_attempt_at);
CREATE INDEX IF NOT EXISTS deliveries_state_claimed ON deliveries(state,claimed_at);
CREATE INDEX IF NOT EXISTS deliveries_replay_of ON deliveries(replay_of);
