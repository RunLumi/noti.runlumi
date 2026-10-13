-- =============================================================================
-- 0009 — Delivery reliability (docs/specs/12-delivery-reliability.md F172–F184)
-- =============================================================================
-- Numbered 0009: 0008 is reserved for a parallel slice (integrations/audit/github).
-- This migration touches only `notification_outbox` and `deliveries`.
--
-- Both tables are rebuilt because SQLite cannot alter a CHECK constraint in place. Every
-- row is copied; indexes are recreated with the same names. Expand-only: no column is
-- dropped, so a Worker rollback keeps reading the columns it knows.
--
-- notification_outbox
--   state            + 'claimed' (F172 atomic claim)
--   claimed_at       epoch ms of the claim
--   lease_token      fencing token: only the lease holder may mark or release the row
--   lease_expires_at epoch ms; the reconciler reclaims an expired claim (F174)
--   not_before       epoch ms; a scheduled retry is parked here until due (F177 Tier 2)
--   last_error_code  F13 taxonomy code of the last failed dispatch
--
-- deliveries
--   state            pending | claimed | sent | accepted | retrying | dead_lettered | suppressed
--                    Legacy 'failed' (permanent, acknowledged) maps to 'dead_lettered';
--                    any other unknown value also maps to 'dead_lettered' with
--                    internal_error, so nothing is left in a non-terminal limbo (F180).
--   last_error_code  F13 taxonomy code; `last_error` stays the redacted minted diagnostic
--   dedup_key        F170 hex digest (NULL for rows written before this release)
--   replay_of        F182: the delivery this row replays
--   replay_count     how many replays of this row were requested (idempotency sequence)
--   next_attempt_at, first_attempt_at, last_attempt_at, claimed_at, dead_lettered_at: epoch ms
--   created_at       when the row was written
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
INSERT INTO notification_outbox_v3(id,payload_json,state,created_at,dispatched_at,organization_id)
  SELECT id,payload_json,state,created_at,dispatched_at,organization_id FROM notification_outbox;
DROP TABLE notification_outbox;
ALTER TABLE notification_outbox_v3 RENAME TO notification_outbox;
CREATE INDEX IF NOT EXISTS notification_outbox_pending ON notification_outbox(state,created_at);
CREATE INDEX IF NOT EXISTS notification_outbox_org_idx ON notification_outbox(organization_id);
CREATE INDEX IF NOT EXISTS notification_outbox_lease ON notification_outbox(state,lease_expires_at);

CREATE TABLE deliveries_v2 (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','sent','accepted','retrying','dead_lettered','suppressed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  organization_id TEXT,
  last_error_code TEXT,
  dedup_key TEXT,
  replay_of TEXT,
  replay_count INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  next_attempt_at INTEGER,
  first_attempt_at INTEGER,
  last_attempt_at INTEGER,
  dead_lettered_at INTEGER,
  created_at TEXT
);
INSERT INTO deliveries_v2(id,integration_id,state,attempts,last_error,updated_at,organization_id,last_error_code,created_at)
  SELECT id,integration_id,
         CASE WHEN state IN ('pending','sent','retrying') THEN state ELSE 'dead_lettered' END,
         attempts,last_error,updated_at,organization_id,
         CASE
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
CREATE INDEX IF NOT EXISTS deliveries_replay_of ON deliveries(replay_of);
