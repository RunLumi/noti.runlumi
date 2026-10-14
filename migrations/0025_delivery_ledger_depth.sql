-- =============================================================================
-- 0025 — Delivery ledger depth (docs/adr/0023-delivery-ledger-depth.md,
--        docs/specs/12-delivery-reliability.md F171, F181, F182, F183, F184, F185, F186, F187)
-- =============================================================================
-- 1. event_dedup: one row per accepted (event, integration), keyed by the deterministic delivery id,
--    written in the same transaction as the delivery (or held) row. A provider redelivery bumps
--    hit_count/last_seen and is RECORDED as a `suppressed` delivery row (see 2), never silently
--    dropped. TTL is 7 days (expires_at); a bounded cron job purges expired rows. It holds ids and
--    hashes only: no payload.
--
-- 2. deliveries: four ADD COLUMNs, no rebuild.
--      duplicate_of        the delivery a `suppressed` row duplicates
--      suppressed_reason   closed set, mirrors SuppressionReason in src/delivery/state.ts
--      possible_duplicate  a retry followed an attempt whose outcome the provider never confirmed
--      provider_message_id nullable; no current adapter response carries one, so it stays NULL
--
-- 3. delivery_attempts: one row per consumer attempt (and per deferral by the circuit breaker or the
--    pacing hold), written in the SAME batch as the ledger transition and only when that transition
--    changed the row. Closed vocabularies only; no provider text, URL or payload. Deleted with the
--    delivery by the retention job.
--
-- 4. destination_health: per (workspace, integration) circuit-breaker and outbound-pacing state.
--
-- All three tables carry organization_id NOT NULL with a foreign key that cascades from the organization,
-- and are also drained by the bounded workspace purge (src/pipeline/purge.ts TENANT_TABLES).
--
-- Expand-only. ROLLBACK: the previous Worker ignores the new columns and tables. It would stop
-- writing event_dedup and delivery_attempts and stop honouring the breaker, nothing else.
-- =============================================================================

ALTER TABLE deliveries ADD COLUMN duplicate_of TEXT;
ALTER TABLE deliveries ADD COLUMN suppressed_reason TEXT
  CHECK(suppressed_reason IS NULL OR suppressed_reason IN ('duplicate','claim_conflict','provider_idempotency'));
ALTER TABLE deliveries ADD COLUMN possible_duplicate INTEGER NOT NULL DEFAULT 0 CHECK(possible_duplicate IN (0,1));
ALTER TABLE deliveries ADD COLUMN provider_message_id TEXT
  CHECK(provider_message_id IS NULL OR length(provider_message_id) <= 200);

CREATE TABLE event_dedup (
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0 CHECK(hit_count >= 0),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (organization_id, delivery_id)
);
CREATE INDEX event_dedup_expires ON event_dedup(expires_at);
CREATE INDEX event_dedup_key ON event_dedup(organization_id, dedup_key);

CREATE TABLE delivery_attempts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  -- Attempts used so far when the row was written: a deferral stores the count already spent (0 when
  -- none), so it never takes the number of the next real attempt.
  attempt INTEGER NOT NULL CHECK(attempt >= 0),
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('delivered','accepted','retry_scheduled','dead_lettered','deferred')),
  error_code TEXT CHECK(error_code IS NULL OR length(error_code) <= 60),
  reason TEXT CHECK(reason IS NULL OR length(reason) <= 80),
  status_class TEXT NOT NULL DEFAULT 'none'
    CHECK(status_class IN ('2xx','3xx','4xx','5xx','timeout','network','none')),
  retry_after_ms INTEGER CHECK(retry_after_ms IS NULL OR retry_after_ms >= 0),
  provider_message_id TEXT CHECK(provider_message_id IS NULL OR length(provider_message_id) <= 200),
  possible_duplicate INTEGER NOT NULL DEFAULT 0 CHECK(possible_duplicate IN (0,1)),
  -- Consecutive identical waits are folded into one `deferred` row: this is how many extra times it
  -- waited (a 24 hour outage is one row, not hundreds).
  repeat_count INTEGER NOT NULL DEFAULT 0 CHECK(repeat_count >= 0)
);
CREATE INDEX delivery_attempts_delivery ON delivery_attempts(organization_id, delivery_id, started_at);
CREATE INDEX delivery_attempts_started ON delivery_attempts(organization_id, started_at);
-- The retention purge walks old attempts across workspaces by age.
CREATE INDEX delivery_attempts_age ON delivery_attempts(started_at);

CREATE TABLE destination_health (
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL,
  destination_host TEXT CHECK(destination_host IS NULL OR length(destination_host) <= 255),
  state TEXT NOT NULL DEFAULT 'closed' CHECK(state IN ('closed','open','half_open')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),
  opened_at INTEGER,
  open_until INTEGER,
  probe_until INTEGER,
  paused_until INTEGER,
  opened_count INTEGER NOT NULL DEFAULT 0,
  last_failure_at INTEGER,
  last_failure_code TEXT CHECK(last_failure_code IS NULL OR length(last_failure_code) <= 60),
  last_success_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (organization_id, integration_id)
);
CREATE INDEX destination_health_state ON destination_health(state, updated_at);
