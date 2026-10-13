-- Pruning scans api_rate_limits by window age; the primary key is (key, window_start), so
-- without this index every prune is a full scan (docs/THREAT_MODEL.md AR-16).
CREATE INDEX IF NOT EXISTS api_rate_limits_window ON api_rate_limits(window_start);
