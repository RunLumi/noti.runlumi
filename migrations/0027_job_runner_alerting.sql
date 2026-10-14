-- =============================================================================
-- 0027 - Job runner, alert state and correlation ids
--        (docs/specs/13-observability.md F192, F193, F200; ADR 0024)
-- =============================================================================
-- 1. job_state and job_runs (F192). `job_state` is ONE row per cron job, upserted every tick by
--    `runCronJobs` (src/observability/cron.ts): first seen, last start and finish, last outcome, last
--    healthy and last failed time, last counters, last error class, run count. The staleness check, the
--    summary and the alert read only this (13 rows). `job_runs` is the HISTORY: one row per failed run and
--    per change of outcome (and the first run), so a quiet healthy job writes nothing there. Both hold
--    counts, times and a closed error class only: never a message, a tenant id or a payload. Platform-wide,
--    NOT tenant tables (no organization_id). Write volume: about 13 `job_state` upserts a minute (about
--    19,000 rows a day, no secondary index); ASSUMPTION: a D1 plan whose daily rows-written allowance
--    covers that on top of the product's own writes (the Free plan's is 100,000 a day, UNVERIFIED).
--    `job_runs` retention: 14 days, drained by the existing retention job.
--
-- 2. alert_state: one row per alert id (a fixed registry, src/observability/alerts/registry.ts):
--    firing or resolved, since when, last notified, the incident dedupe key, consecutive breached and clear
--    evaluations (hysteresis), and an unsent notice (kind, retry time, failures) for a sink that was down.
--    Platform-wide, a handful of rows overwritten in place.
--
-- 3. correlation_id on deliveries, notification_outbox and delivery_attempts: the id minted at ingress
--    (src/platform/correlation.ts), so a support question "what happened to this request" is one
--    indexed lookup. Nullable: rows written before this migration, and rows created by a cron job with
--    no request, have none. Bounded to 64 characters. NOTE: an ADD COLUMN with a CHECK makes SQLite
--    validate every existing row (a full scan of each table, once, inside this migration). Apply in a
--    quiet window on a large `deliveries`; it rewrites nothing.
--
-- 4. Partial indexes for the alert signals, so a minute-by-minute evaluation during an outage is an
--    index seek and never a scan (tests/observability/alert-plans.test.ts asserts every signal query).
--
-- Deploy order: apply this migration BEFORE the new Worker. The Worker reads and writes these columns and
-- tables; the previous Worker ignores them, so a rollback needs no schema change.
--
-- Expand-only. ROLLBACK: the previous Worker ignores the new columns and tables. To remove them (SQLite 3.35+):
--   DROP TABLE job_state; DROP TABLE job_runs; DROP TABLE alert_state;
--   DROP INDEX deliveries_correlation; DROP INDEX deliveries_org_correlation; DROP INDEX integrations_quarantined;
--   DROP INDEX sources_dropped; DROP INDEX delivery_attempts_dead;
--   ALTER TABLE deliveries DROP COLUMN correlation_id;
--   ALTER TABLE notification_outbox DROP COLUMN correlation_id;
--   ALTER TABLE delivery_attempts DROP COLUMN correlation_id;
-- =============================================================================

CREATE TABLE job_state (
  job TEXT PRIMARY KEY CHECK(length(job) BETWEEN 1 AND 60),
  first_seen_at INTEGER NOT NULL,
  last_started_at INTEGER NOT NULL,
  last_finished_at INTEGER NOT NULL,
  last_outcome TEXT NOT NULL CHECK(last_outcome IN ('ok','failed','skipped')),
  last_healthy_at INTEGER,
  last_failed_at INTEGER,
  -- JSON object of small non-negative integers (rows processed). Counts only.
  last_counters_json TEXT CHECK(last_counters_json IS NULL OR length(last_counters_json) <= 500),
  -- Closed vocabulary (src/observability/job-runs.ts JOB_ERROR_CLASSES); never a raw message.
  last_error_class TEXT CHECK(last_error_class IS NULL OR length(last_error_class) <= 40),
  runs INTEGER NOT NULL DEFAULT 1 CHECK(runs >= 1)
);

CREATE TABLE job_runs (
  id INTEGER PRIMARY KEY,
  job TEXT NOT NULL CHECK(length(job) BETWEEN 1 AND 60),
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('ok','failed','skipped')),
  healthy INTEGER NOT NULL CHECK(healthy IN (0,1)),
  counters_json TEXT CHECK(counters_json IS NULL OR length(counters_json) <= 500),
  error_class TEXT CHECK(error_class IS NULL OR length(error_class) <= 40)
);
CREATE INDEX job_runs_started ON job_runs(started_at);

CREATE TABLE alert_state (
  alert_id TEXT PRIMARY KEY CHECK(length(alert_id) BETWEEN 1 AND 60),
  state TEXT NOT NULL CHECK(state IN ('firing','resolved')),
  since INTEGER NOT NULL,
  last_notified INTEGER,
  dedupe_key TEXT NOT NULL CHECK(length(dedupe_key) <= 100),
  last_value INTEGER,
  breaches INTEGER NOT NULL DEFAULT 0 CHECK(breaches >= 0),
  clears INTEGER NOT NULL DEFAULT 0 CHECK(clears >= 0),
  -- A notice a sink did not accept: which kind, when to try again, how many tries failed.
  unsent TEXT CHECK(unsent IS NULL OR unsent IN ('firing','renotify','resolved')),
  retry_at INTEGER,
  notify_failures INTEGER NOT NULL DEFAULT 0 CHECK(notify_failures >= 0),
  updated_at INTEGER NOT NULL
);

ALTER TABLE deliveries ADD COLUMN correlation_id TEXT
  CHECK(correlation_id IS NULL OR length(correlation_id) <= 64);
ALTER TABLE notification_outbox ADD COLUMN correlation_id TEXT
  CHECK(correlation_id IS NULL OR length(correlation_id) <= 64);
ALTER TABLE delivery_attempts ADD COLUMN correlation_id TEXT
  CHECK(correlation_id IS NULL OR length(correlation_id) <= 64);

-- Two indexes, one per access path. `deliveries_correlation` leads with the id so an operator can look one up
-- across workspaces. `deliveries_org_correlation` leads with the workspace: the API's list query
-- (`organization_id = ? AND correlation_id = ?`) names it with INDEXED BY, because the planner would
-- otherwise prefer the (organization, updated_at) index that satisfies its ORDER BY and scan a workspace. Partial: most rows carry one, but every pre-0027 row does not.
CREATE INDEX deliveries_correlation ON deliveries(correlation_id, organization_id)
  WHERE correlation_id IS NOT NULL;
CREATE INDEX deliveries_org_correlation ON deliveries(organization_id, correlation_id)
  WHERE correlation_id IS NOT NULL;

CREATE INDEX integrations_quarantined ON integrations(credentials_quarantined_at)
  WHERE credentials_quarantined_at IS NOT NULL;
CREATE INDEX sources_dropped ON sources(last_dropped_at) WHERE last_dropped_at IS NOT NULL;
CREATE INDEX delivery_attempts_dead ON delivery_attempts(started_at) WHERE outcome = 'dead_lettered';
