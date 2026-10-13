import { integer, sqliteTable, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' });

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    activeOrganizationId: text('active_organization_id'),
  },
  (t) => [index('session_user_idx').on(t.userId)],
);

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (t) => [index('account_user_idx').on(t.userId)],
);

export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

export const organization = sqliteTable('organization', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logo: text('logo'),
  createdAt: timestamp('created_at').notNull(),
  metadata: text('metadata'),
});

export const member = sqliteTable(
  'member',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['admin', 'member'] }).notNull(),
    createdAt: timestamp('created_at').notNull(),
  },
  // NOT unique: a user may belong to several workspaces. The previous
  // `member_one_org_per_user` unique index was what actually blocked a second
  // membership, not Better Auth's `organizationLimit`. See migrations/0006.
  (t) => [
    index('member_user_idx').on(t.userId),
    uniqueIndex('member_user_org_unique').on(t.userId, t.organizationId),
    index('member_org_idx').on(t.organizationId),
  ],
);

export const invitation = sqliteTable(
  'invitation',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role', { enum: ['admin', 'member'] }),
    status: text('status').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    inviterId: text('inviter_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [index('invitation_org_idx').on(t.organizationId), index('invitation_email_idx').on(t.email)],
);

export const passkey = sqliteTable(
  'passkey',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    publicKey: text('public_key').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    credentialID: text('credential_id').notNull().unique(),
    counter: integer('counter').notNull(),
    deviceType: text('device_type').notNull(),
    backedUp: integer('backed_up', { mode: 'boolean' }).notNull(),
    transports: text('transports'),
    createdAt: timestamp('created_at'),
    aaguid: text('aaguid'),
  },
  (t) => [index('passkey_user_idx').on(t.userId)],
);

/**
 * GitHub App installations — the inbound tenant resolver.
 *
 * A verified webhook signature proves only that the request was signed with our
 * App-wide secret, which every installation of our App holds. This table is the only
 * authorized mapping from an inbound event to a workspace. `installation_id` comes
 * from the verified payload body; the X-GitHub-Hook-Installation-Target-* headers are
 * deliberately NOT used because their meaning for an App webhook is undocumented.
 */
export const githubInstallation = sqliteTable(
  'github_installations',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    installationId: text('installation_id').notNull(),
    appId: text('app_id').notNull(),
    accountLogin: text('account_login').notNull(),
    accountType: text('account_type', { enum: ['User', 'Organization'] }).notNull(),
    repositorySelection: text('repository_selection', { enum: ['all', 'selected'] }).notNull(),
    accessTokenCiphertext: text('access_token_ciphertext'),
    tokenExpiresAt: integer('token_expires_at'),
    status: text('status', { enum: ['active', 'suspended', 'uninstalled'] })
      .notNull()
      .default('active'),
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('github_installations_unique').on(t.installationId, t.appId),
    index('github_installations_org_idx').on(t.organizationId),
    index('github_installations_status_idx').on(t.status),
  ],
);

export const rateLimit = sqliteTable('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: integer('last_request').notNull(),
});
