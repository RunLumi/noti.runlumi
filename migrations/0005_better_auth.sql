-- Better Auth core, organization, passkey and database-backed rate limiting.
-- D1/SQLite; dates use epoch milliseconds to match Drizzle timestamp_ms.
-- Legacy auth_* tables from 0004 are intentionally retained for rollback,
-- but are not read by the Better Auth implementation.
CREATE TABLE IF NOT EXISTS "user" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "email_verified" INTEGER NOT NULL DEFAULT 0,
  "image" TEXT,
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "session" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "expires_at" INTEGER NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL,
  "ip_address" TEXT,
  "user_agent" TEXT,
  "user_id" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "active_organization_id" TEXT
);
CREATE INDEX IF NOT EXISTS "session_user_idx" ON "session"("user_id");
CREATE TABLE IF NOT EXISTS "account" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "account_id" TEXT NOT NULL,
  "provider_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "access_token" TEXT,
  "refresh_token" TEXT,
  "id_token" TEXT,
  "access_token_expires_at" INTEGER,
  "refresh_token_expires_at" INTEGER,
  "scope" TEXT,
  "password" TEXT,
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "account_user_idx" ON "account"("user_id");
CREATE TABLE IF NOT EXISTS "verification" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expires_at" INTEGER NOT NULL,
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification"("identifier");
CREATE TABLE IF NOT EXISTS "organization" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL UNIQUE,
  "logo" TEXT,
  "created_at" INTEGER NOT NULL,
  "metadata" TEXT
);
CREATE TABLE IF NOT EXISTS "member" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "organization_id" TEXT NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "user_id" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "role" TEXT NOT NULL CHECK ("role" IN ('admin', 'member')),
  "created_at" INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "member_one_org_per_user" ON "member"("user_id");
CREATE INDEX IF NOT EXISTS "member_org_idx" ON "member"("organization_id");
CREATE TABLE IF NOT EXISTS "invitation" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "organization_id" TEXT NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "email" TEXT NOT NULL,
  "role" TEXT CHECK ("role" IN ('admin', 'member')),
  "status" TEXT NOT NULL,
  "expires_at" INTEGER NOT NULL,
  "inviter_id" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "created_at" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "invitation_org_idx" ON "invitation"("organization_id");
CREATE INDEX IF NOT EXISTS "invitation_email_idx" ON "invitation"("email");
CREATE TABLE IF NOT EXISTS "passkey" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT,
  "public_key" TEXT NOT NULL,
  "user_id" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "credential_id" TEXT NOT NULL UNIQUE,
  "counter" INTEGER NOT NULL,
  "device_type" TEXT NOT NULL,
  "backed_up" INTEGER NOT NULL,
  "transports" TEXT,
  "created_at" INTEGER,
  "aaguid" TEXT
);
CREATE INDEX IF NOT EXISTS "passkey_user_idx" ON "passkey"("user_id");
CREATE TABLE IF NOT EXISTS "rate_limit" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "key" TEXT NOT NULL UNIQUE,
  "count" INTEGER NOT NULL,
  "last_request" INTEGER NOT NULL
);

-- Authorization rules enforced atomically inside SQLite for concurrent requests.
CREATE TRIGGER IF NOT EXISTS "member_preserve_admin_delete"
BEFORE DELETE ON "member"
WHEN OLD."role" = 'admin'
 AND NOT EXISTS (
   SELECT 1 FROM "member" WHERE "organization_id" = OLD."organization_id"
     AND "id" <> OLD."id" AND "role" = 'admin'
 )
BEGIN SELECT RAISE(ABORT, 'organization requires an admin'); END;

CREATE TRIGGER IF NOT EXISTS "member_preserve_admin_demote"
BEFORE UPDATE OF "role", "organization_id" ON "member"
WHEN OLD."role" = 'admin'
 AND (NEW."role" <> 'admin' OR NEW."organization_id" <> OLD."organization_id")
 AND NOT EXISTS (
   SELECT 1 FROM "member" WHERE "organization_id" = OLD."organization_id"
     AND "id" <> OLD."id" AND "role" = 'admin'
 )
BEGIN SELECT RAISE(ABORT, 'organization requires an admin'); END;
