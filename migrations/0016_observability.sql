-- =============================================================================
-- 0016 — Observability and retention (docs/specs/13-observability.md F197, F198, F200)
-- =============================================================================
-- ops_state: tiny key/value state for operator signals, so a condition that persists is
-- logged on transition (and at a re-notify interval), not on every cron tick. Holds
-- counts and timestamps only; never tenant ids, payloads or credentials.
CREATE TABLE IF NOT EXISTS ops_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The retention purge and the SLI queries filter on age. Without these every cron tick
-- would scan `deliveries` / `audit_events` in full.
CREATE INDEX IF NOT EXISTS deliveries_state_created ON deliveries(state, created_at);
CREATE INDEX IF NOT EXISTS audit_events_created ON audit_events(created_at);

-- ROLLBACK: expand-only (one table, two indexes). The previous Worker ignores all three,
-- so rolling the Worker back needs no schema change. To remove them:
--   DROP TABLE ops_state; DROP INDEX deliveries_state_created; DROP INDEX audit_events_created;
