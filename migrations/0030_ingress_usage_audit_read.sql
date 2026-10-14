-- =============================================================================
-- 0030 - Ingress usage accounting and the audit read side
--        (docs/specs/02-identity-tenancy.md F29, F28/F222; ADR 0030)
-- =============================================================================
-- 1. ingress_usage (F29): per workspace, per UTC day, per source kind, how many inbound events were
--    accepted (a delivery or a held row committed), how many were duplicates of an event already
--    accepted, and how many were answered 429 or absorbed by the flood limit. It is ACCOUNTING, kept
--    apart from `api_rate_limits` on purpose: that table is an abuse control, pruned hourly, and its
--    counts must never be read as usage (F29, F231). Counts only: no payload, no event id, no actor.
--    Written best effort AFTER the durable accept, so a failed write is logged and never loses or
--    delays an event: the figure can under-count by that failure, never over-count. It is not a
--    billing meter and is not described as one.
--    One row per (workspace, day, source): at most ~4 rows a day per workspace.
--
-- 2. audit_events.correlation_id (F222): the request id (src/platform/correlation.ts) the change was
--    made in, so "show me everything that request did" is one indexed lookup and a support quote of the
--    id from an error body finds the audit rows. Nullable: rows written before this migration, and rows
--    written by a cron job, have none. Bounded to 64 characters by the writer (sanitiseCorrelationId).
--    No CHECK on purpose: an ADD COLUMN with a CHECK makes SQLite scan the whole table once.
--    The append-only trigger only refuses UPDATE, so adding a column is allowed.
--
-- 3. Indexes for the new audit filters (actor, target, correlation), each led by organization_id so a
--    filtered read is a seek inside one workspace and never a scan of the table.
--
-- Deploy order: apply this migration BEFORE the new Worker. The new Worker writes these; the previous
-- Worker ignores the column and the table, so a rollback needs no schema change.
--
-- Expand-only. ROLLBACK (SQLite 3.35+):
--   DROP TABLE ingress_usage;
--   DROP INDEX audit_events_org_actor; DROP INDEX audit_events_org_target; DROP INDEX audit_events_org_correlation;
--   ALTER TABLE audit_events DROP COLUMN correlation_id;
-- =============================================================================

CREATE TABLE ingress_usage (
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  day TEXT NOT NULL CHECK(length(day) = 10),
  source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 20),
  events_accepted INTEGER NOT NULL DEFAULT 0 CHECK(events_accepted >= 0),
  events_duplicate INTEGER NOT NULL DEFAULT 0 CHECK(events_duplicate >= 0),
  events_rate_limited INTEGER NOT NULL DEFAULT 0 CHECK(events_rate_limited >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (organization_id, day, source)
);

CREATE INDEX ingress_usage_day ON ingress_usage(day);

ALTER TABLE audit_events ADD COLUMN correlation_id TEXT;

CREATE INDEX audit_events_org_correlation ON audit_events(organization_id, correlation_id) WHERE correlation_id IS NOT NULL;

CREATE INDEX audit_events_org_actor ON audit_events(organization_id, actor_id, created_at);

CREATE INDEX audit_events_org_target ON audit_events(organization_id, subject_id, created_at);
