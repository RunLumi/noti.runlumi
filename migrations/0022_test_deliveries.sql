-- =============================================================================
-- 0022 — Test deliveries (docs/adr/0018-test-send.md, spec 07 F98)
-- =============================================================================
-- "Send a test notification" goes through the real delivery path (outbox, queue, claim,
-- retry, classification, adapters), so its row lives in `deliveries` like any other. This
-- flag is the only difference: it keeps test sends out of the success-ratio and latency SLIs,
-- stall detection, the 24 h summary counts and the "first real event" step of setup progress,
-- bounds how many tests an integration can have in flight, and lets the delivery log label them.
-- Delivery itself never reads it.
--
-- DEPLOY ORDER: apply this migration BEFORE deploying the Worker that reads `is_test`. The new
-- Worker's queries name the column; the previous Worker ignores it, so the migration is safe
-- to apply first.
-- Expand-only. ROLLBACK: the previous Worker ignores the column.
-- =============================================================================

ALTER TABLE deliveries ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0 CHECK(is_test IN (0,1));
