-- =============================================================================
-- SUPERSEDED — DO NOT USE AS THE CURRENT DESIGN
-- =============================================================================
-- Replaced by 0005_better_auth.sql. This migration created the hand-rolled
-- identity tables: auth_users, auth_orgs, auth_memberships, auth_tokens,
-- auth_invites. None of them are read or written by the application any more;
-- identity is owned by Better Auth (see docs/adr/0003-better-auth.md).
--
-- It is kept in the chain because it has already been applied to live
-- databases and migrations are forward-only. A fresh database still creates
-- these six unused tables.
--
-- ⚠️  auth_tokens HAS NO HASH COLUMN.
--     It stored session/verify/reset tokens as plaintext. Any code that reads
--     this table reads live bearer credentials. Better Auth's own `session`
--     table has the same property by design and there is no hashing option —
--     see docs/specs/15-security-and-compliance.md for the accepted risk.
--     Nothing should read this table at all.
--
-- Docs/specs/02-identity-tenancy.md F31 covers retiring it. Because it is
-- already applied, retirement means marking it deprecated rather than dropping
-- it; a destructive migration needs the rollback strategy AGENTS.md requires.
-- =============================================================================

CREATE TABLE IF NOT EXISTS auth_users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,password_hash TEXT,password_salt TEXT,verified_at INTEGER,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS auth_orgs(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS auth_memberships(user_id TEXT PRIMARY KEY REFERENCES auth_users(id),org_id TEXT NOT NULL REFERENCES auth_orgs(id),role TEXT NOT NULL CHECK(role IN ('admin','member')));
CREATE INDEX IF NOT EXISTS auth_memberships_org ON auth_memberships(org_id);
CREATE TABLE IF NOT EXISTS auth_tokens(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES auth_users(id),kind TEXT NOT NULL CHECK(kind IN ('verify','reset','session')),expires_at INTEGER NOT NULL,used_at INTEGER,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS auth_tokens_user ON auth_tokens(user_id,kind);
CREATE TABLE IF NOT EXISTS auth_invites(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES auth_orgs(id),email TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','member')),expires_at INTEGER NOT NULL,accepted_at INTEGER,created_by TEXT NOT NULL REFERENCES auth_users(id));
CREATE INDEX IF NOT EXISTS auth_invites_email ON auth_invites(email);