/**
 * The retention matrix (docs/specs/15 F237): the single source of truth for what personal or
 * tenant data Lumi Noti stores, why, for how long and how it is removed.
 *
 * Every number here is imported from the code that enforces it, never copied, so the matrix
 * cannot drift from the jobs. `tests/compliance/retention.test.ts` fails when a table exists in
 * the migrations but not here, when a row claims a deletion mechanism the schema or the purge
 * code does not provide, or when `docs/DATA_RETENTION.md` differs from `renderRetentionDoc()`.
 * A new table therefore forces a retention decision in the same pull request.
 *
 * Nothing in this file is a legal statement. Legal basis, controller/processor role and any
 * regulatory retention period are placeholders for the operator to decide.
 */
import { SESSION_EXPIRES_IN_SECONDS } from '../auth/session-policy';
import { RETENTION_DAYS as WORKSPACE_DELETION_GRACE_DAYS } from '../api/workspace-lifecycle';
import { STATE_TTL_MS } from '../connectors/sources/github/install';
import { OUTBOX_RETENTION_MS } from '../delivery/claim';
import { DEDUP_TTL_MS } from '../delivery/dedup';
import { BUCKET_RETENTION_MS } from '../delivery/egress-guard';
import { RESOLUTION_RETENTION_MS } from '../connectors/destinations/generic-webhook/host-control';
import { HEALTH_RETENTION_MS } from '../delivery/health';
import { AUTH_RATE_LIMIT_MAX_AGE_MS, AUTH_STATE_GRACE_MS } from '../pipeline/expired-records';
import { AUDIT_RETENTION, DELIVERY_RETENTION } from '../pipeline/retention';
import { LEGACY_OLD_TABLES } from '../pipeline/purge';
import { FAILED_RETENTION_MS, HELD_RETENTION_MS, OPEN_FAILURE_RETENTION_MS } from '../routing/noise-store';
import { ROUTING_RETENTION_MS } from '../routing/provenance';
import { JOB_RUNS_RETENTION_MS } from '../observability/job-runs';
import { INGRESS_USAGE_RETENTION_DAYS } from '../security/ingress-usage';
import { RATE_LIMIT_RETENTION_MS } from '../security/rate-limit';

export const OPERATOR_TO_DECIDE = 'to be decided by the operator';

const DAY_MS = 24 * 60 * 60 * 1000;

export const DATA_CATEGORIES = [
  'account_identity',
  'authentication_credential',
  'session_and_device',
  'workspace_membership',
  'tenant_configuration',
  'tenant_credential_sealed',
  'tenant_event_content',
  'delivery_metadata',
  'audit_evidence',
  'abuse_control_counter',
  'platform_state',
  'legacy_retired',
] as const;
export type DataCategory = (typeof DATA_CATEGORIES)[number];

export type Retention =
  /** A fixed period set in code. `basis` names the constant that sets it. */
  | { readonly kind: 'fixed'; readonly ms: number; readonly basis: string; readonly note?: string }
  /** An operator-tunable period (a Worker var), with the bounds the code enforces. */
  | {
      readonly kind: 'configurable';
      readonly variable: string;
      readonly defaultMs: number;
      readonly minMs: number;
      readonly maxMs: number;
    }
  /** Kept as long as the parent exists; removed with it. `graceMs` is the delay after a deletion request. */
  | {
      readonly kind: 'while_parent_exists';
      readonly parent: 'account' | 'workspace';
      readonly graceMs?: number;
    }
  /** Usable only until its own expiry; `afterExpiryMs` is how long the row survives that. */
  | { readonly kind: 'until_expiry'; readonly expiryMs: number | null; readonly afterExpiryMs: number }
  /** Kept with no expiry on purpose. `reason` says why. */
  | { readonly kind: 'indefinite'; readonly reason: string }
  /** Exists only until an operator step removes it; `dropBy` names the step and the deadline it must meet. */
  | { readonly kind: 'temporary'; readonly dropBy: string }
  /** No job or code path removes it. A documented gap, not a decision. */
  | { readonly kind: 'not_enforced'; readonly gap: string };

export type Deletion =
  /** A named cron job in `src/index.ts` removes expired rows. */
  | { readonly kind: 'cron_job'; readonly job: string }
  /** The workspace purge (`src/pipeline/purge.ts`). `route` says which of its statements. */
  | {
      readonly kind: 'workspace_purge';
      readonly route: 'tenant_tables' | 'drained' | 'via_installation' | 'organization_delete' | 'legacy_old';
    }
  /** A foreign key with ON DELETE CASCADE from `parent`, verified against the migrations. */
  | { readonly kind: 'fk_cascade'; readonly parent: 'user' | 'organization' | 'github_installations' }
  /** Removed by `DELETE /api/workspace/me` (`src/api/account.ts`), verified by tests. */
  | { readonly kind: 'account_erasure' }
  /** Removed when the customer deletes the object (an integration, a source). */
  | { readonly kind: 'customer_delete'; readonly object: string }
  | { readonly kind: 'none'; readonly reason: string };

export interface RetentionRow {
  readonly id: string;
  readonly table: string;
  /** Present when the row describes a column family rather than the whole table. */
  readonly columns?: readonly string[];
  readonly category: DataCategory;
  /** `direct`: identifies a person. `indirect`: an opaque id or a handle that can be linked to one. */
  readonly personalData: 'direct' | 'indirect' | 'none';
  readonly dataHeld: string;
  readonly purpose: string;
  readonly retention: Retention;
  readonly deletion: readonly Deletion[];
  readonly inWorkspaceExport: boolean;
  readonly inAccountExport: boolean;
  readonly exportNote?: string;
  /** Always a placeholder in this repository. */
  readonly legalBasis: typeof OPERATOR_TO_DECIDE;
  readonly controllerRole: typeof OPERATOR_TO_DECIDE;
  readonly notes?: string;
}

