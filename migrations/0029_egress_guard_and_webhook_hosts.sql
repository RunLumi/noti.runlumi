-- =============================================================================
-- 0029 - Platform egress guard (Discord) and generic-webhook host controls
--        (docs/specs/REMAINING.md 1.16; ADR 0029)
-- =============================================================================
-- 1. egress_guard_buckets: per provider and per MINUTE, how many outbound requests the PLATFORM made and
--    how many came back 401, 403 or 429 (Discord counts those toward a Cloudflare ban of our egress IP).
--    Platform-wide, NOT a tenant table: no organization_id, no integration id, no host, no URL. Counts only.
-- 2. egress_guard_state: one row per provider; `open_until` is the instant the global breaker closes.
-- 3. workspace_webhook_hosts: per-workspace allowlist of hostnames a custom webhook may use (tenant table).
-- 4. webhook_host_resolutions: the addresses a custom webhook's host last resolved to (tenant table).
--
-- Expand-only. ROLLBACK: the previous Worker ignores all four tables. To remove them:
--   DROP TABLE egress_guard_buckets; DROP TABLE egress_guard_state;
--   DROP TABLE workspace_webhook_hosts; DROP TABLE webhook_host_resolutions;
-- =============================================================================

CREATE TABLE egress_guard_buckets (
  provider TEXT NOT NULL CHECK(length(provider) <= 40),
  minute_start INTEGER NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0 CHECK(requests >= 0),
  invalid INTEGER NOT NULL DEFAULT 0 CHECK(invalid >= 0),
  PRIMARY KEY (provider, minute_start)
) WITHOUT ROWID;

CREATE TABLE egress_guard_state (
  provider TEXT PRIMARY KEY CHECK(length(provider) <= 40),
  open_until INTEGER NOT NULL DEFAULT 0,
  opened_at INTEGER,
  opened_count INTEGER NOT NULL DEFAULT 0,
  reason TEXT CHECK(reason IS NULL OR reason IN ('invalid_requests')),
  updated_at INTEGER NOT NULL
);

CREATE TABLE workspace_webhook_hosts (
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  host TEXT NOT NULL CHECK(length(host) BETWEEN 1 AND 253),
  created_by TEXT CHECK(created_by IS NULL OR length(created_by) <= 64),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (organization_id, host)
);

CREATE TABLE webhook_host_resolutions (
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL,
  host TEXT NOT NULL CHECK(length(host) BETWEEN 1 AND 253),
  addresses TEXT NOT NULL CHECK(length(addresses) <= 2048),
  status TEXT NOT NULL CHECK(status IN ('ok','blocked_address','unresolvable','lookup_failed','not_allowed')),
  resolved_at INTEGER NOT NULL,
  changed_count INTEGER NOT NULL DEFAULT 0 CHECK(changed_count >= 0),
  PRIMARY KEY (organization_id, integration_id)
);
CREATE INDEX webhook_host_resolutions_age ON webhook_host_resolutions(resolved_at);
