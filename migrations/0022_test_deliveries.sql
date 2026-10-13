-- =============================================================================
-- 0022 — Test deliveries (docs/adr/0018-test-send.md, spec 07 F98)
-- =============================================================================
-- "Send a test notification" goes through the real delivery path (outbox, queue, claim,
-- retry, classification, adapters), so its row lives in `deliveries` like any other. This
-- flag is the only difference: it keeps test sends out of the success-ratio and latency SLIs,
-- the 24 h summary counts and the "first real event" step of setup progress, and lets the
-- delivery log label them. Display and reporting only; nothing in delivery reads it.
-- Expand-only. ROLLBACK: the previous Worker ignores the column.
-- =============================================================================

ALTER TABLE deliveries ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;