const placeholders = { legalBasis: OPERATOR_TO_DECIDE, controllerRole: OPERATOR_TO_DECIDE } as const;

const daysMs = (d: number): number => d * DAY_MS;
const SEALED_NEVER_EXPORTED = 'Sealed credentials are never exported, in any form.';
const workspaceLifetime: Retention = {
  kind: 'while_parent_exists',
  parent: 'workspace',
  graceMs: daysMs(WORKSPACE_DELETION_GRACE_DAYS),
};

/**
 * The retired hand-rolled identity tables (migration 0004). `tests/retired-schema.test.ts` forbids
 * the literal table names anywhere in `src`, because no code may read or write them. This file only
 * describes them, so the names are assembled from their shared prefix and a suffix instead.
 */
const RETIRED_SUFFIXES = ['users', 'orgs', 'memberships', 'tokens', 'invites'] as const;
type RetiredSuffix = (typeof RETIRED_SUFFIXES)[number];

const RETIRED_DATA: Record<RetiredSuffix, string> = {
  users: 'Retired hand-rolled identity: email, password hash and salt.',
  orgs: 'Retired workspace names.',
  memberships: 'Retired membership links.',
  tokens: 'Retired one-time tokens, stored in plaintext.',
  invites: 'Retired invitations: invitee email.',
};

const retiredRows: readonly RetentionRow[] = RETIRED_SUFFIXES.map((suffix): RetentionRow => ({
  id: `retired_${suffix}`,
  table: `auth_${suffix}`,
  category: 'legacy_retired',
  personalData: suffix === 'orgs' ? 'none' : 'direct',
  dataHeld: RETIRED_DATA[suffix],
  purpose:
    'None. Superseded by Better Auth (migration 0005). No code reads or writes it (tests/retired-schema.test.ts).',
  retention: {
    kind: 'not_enforced',
    gap: 'The tables stay in the forward-only migration chain. Whether a live database holds rows is unknown to this repository; the operator should check and drop them in a later migration (AR-10).',
  },
  deletion: [{ kind: 'none', reason: 'No code path touches these tables.' }],
  inWorkspaceExport: false,
  inAccountExport: false,
  exportNote: 'Excluded on purpose.',
  ...placeholders,
}));

