CREATE TABLE IF NOT EXISTS integrations (id TEXT PRIMARY KEY, repo TEXT NOT NULL, event_types TEXT NOT NULL, destination TEXT NOT NULL CHECK(destination IN ('lark','slack')), webhook_ciphertext TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS integrations_repo ON integrations(repo,enabled);
CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, integration_id TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
