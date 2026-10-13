-- =============================================================================
-- 0020 — Dropped-event counter for provider sources (docs/adr/0015, security review M2)
-- =============================================================================
-- A GitLab source answers a flood with 2xx and drops the event (GitLab disables a webhook after
-- repeated 4xx). The drop must not be silent: `dropped_events` counts them and `last_dropped_at`
-- says when, both shown on the Sources page and summed in the observability summary. Display
-- counters only (same idea as `reused_id_rejections`); they gate nothing.
-- Expand-only. ROLLBACK: the previous Worker ignores both columns.
-- =============================================================================

ALTER TABLE sources ADD COLUMN dropped_events INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN last_dropped_at TEXT;
