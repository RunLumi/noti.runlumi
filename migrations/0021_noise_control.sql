-- =============================================================================
-- 0021 — Noise control: quiet hours, burst grouping, digests, resolution notices
--        (docs/adr/0016-noise-control.md, docs/specs/11-grouping-and-noise.md)
-- =============================================================================
-- 1. integrations.noise_json: a versioned JSON document (NULL = no noise settings). An ADD
--    COLUMN, like filters_json in 0015: no table rebuild, so the tenant triggers and indexes
--    are untouched. The CHECK admits valid JSON of bounded size; the API validates deeply and a
--    stored document is re-validated on every read.
--
-- 2. held_events: events that were ACCEPTED but are waiting to be released (quiet hours, a
--    digest boundary, a grouping window). Small display fields only: no payload, no headers,
--    no credentials. `id` is the deterministic delivery id for (dedup key, integration), so a
--    provider redelivery cannot hold the same event twice. A cron job claims due rows with a
--    lease and releases them through the normal outbox in ONE batch (a held row is never
--    deleted before the delivery that carries it exists). Released rows stay for 7 days so a
--    redelivery is still recognised, then retention removes them.
--
--    Once released, the display columns are blanked (kept: id, released_in, hold_reason, state), so
--    nothing but what the dedupe and the delivery-log join need outlives the notification.
--
-- 3. noise_open_failures: which workflow (per repository and branch) is currently failing, per
--    integration, so a later success can be sent as a "resolved" notice. A key hash only.
--
-- Both tables carry organization_id with no foreign key, like `deliveries`: they are purged by
-- the bounded workspace purge (src/pipeline/purge.ts TENANT_TABLES) and by retention.
--
-- ROLLBACK: the previous Worker ignores the column and both tables. NOTE it also stops
-- releasing, so rows still in state 'held' or 'claimed' stay there until a Worker that knows
-- about them runs again; they are not lost. Turn noise settings off and let the queue drain
-- before rolling back if updates must not be delayed.
-- =============================================================================

ALTER TABLE integrations ADD COLUMN noise_json TEXT
  CHECK(noise_json IS NULL OR (json_valid(noise_json) AND length(noise_json) <= 2048));

CREATE TABLE held_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  hold_reason TEXT NOT NULL CHECK(hold_reason IN ('quiet_hours','digest','grouped')),
  group_key TEXT NOT NULL CHECK(length(group_key) = 32),
  state TEXT NOT NULL DEFAULT 'held' CHECK(state IN ('held','claimed','released','failed')),
  release_at INTEGER NOT NULL,
  held_at INTEGER NOT NULL,
  claim_token TEXT,
  claim_expires_at INTEGER,
  -- Poison-row handling: each failed or abandoned release attempt counts; the row is not due again
  -- until retry_after, and after 5 attempts it becomes 'failed' (kept, visible, never released).
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error_class TEXT CHECK(last_error_class IS NULL OR length(last_error_class) <= 40),
  retry_after INTEGER NOT NULL DEFAULT 0,
  released_at INTEGER,
  released_in TEXT,
  event_type TEXT NOT NULL CHECK(length(event_type) <= 100),
  title TEXT NOT NULL CHECK(length(title) <= 300),
  url TEXT NOT NULL CHECK(length(url) <= 1000),
  repo TEXT NOT NULL CHECK(length(repo) <= 200),
  actor TEXT NOT NULL CHECK(length(actor) <= 100),
  status TEXT NOT NULL CHECK(status IN ('success','failure','warning','info')),
  summary TEXT NOT NULL CHECK(length(summary) <= 280),
  resolved INTEGER NOT NULL DEFAULT 0 CHECK(resolved IN (0,1))
);

CREATE INDEX held_events_due ON held_events(organization_id, integration_id, state, release_at);
CREATE INDEX held_events_state_due ON held_events(state, release_at);
CREATE INDEX held_events_failed ON held_events(state, released_at) WHERE state = 'failed';
CREATE INDEX held_events_released_in ON held_events(organization_id, released_in) WHERE released_in IS NOT NULL;
CREATE INDEX held_events_released_at ON held_events(released_at) WHERE released_at IS NOT NULL;

CREATE TABLE noise_open_failures (
  id INTEGER PRIMARY KEY,
  organization_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  key_hash TEXT NOT NULL CHECK(length(key_hash) = 32),
  opened_at INTEGER NOT NULL,
  UNIQUE(organization_id, integration_id, key_hash)
);

CREATE INDEX noise_open_failures_opened ON noise_open_failures(opened_at);
