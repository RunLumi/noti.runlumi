-- =============================================================================
-- 0027 - Job runner, alert state and correlation ids
--        (docs/specs/13-observability.md F192, F193, F200; ADR 0024)
-- =============================================================================
-- 1. job_runs: one row per cron job execution, written by `runCronJobs` (src/observability/cron.ts).
--    Counts and a closed error class only: never a message, a tenant id or a payload. `healthy` is 1 for
--    `ok` and `skipped` (the job ran, possibly with nothing to do) and 0 for `failed`, so the staleness
--    check is one index point-lookup per job. Platform-wide, NOT a tenant table (no organization_id).
--    Retention: 3 days, drained by the existing retention job (src/pipeline/retention.ts).
--
-- 2. alert_state: one row per alert id (a fixed registry, src/observability/alerts/registry.ts):
--    firing or resolved, since when, when it was last notified, the dedupe key of the current
--    incident and how many consecutive evaluations have breached (an alert may need more than one). Platform-wide, a handful of rows overwritten in place.
--
-- 3. correlation_id on deliveries, notification_outbox and delivery_attempts: the id minted at ingress
--    (src/platform/correlation.ts), so a support question "what happened to this request" is one
--    indexed lookup. Nullable: rows written before this migration, and rows created by a cron job with
--    no request, have none. Bounded to 64 characters, like the id's own charset rule.
--
-- Expand-only. ROLLBACK: the previous Worker ignores the new columns and tables; it stops recording job
-- runs and alert state and stops stamping correlation ids, nothing else. To remove them (SQLite 3.35+):
--   DROP TABLE job_runs; DROP TABLE alert_state; DROP INDEX deliveries_correlation;
--   ALTER TABLE deliveries DROP COLUMN correlation_id;
--   ALTER TABLE notification_outbox DROP COLUMN correlation_id;
--   ALTER TABLE delivery_attempts DROP COLUMN correlation_id;
-- =============================================================================

CREATE TABLE job_runs (
  id INTEGER PRIMARY KEY,
  job TEXT NOT NULL CHECK(length(job) BETWEEN 1 AND 60),
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('ok','failed','skipped')),
  healthy INTEGER NOT NULL CHECK(healthy IN (0,1)),
  -- JSON object of small non-negative integers (rows processed). Counts only.
  counters_json TEXT CHECK(counters_json IS NULL OR length(counters_json) <= 500),
  -- Closed vocabulary (src/observability/job-runs.ts JOB_ERROR_CLASSES); never a raw message.
  error_class TEXT CHECK(error_class IS NULL OR length(error_class) <= 40)
);
CREATE INDEX job_runs_job_healthy ON job_runs(job, healthy, finished_at);
CREATE INDEX job_runs_started ON job_runs(started_at);

CREATE TABLE alert_state (
  alert_id TEXT PRIMARY KEY CHECK(length(alert_id) BETWEEN 1 AND 60),
  state TEXT NOT NULL CHECK(state IN ('firing','resolved')),
  since INTEGER NOT NULL,
  last_notified INTEGER,
  dedupe_key TEXT NOT NULL CHECK(length(dedupe_key) <= 100),
  last_value INTEGER,
  breaches INTEGER NOT NULL DEFAULT 0 CHECK(breaches >= 0),
  updated_at INTEGER NOT NULL
);

ALTER TABLE deliveries ADD COLUMN correlation_id TEXT
  CHECK(correlation_id IS NULL OR length(correlation_id) <= 64);
ALTER TABLE notification_outbox ADD COLUMN correlation_id TEXT
  CHECK(correlation_id IS NULL OR length(correlation_id) <= 64);
ALTER TABLE delivery_attempts ADD COLUMN correlation_id TEXT
  CHECK(correlation_id IS NULL OR length(correlation_id) <= 64);

-- Leading column is the id so an operator can look one up across workspaces; the API always adds
-- organization_id as the second column. Partial: most rows carry one, but every pre-0027 row does not.
CREATE INDEX deliveries_correlation ON deliveries(correlation_id, organization_id)
  WHERE correlation_id IS NOT NULL;
