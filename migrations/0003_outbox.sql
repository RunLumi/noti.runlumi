CREATE TABLE IF NOT EXISTS notification_outbox (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','dispatched')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, dispatched_at TEXT);
CREATE INDEX IF NOT EXISTS notification_outbox_pending ON notification_outbox(state,created_at);