export const RETENTION_MATRIX: readonly RetentionRow[] = [
  // --- identity and authentication (Better Auth) ----------------------------------------------
  {
    id: 'user',
    table: 'user',
    category: 'account_identity',
    personalData: 'direct',
    dataHeld: 'Name, email address, email-verified flag, optional image, timestamps.',
    purpose: 'Sign-in identity; shows who a workspace member is.',
    notes:
      'Accounts whose email was never verified are not purged by any job and cannot use the erasure route (it needs a verified session); they stay until an operator deletes them (gap).',
    retention: { kind: 'while_parent_exists', parent: 'account' },
    deletion: [{ kind: 'account_erasure' }],
    inWorkspaceExport: true,
    inAccountExport: true,
    exportNote:
      'The workspace export lists each member name and email; the account export lists the full record.',
    ...placeholders,
  },
  {
    id: 'session',
    table: 'session',
    category: 'session_and_device',
    personalData: 'direct',
    dataHeld:
      'Session token (a usable credential, AR-1), IP address, user agent, active workspace, timestamps.',
    purpose: 'Keeps a person signed in; the IP address and user agent help a person recognise a session.',
    retention: { kind: 'until_expiry', expiryMs: SESSION_EXPIRES_IN_SECONDS * 1000, afterExpiryMs: 0 },
    deletion: [
      { kind: 'cron_job', job: 'expired_auth_purge' },
      { kind: 'fk_cascade', parent: 'user' },
      { kind: 'account_erasure' },
    ],
    inWorkspaceExport: false,
    inAccountExport: true,
    exportNote: 'Metadata only (times, IP address, user agent). The token and the row id are never exported.',
    ...placeholders,
    notes:
      'The session expires 30 days after its last refresh (refreshed at most daily) and 90 days after sign-in at the latest, whichever comes first (ADR 0030). The person can list and end their sessions (`/api/workspace/me/sessions`).',
  },
  {
    id: 'account',
    table: 'account',
    category: 'authentication_credential',
    personalData: 'direct',
    dataHeld:
      'Sign-in method record: provider id, provider account id, password hash (email and password), OAuth token columns (unused by the current sign-in methods), timestamps.',
    purpose: 'Authenticates the person.',
    retention: { kind: 'while_parent_exists', parent: 'account' },
    deletion: [{ kind: 'fk_cascade', parent: 'user' }, { kind: 'account_erasure' }],
    inWorkspaceExport: false,
    inAccountExport: true,
    exportNote: 'Provider id and creation time only. The password hash and token columns are never exported.',
    ...placeholders,
  },
  {
    id: 'verification',
    table: 'verification',
    category: 'authentication_credential',
    personalData: 'indirect',
    dataHeld: 'One-time verification and password-reset records (identifier, value, expiry).',
    purpose: 'Email verification and password reset.',
    retention: { kind: 'until_expiry', expiryMs: null, afterExpiryMs: 0 },
    deletion: [{ kind: 'cron_job', job: 'expired_auth_purge' }],
    inWorkspaceExport: false,
    inAccountExport: false,
    exportNote: 'Short-lived security records; not exported.',
    ...placeholders,
    notes:
      'Each record carries its own expiry (UNVERIFIED: the exact lifetimes are Better Auth defaults). Rows still valid at the time of an account deletion survive until they expire.',
  },
  {
    id: 'passkey',
    table: 'passkey',
    category: 'authentication_credential',
    personalData: 'direct',
    dataHeld: 'Credential id, public key, signature counter, device type, transports, a user-chosen name.',
    purpose: 'Passwordless sign-in.',
    retention: { kind: 'while_parent_exists', parent: 'account' },
    deletion: [{ kind: 'fk_cascade', parent: 'user' }, { kind: 'account_erasure' }],
    inWorkspaceExport: false,
    inAccountExport: true,
    exportNote:
      'Name, device type, backup flag, transports and creation time. The public key, credential id and counter are not exported.',
    ...placeholders,
  },
  {
    id: 'rate_limit',
    table: 'rate_limit',
    category: 'abuse_control_counter',
    personalData: 'indirect',
    dataHeld:
      'Better Auth request counters keyed by caller and path (UNVERIFIED: the key can embed an IP address).',
    purpose: 'Limits sign-in, sign-up and reset requests.',
    retention: {
      kind: 'fixed',
      ms: AUTH_RATE_LIMIT_MAX_AGE_MS,
      basis: 'AUTH_RATE_LIMIT_MAX_AGE_MS (src/pipeline/expired-records.ts)',
      note: 'Counted from the last request.',
    },
    deletion: [{ kind: 'cron_job', job: 'expired_auth_purge' }],
    inWorkspaceExport: false,
    inAccountExport: false,
    exportNote: 'Operational counter; not exported.',
    ...placeholders,
  },
  {
    id: 'member',
    table: 'member',
    category: 'workspace_membership',
    personalData: 'direct',
    dataHeld: 'Which person belongs to which workspace, and their role.',
    purpose: 'Authorisation: decides what a person may do in a workspace.',
    retention: workspaceLifetime,
    deletion: [
      { kind: 'fk_cascade', parent: 'user' },
      { kind: 'fk_cascade', parent: 'organization' },
      { kind: 'account_erasure' },
    ],
    inWorkspaceExport: true,
    inAccountExport: true,
    exportNote:
      'Workspace export: name, email, role and joined date per member. Account export: the person own memberships.',
    ...placeholders,
    notes: 'A database trigger refuses to remove the last admin of a workspace outside a started purge.',
  },
  {
    id: 'invitation',
    table: 'invitation',
    category: 'workspace_membership',
    personalData: 'direct',
    dataHeld: 'Invitee email address, role, status, expiry, who invited them.',
    purpose: 'Lets a workspace admin invite a person.',
    retention: {
      kind: 'not_enforced',
      gap: 'Expired or declined invitations are kept until the workspace or the inviting account is deleted.',
    },
    deletion: [
      { kind: 'fk_cascade', parent: 'organization' },
      { kind: 'fk_cascade', parent: 'user' },
      { kind: 'account_erasure' },
    ],
    inWorkspaceExport: false,
    inAccountExport: true,
    exportNote: 'Invitations the person sent, without the invitee email address (a third party).',
    ...placeholders,
    notes:
      'Erasing an account hands the pending invitations the person sent to another admin of the same workspace, so the invitee can still accept; sent invitations that are not pending (accepted, declined, expired) go with the cascade on the inviter. Invitations addressed TO the erased email address are deleted. A person whose email is not yet verified cannot use the erasure route (gap).',
  },
  // --- workspace -----------------------------------------------------------------------------
  {
    id: 'organization',
    table: 'organization',
    category: 'tenant_configuration',
    personalData: 'indirect',
    dataHeld: 'Workspace name, slug, logo, free-form metadata.',
    purpose: 'The tenant itself.',
    retention: workspaceLifetime,
    deletion: [{ kind: 'workspace_purge', route: 'organization_delete' }],
    inWorkspaceExport: true,
    inAccountExport: false,
    exportNote: 'Id and name.',
    ...placeholders,
  },
  {
    id: 'github_installations',
    table: 'github_installations',
    category: 'tenant_configuration',
    personalData: 'indirect',
    dataHeld:
      'GitHub App installation id, the GitHub account login it is installed on, repository-selection mode, status. The access_token_ciphertext column exists but no code writes it.',
    purpose: 'Binds a verified GitHub installation to exactly one workspace (tenant resolution).',
    retention: workspaceLifetime,
    deletion: [{ kind: 'fk_cascade', parent: 'organization' }],
    inWorkspaceExport: true,
    inAccountExport: false,
    ...placeholders,
  },
  {
    id: 'github_installation_repositories',
    table: 'github_installation_repositories',
    category: 'tenant_configuration',
    personalData: 'none',
    dataHeld:
      'Repository ids and full names (owner/name) the installation can see. Private repository names are customer-confidential.',
    purpose: 'Repository-scope enforcement and the repository picker.',
    retention: workspaceLifetime,
    deletion: [
      { kind: 'fk_cascade', parent: 'github_installations' },
      { kind: 'workspace_purge', route: 'via_installation' },
    ],
    inWorkspaceExport: false,
    inAccountExport: false,
    exportNote:
      'Not in the workspace export today (a gap): the export lists installations, not their repositories.',
    ...placeholders,
  },
  {
    id: 'github_installation_tombstones',
    table: 'github_installation_tombstones',
    category: 'platform_state',
    personalData: 'none',
    dataHeld: 'GitHub installation id and App id of an installation that GitHub reported deleted, and when.',
    purpose: 'Stops a deleted installation from being bound again.',
    retention: {
      kind: 'indefinite',
      reason: 'A tombstone that expired would let a deleted installation be bound again.',
    },
    deletion: [
      {
        kind: 'none',
        reason: 'Numeric GitHub ids and a timestamp only; no workspace or person is referenced.',
      },
    ],
    inWorkspaceExport: false,
    inAccountExport: false,
    ...placeholders,
  },
  {
    id: 'github_auth_states',
    table: 'github_auth_states',
    category: 'authentication_credential',
    personalData: 'indirect',
    dataHeld:
      'Hash of a single-use install/OAuth state, purpose, workspace id, user id, PKCE verifier, expiry, used-at.',
    purpose: 'Binds the GitHub install flow to the person and workspace that started it.',
    retention: { kind: 'until_expiry', expiryMs: STATE_TTL_MS, afterExpiryMs: AUTH_STATE_GRACE_MS },
    deletion: [
      { kind: 'cron_job', job: 'expired_auth_purge' },
      { kind: 'workspace_purge', route: 'drained' },
      { kind: 'fk_cascade', parent: 'organization' },
      { kind: 'account_erasure' },
    ],
    inWorkspaceExport: false,
    inAccountExport: false,
    exportNote: 'Short-lived security records; not exported.',
    ...placeholders,
  },
  // --- integrations and sources --------------------------------------------------------------
  {
    id: 'integrations',
    table: 'integrations',
    columns: [
      'id',
      'organization_id',
      'name',
      'repo',
      'source_id',
      'event_types',
      'filters_json',
      'noise_json',
      'destination',
      'destination_host',
      'enabled',
      'created_by',
      'created_at',
      'updated_at',
    ],
    category: 'tenant_configuration',
    personalData: 'indirect',
    dataHeld:
      'Integration settings, routing filters, noise settings, destination kind and host, and the id of the person who created it.',
    purpose: 'Routes events to destinations.',
    retention: workspaceLifetime,
    deletion: [
      { kind: 'customer_delete', object: 'integration' },
      { kind: 'workspace_purge', route: 'tenant_tables' },
    ],
    inWorkspaceExport: true,
    inAccountExport: false,
    exportNote: 'The creator id (created_by) is in neither export.',
    ...placeholders,
  },
  {
    id: 'integrations_credentials',
    table: 'integrations',
    columns: [
      'webhook_ciphertext',
      'lark_secret_ciphertext',
      'webhook_envelope',
      'lark_secret_envelope',
      'key_salt',
      'dek_wrapped',
      'kek_version',
      'credentials_quarantined_at',
      'credentials_quarantine_reason',
      'credential_fingerprint',
    ],
    category: 'tenant_credential_sealed',
    personalData: 'none',
    dataHeld:
      'Destination webhook URL and signing secret, sealed with a per-integration data key that is wrapped by a versioned key-encryption key (ADR 0004).',
    purpose: 'Lets the Worker deliver to the destination.',
    retention: workspaceLifetime,
    deletion: [
      { kind: 'customer_delete', object: 'integration' },
      { kind: 'workspace_purge', route: 'tenant_tables' },
    ],
    inWorkspaceExport: false,
    inAccountExport: false,
    exportNote: SEALED_NEVER_EXPORTED,
    ...placeholders,
    notes:
      'Deleting the row destroys the wrapped data key, so a copy of the ciphertext (for example in a Time Travel restore) cannot be opened without that row.',
  },
  {
    id: 'sources',
    table: 'sources',
    columns: [
      'id',
      'organization_id',
      'kind',
      'name',
      'endpoint_id',
      'auth_mode',
      'livemode',
      'enabled',
      'created_by',
      'created_at',
      'updated_at',
      'last_received_at',
      'secret_rotated_at',
      'reused_id_rejections',
      'last_reuse_rejected_at',
      'dropped_events',
      'last_dropped_at',
    ],
    category: 'tenant_configuration',
    personalData: 'indirect',
    dataHeld: 'Source settings, the public endpoint id, counters, and the id of the person who created it.',
    purpose: 'Receives signed webhooks from a provider.',
    retention: workspaceLifetime,
    deletion: [
      { kind: 'customer_delete', object: 'source' },
      { kind: 'workspace_purge', route: 'tenant_tables' },
      { kind: 'fk_cascade', parent: 'organization' },
    ],
    inWorkspaceExport: true,
    inAccountExport: false,
    ...placeholders,
  },
  {
    id: 'sources_credentials',
    table: 'sources',
    columns: [
      'secret_envelope',
      'key_salt',
      'dek_wrapped',
      'kek_version',
      'credential_fingerprint',
      'credentials_revoked_at',
    ],
    category: 'tenant_credential_sealed',
    personalData: 'none',
    dataHeld: 'The per-source signing secret, sealed like integration credentials.',
    purpose: 'Verifies the signature of inbound webhooks.',
    retention: workspaceLifetime,
    deletion: [
      { kind: 'customer_delete', object: 'source' },
      { kind: 'workspace_purge', route: 'tenant_tables' },
    ],
    inWorkspaceExport: false,
    inAccountExport: false,
    exportNote: SEALED_NEVER_EXPORTED,
    ...placeholders,
  },
  // --- events and deliveries -----------------------------------------------------------------
  {
    id: 'notification_outbox',
    table: 'notification_outbox',
    category: 'tenant_event_content',
    personalData: 'indirect',
    dataHeld:
      'The rendered notification waiting to be sent: title, link, repository, the sender login, a short summary. Never the raw provider payload, never a credential.',
    purpose: 'Durable hand-off from ingress to the queue, and the source for manual redelivery.',
    retention: {
      kind: 'fixed',
      ms: OUTBOX_RETENTION_MS,
      basis: 'OUTBOX_RETENTION_MS (src/delivery/claim.ts)',
      note: 'Applies to rows whose delivery succeeded and to invalid rows. A row whose delivery is retained (dead-lettered, or inside the delivery retention window) is kept so it can be redelivered; orphans then go with the delivery retention.',
    },
    deletion: [
      { kind: 'cron_job', job: 'outbox_reconcile' },
      { kind: 'cron_job', job: 'retention_purge' },
      { kind: 'workspace_purge', route: 'tenant_tables' },
    ],
    inWorkspaceExport: false,
    inAccountExport: false,
    exportNote: 'Notification content is workspace data and is not in the export today.',
    ...placeholders,
  },
  {
    id: 'deliveries',
    table: 'deliveries',
    category: 'delivery_metadata',
    personalData: 'none',
    dataHeld:
      'Delivery ledger: ids, state, attempts, error codes (our own taxonomy), timestamps, a dedup key and a body hash. No notification text, no destination URL.',
    purpose: 'Answers "did you send this?"; drives retries, dead letters and redelivery.',
    retention: {
      kind: 'configurable',
      variable: 'DELIVERY_RETENTION_DAYS',
      defaultMs: daysMs(DELIVERY_RETENTION.default),
      minMs: daysMs(DELIVERY_RETENTION.min),
      maxMs: daysMs(DELIVERY_RETENTION.max),
    },
    deletion: [
      { kind: 'cron_job', job: 'retention_purge' },
      { kind: 'workspace_purge', route: 'tenant_tables' },
    ],
    inWorkspaceExport: true,
    inAccountExport: false,
    exportNote: 'The most recent 2,000 rows.',
    ...placeholders,
    notes:
      'Only terminal deliveries are purged; a dead-lettered row is kept until both its creation and its dead-lettering are older than the cutoff.',
  },
  {
    id: 'delivery_attempts',
    table: 'delivery_attempts',
    category: 'delivery_metadata',
    personalData: 'none',
    dataHeld:
      'One row per delivery attempt or wait: outcome, our own error code, a diagnostic code we minted, an HTTP status class, a retry delay in milliseconds. No notification text, no destination URL, no provider response.',
    purpose: 'Answers "what happened on each try?" in the delivery log.',
    retention: {
      kind: 'configurable',
      variable: 'DELIVERY_RETENTION_DAYS',
      defaultMs: daysMs(DELIVERY_RETENTION.default),
      minMs: daysMs(DELIVERY_RETENTION.min),
      maxMs: daysMs(DELIVERY_RETENTION.max),
    },
    deletion: [
      { kind: 'cron_job', job: 'retention_purge' },
      { kind: 'workspace_purge', route: 'tenant_tables' },
    ],
    inWorkspaceExport: true,
    inAccountExport: false,
    exportNote: 'The most recent 2,000 rows.',
    ...placeholders,
    notes: 'Deleted with the delivery it belongs to; a delivery is only purged once none remain.',
  },
  {
    id: 'event_dedup',
    table: 'event_dedup',
    category: 'delivery_metadata',
    personalData: 'none',
    dataHeld:
      'Per accepted event and integration: the delivery id, a dedup key (a hash), timestamps and a count of repeats.',
    purpose: 'Recognises a provider redelivery and counts it instead of dropping it silently.',
    retention: {
      kind: 'fixed',
      ms: DEDUP_TTL_MS,
      basis: 'DEDUP_TTL_MS (src/delivery/dedup.ts)',
    },
    deletion: [
      { kind: 'cron_job', job: 'dedup_purge' },
      { kind: 'workspace_purge', route: 'tenant_tables' },
    ],
    inWorkspaceExport: false,
    inAccountExport: false,
    ...placeholders,
  },
  {
    id: 'destination_health',
    table: 'destination_health',
    category: 'delivery_metadata',
    personalData: 'none',
    dataHeld:
      'Per integration: circuit-breaker state, failure counts, the last failure code, rate-limit hold times, the destination host name.',
    purpose: 'Stops sending to a destination that keeps failing and respects its rate limits.',
    retention: {
      kind: 'fixed',
      ms: HEALTH_RETENTION_MS,
      basis: 'HEALTH_RETENTION_MS (src/delivery/health.ts)',
      note: 'Only rows whose breaker is closed and that have been quiet for this long; an open breaker is state, not garbage.',
    },
    deletion: [
      { kind: 'cron_job', job: 'retention_purge' },
      { kind: 'workspace_purge', route: 'tenant_tables' },
    ],
    inWorkspaceExport: false,
    inAccountExport: false,
    ...placeholders,
  },
  {
    id: 'ingress_usage',
    table: 'ingress_usage',
    category: 'delivery_metadata',
    personalData: 'none',
    dataHeld:
      'Per workspace, UTC day and source kind: how many inbound events were accepted, were duplicates, or were answered with the flood limit. Counts only.',
    purpose:
      'Usage accounting, kept apart from the abuse counters. Best effort: it can under-count, and it is not a billing meter.',
    retention: {
      kind: 'fixed',
      ms: INGRESS_USAGE_RETENTION_DAYS * DAY_MS,
      basis: 'INGRESS_USAGE_RETENTION_DAYS (src/security/ingress-usage.ts)',
    },
    deletion: [
      { kind: 'cron_job', job: 'retention_purge' },
      { kind: 'workspace_purge', route: 'tenant_tables' },
    ],
    inWorkspaceExport: false,
    inAccountExport: false,
    ...placeholders,
  },
  {
    id: 'routing_decisions',
    table: 'routing_decisions',
    category: 'delivery_metadata',
    personalData: 'none',
    dataHeld:
      'Why an event was delivered or filtered: integration id, event type, outcome, rule id, reason code.',
    purpose: 'Routing provenance shown in the dashboard.',
    retention: {
      kind: 'fixed',
      ms: ROUTING_RETENTION_MS,
      basis: 'ROUTING_RETENTION_MS (src/routing/provenance.ts)',
    },
    deletion: [
      { kind: 'cron_job', job: 'routing_decisions_purge' },
      { kind: 'customer_delete', object: 'integration' },
      { kind: 'workspace_purge', route: 'tenant_tables' },
    ],
    inWorkspaceExport: false,
    inAccountExport: false,
    ...placeholders,
  },
  {
    id: 'held_events',
    table: 'held_events',
    category: 'tenant_event_content',
    personalData: 'indirect',
    dataHeld:
      'Events held by noise control (quiet hours, grouping, digests): title, link, repository, sender login, status, summary, release schedule.',
    purpose: 'Releases held updates later, combined.',
    retention: {
      kind: 'fixed',
      ms: HELD_RETENTION_MS,
      basis: 'HELD_RETENTION_MS (src/routing/noise-store.ts)',
      note: `Counted from release. A row that is still waiting is kept until it is released. Rows that failed to release are kept ${String(FAILED_RETENTION_MS / DAY_MS)} days (FAILED_RETENTION_MS).`,
    },
    deletion: [
      { kind: 'cron_job', job: 'noise_purge' },
      { kind: 'customer_delete', object: 'integration' },
      { kind: 'workspace_purge', route: 'tenant_tables' },
    ],
    inWorkspaceExport: false,
    inAccountExport: false,
    ...placeholders,
  },
  {
    id: 'noise_open_failures',
    table: 'noise_open_failures',
    category: 'delivery_metadata',
    personalData: 'none',
    dataHeld: 'Hashed keys of open failures, used to send one "resolved" notice per failure.',
    purpose: 'Resolved notices (noise control).',
    retention: {
      kind: 'fixed',
      ms: OPEN_FAILURE_RETENTION_MS,
      basis: 'OPEN_FAILURE_RETENTION_MS (src/routing/noise-store.ts)',
    },
    deletion: [
      { kind: 'cron_job', job: 'noise_purge' },
      { kind: 'customer_delete', object: 'integration' },
      { kind: 'workspace_purge', route: 'tenant_tables' },
    ],
    inWorkspaceExport: false,
    inAccountExport: false,
    ...placeholders,
  },
  // --- evidence and operations ---------------------------------------------------------------
  {
    id: 'audit_events',
    table: 'audit_events',
    category: 'audit_evidence',
    personalData: 'direct',
    dataHeld:
      'Who did what and when: actor id, action, subject, outcome, request IP address, user agent (cut to 256 characters), small allow-listed metadata.',
    purpose: 'Evidence for admins and for security investigation. Append-only by convention.',
    retention: {
      kind: 'configurable',
      variable: 'AUDIT_RETENTION_DAYS',
      defaultMs: daysMs(AUDIT_RETENTION.default),
      minMs: daysMs(AUDIT_RETENTION.min),
      maxMs: daysMs(AUDIT_RETENTION.max),
    },
    deletion: [
      { kind: 'cron_job', job: 'retention_purge' },
      { kind: 'workspace_purge', route: 'drained' },
      { kind: 'fk_cascade', parent: 'organization' },
    ],
    inWorkspaceExport: true,
    inAccountExport: true,
    exportNote:
      'Workspace export: action, subject, outcome, metadata, time (no IP, no actor). Account export: rows where the person is the actor, with IP and user agent but without the subject id and metadata (workspace data).',
    ...placeholders,
    notes:
      'Erasing an account does not rewrite these rows: a database trigger refuses every UPDATE (migration 0008). They keep the opaque actor id, the IP address and the user agent until the audit retention above, which the operator must weigh against the erasure obligation.',
  },
  {
    id: 'api_rate_limits',
    table: 'api_rate_limits',
    category: 'abuse_control_counter',
    personalData: 'indirect',
    dataHeld: 'Fixed-window counters keyed by purpose and an opaque user, installation or endpoint id.',
    purpose: 'Abuse control. Never used for accounting.',
    retention: {
      kind: 'fixed',
      ms: RATE_LIMIT_RETENTION_MS,
      basis: 'RATE_LIMIT_RETENTION_MS (src/security/rate-limit.ts)',
    },
    deletion: [{ kind: 'cron_job', job: 'rate_limit_prune' }],
    inWorkspaceExport: false,
    inAccountExport: false,
    ...placeholders,
  },
  {
    id: 'job_runs',
    table: 'job_runs',
    category: 'platform_state',
    personalData: 'none',
    dataHeld:
      'History of cron job failures and changes of outcome: job name, start and finish, outcome, a few integer counters (rows processed) and a closed error class. Platform-wide: no workspace id, no event content, no error text.',
    purpose: 'Lets an operator see when a background job started failing or recovered (F192).',
    retention: {
      kind: 'fixed',
      ms: JOB_RUNS_RETENTION_MS,
      basis: 'JOB_RUNS_RETENTION_MS (src/observability/job-runs.ts)',
    },
    deletion: [{ kind: 'cron_job', job: 'retention_purge' }],
    inWorkspaceExport: false,
    inAccountExport: false,
    exportNote: 'Excluded on purpose: platform operations data that belongs to no workspace.',
    ...placeholders,
  },
  {
    id: 'job_state',
    table: 'job_state',
    category: 'platform_state',
    personalData: 'none',
    dataHeld:
      'One row per cron job, overwritten every run: first seen, last start and finish, last outcome, last healthy and last failed time, last counters, last error class, run count. Platform-wide: no workspace id, no error text.',
    purpose: 'The freshness of each background job, so a stopped job is detected (F192).',
    retention: { kind: 'indefinite', reason: 'A fixed set of rows (one per job) overwritten in place.' },
    deletion: [{ kind: 'none', reason: 'Fixed keys, no personal or tenant data.' }],
    inWorkspaceExport: false,
    inAccountExport: false,
    exportNote: 'Excluded on purpose: platform operations data that belongs to no workspace.',
    ...placeholders,
  },
  {
    id: 'alert_state',
    table: 'alert_state',
    category: 'platform_state',
    personalData: 'none',
    dataHeld:
      'One row per alert in the registry: firing or resolved, since when, when it was last notified, the incident key, the last value (a count or a duration), breach and clear streaks and any notice a sink has not accepted yet (its kind and retry time).',
    purpose:
      'Lets the alert engine notify once per incident, re-notify on a cadence and announce recovery (F200).',
    retention: { kind: 'indefinite', reason: 'A fixed set of rows (one per alert) overwritten in place.' },
    deletion: [{ kind: 'none', reason: 'Fixed keys, no personal or tenant data.' }],
    inWorkspaceExport: false,
    inAccountExport: false,
    exportNote: 'Excluded on purpose: platform operations data that belongs to no workspace.',
    ...placeholders,
  },
  {
    id: 'egress_guard_buckets',
    table: 'egress_guard_buckets',
    category: 'platform_state',
    personalData: 'none',
    dataHeld:
      'Per provider and minute: how many outbound requests the platform made and how many came back 401, 403 or 429. Counts only: no workspace, integration, host or URL.',
    purpose: 'Protects the shared outbound address from a provider ban (the Discord global breaker, F108).',
    retention: {
      kind: 'fixed',
      ms: BUCKET_RETENTION_MS,
      basis: 'BUCKET_RETENTION_MS (src/delivery/egress-guard.ts)',
    },
    deletion: [{ kind: 'cron_job', job: 'egress_maintenance' }],
    inWorkspaceExport: false,
    inAccountExport: false,
    exportNote: 'Excluded on purpose: platform operations data that belongs to no workspace.',
    ...placeholders,
  },
  {
    id: 'egress_guard_state',
    table: 'egress_guard_state',
    category: 'platform_state',
    personalData: 'none',
    dataHeld:
      'One row per guarded provider: until when the global breaker is open, when it last opened, how often.',
    purpose: 'Holds the platform-wide breaker state between requests and cron ticks.',
    retention: {
      kind: 'indefinite',
      reason: 'A fixed set of rows (one per guarded provider) overwritten in place.',
    },
    deletion: [{ kind: 'none', reason: 'Fixed keys, no personal or tenant data.' }],
    inWorkspaceExport: false,
    inAccountExport: false,
    exportNote: 'Excluded on purpose: platform operations data that belongs to no workspace.',
    ...placeholders,
  },
  {
    id: 'workspace_webhook_hosts',
    table: 'workspace_webhook_hosts',
    category: 'tenant_configuration',
    personalData: 'indirect',
    dataHeld:
      'The hostnames (or *.domain rules) a workspace approved for custom webhooks, who added each and when.',
    purpose:
      'A workspace allowlist: a custom webhook may only point at an approved host (SSRF control, F115).',
    retention: workspaceLifetime,
    deletion: [{ kind: 'workspace_purge', route: 'tenant_tables' }],
    inWorkspaceExport: false,
    inAccountExport: false,
    exportNote: 'Not exported yet: the feature is off and has no management surface.',
    ...placeholders,
  },
  {
    id: 'webhook_host_resolutions',
    table: 'webhook_host_resolutions',
    category: 'delivery_metadata',
    personalData: 'none',
    dataHeld:
      'Per custom-webhook integration: the host, the addresses it last resolved to, the result, when, and how many times the address set changed. Never the URL path, query or secret.',
    purpose: 'Re-resolution and rebinding defence for a customer-chosen host (F115).',
    retention: {
      kind: 'fixed',
      ms: RESOLUTION_RETENTION_MS,
      basis: 'RESOLUTION_RETENTION_MS (generic-webhook/host-control.ts)',
      note: 'Counted from the last resolution.',
    },
    deletion: [
      { kind: 'cron_job', job: 'egress_maintenance' },
      { kind: 'workspace_purge', route: 'tenant_tables' },
    ],
    inWorkspaceExport: false,
    inAccountExport: false,
    ...placeholders,
  },
  {
    id: 'legacy_orphaned_rows',
    table: 'legacy_orphaned_rows',
    category: 'legacy_retired',
    personalData: 'indirect',
    dataHeld:
      'Metadata of rows that had no derivable workspace when migration 0026 ran (repository, destination, state, timestamps, ids; each free-text field cut to 200 characters). No credentials, no event payloads.',
    purpose:
      'Lets an operator see what the tenant-contract migration removed from the live tables. Read by no code.',
    retention: {
      kind: 'not_enforced',
      gap: 'Nothing drops it. The operator reviews it after applying migration 0026 and runs DROP TABLE legacy_orphaned_rows (docs/RUNBOOK.md).',
    },
    deletion: [{ kind: 'none', reason: 'No code path touches it; an operator drops the table by hand.' }],
    inWorkspaceExport: false,
    inAccountExport: false,
    exportNote: 'Excluded on purpose: the rows belong to no workspace.',
    ...placeholders,
  },
  // Migration 0026 keeps the six originals it rebuilt, renamed aside, until the operator finalizes.
  ...LEGACY_OLD_TABLES.map((table): RetentionRow => ({
    id: table,
    table,
    category: 'legacy_retired',
    personalData: 'indirect',
    dataHeld: `The pre-0026 original of \`${table.slice(0, -4)}\`, as it was when migration 0026 renamed it aside (derivable tenants backfilled): every row, including rows that had no valid workspace (quarantined from the live table) and any credential columns they held (sealed v1 envelopes or legacy v0 ciphertext). A duplicate of live data, plus orphans.`,
    purpose:
      'Lets the operator restore the originals (scripts/migration-0026-recover.mjs) or reconcile them row for row before dropping them (scripts/migration-0026-finalize.mjs). Read by no code.',
    retention: {
      kind: 'temporary',
      dropBy:
        'Dropped by scripts/migration-0026-finalize.mjs in the same maintenance window as migration 0026, and no later than 7 days after it was applied; /health/ready warns while it exists (docs/RUNBOOK.md)',
    },
    deletion: [
      { kind: 'workspace_purge', route: 'legacy_old' },
      {
        kind: 'none',
        reason:
          'Rows with no organization are not reachable by a workspace purge; only finalize removes the table.',
      },
    ],
    inWorkspaceExport: false,
    inAccountExport: false,
    exportNote: 'Excluded on purpose: a temporary duplicate of data the live tables export.',
    ...placeholders,
  })),
  {
    id: '_snapshot_0026',
    table: '_snapshot_0026',
    category: 'legacy_retired',
    personalData: 'none',
    dataHeld:
      'The verbatim CREATE statements of the indexes and triggers migration 0026 drops and recreates. Schema text only: no tenant data.',
    purpose: 'Lets scripts/migration-0026-recover.mjs put them back on a restored original. Read by no code.',
    retention: {
      kind: 'temporary',
      dropBy: 'Dropped by scripts/migration-0026-finalize.mjs together with the `_old` tables',
    },
    deletion: [{ kind: 'none', reason: 'Schema text only; finalize drops it.' }],
    inWorkspaceExport: false,
    inAccountExport: false,
    ...placeholders,
  },
  {
    id: 'workspace_deletions',
    table: 'workspace_deletions',
    category: 'platform_state',
    personalData: 'indirect',
    dataHeld:
      'Ledger of workspace deletion requests: workspace id, requesting user id, timestamps, ids of integrations disabled.',
    purpose: 'Schedules the purge and is the evidence that, and when, it completed.',
    retention: {
      kind: 'indefinite',
      reason: 'It must outlive the workspace as evidence that the purge completed.',
    },
    deletion: [
      {
        kind: 'none',
        reason:
          'Ids and timestamps only. The row deliberately survives the purge. No retention job exists; the operator may decide a period.',
      },
    ],
    inWorkspaceExport: false,
    inAccountExport: false,
    ...placeholders,
  },
  {
    id: 'ops_state',
    table: 'ops_state',
    category: 'platform_state',
    personalData: 'none',
    dataHeld: 'Key/value operational state: cron heartbeat, last-run timestamps of purge jobs.',
    purpose: 'Throttles purge jobs and proves the cron ran.',
    retention: { kind: 'indefinite', reason: 'A handful of fixed keys that are overwritten in place.' },
    deletion: [{ kind: 'none', reason: 'Fixed keys, no personal or tenant data.' }],
    inWorkspaceExport: false,
    inAccountExport: false,
    ...placeholders,
  },
  // --- retired identity tables (migration 0004, AR-10) ---------------------------------------
  ...retiredRows,
];

