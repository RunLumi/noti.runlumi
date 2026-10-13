CREATE TABLE IF NOT EXISTS auth_users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,password_hash TEXT,password_salt TEXT,verified_at INTEGER,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS auth_orgs(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS auth_memberships(user_id TEXT PRIMARY KEY REFERENCES auth_users(id),org_id TEXT NOT NULL REFERENCES auth_orgs(id),role TEXT NOT NULL CHECK(role IN ('admin','member')));
CREATE INDEX IF NOT EXISTS auth_memberships_org ON auth_memberships(org_id);
CREATE TABLE IF NOT EXISTS auth_tokens(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES auth_users(id),kind TEXT NOT NULL CHECK(kind IN ('verify','reset','session')),expires_at INTEGER NOT NULL,used_at INTEGER,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS auth_tokens_user ON auth_tokens(user_id,kind);
CREATE TABLE IF NOT EXISTS auth_invites(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES auth_orgs(id),email TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','member')),expires_at INTEGER NOT NULL,accepted_at INTEGER,created_by TEXT NOT NULL REFERENCES auth_users(id));
CREATE INDEX IF NOT EXISTS auth_invites_email ON auth_invites(email);