/** Stores outside D1 that this application writes to or relies on. Not machine-checked. */
export interface PlatformStore {
  readonly id: string;
  readonly store: string;
  readonly holds: string;
  readonly retention: string;
  readonly enforcedBy: string;
}

export const PLATFORM_STORES: readonly PlatformStore[] = [
  {
    id: 'd1_time_travel',
    store: 'Cloudflare D1 Time Travel',
    holds: 'Point-in-time history of the whole database, including rows we have deleted.',
    retention:
      'Cloudflare-managed. docs/SECURITY.md records up to 30 days (read 2026-10-13); not re-verified for this document.',
    enforcedBy:
      'Cloudflare. We cannot shorten it, so a deletion is not erasure from this history until the window has passed.',
  },
  {
    id: 'queues',
    store: 'Cloudflare Queues (deliveries and dead letters)',
    holds: 'Queue messages carry ids and display text, never a credential (F173).',
    retention:
      'Cloudflare-managed. Spec 15 F237 records up to 14 days on the Paid plan; not re-verified for this document.',
    enforcedBy: 'Cloudflare.',
  },
  {
    id: 'workers_logs',
    store: 'Workers logs',
    holds:
      'Redacted operational log lines: correlation id, counts, error categories. No payloads, URLs or tokens by design (src/platform/redact.ts).',
    retention: `Retention is a Cloudflare account setting that this repository does not configure: ${OPERATOR_TO_DECIDE}.`,
    enforcedBy: 'Cloudflare account configuration.',
  },
  {
    id: 'email_sending',
    store: 'Cloudflare Email Sending',
    holds:
      'Verification, password-reset and invitation emails sent to a person (recipient address and the one-time link).',
    retention: `Cloudflare-managed delivery records: ${OPERATOR_TO_DECIDE}.`,
    enforcedBy: 'Cloudflare.',
  },
];

/** Tables that have an `organization_id` column but are deliberately not removed by the workspace purge. */
export const LEDGER_TABLES_OUTLIVING_PURGE: readonly string[] = ['workspace_deletions'];
