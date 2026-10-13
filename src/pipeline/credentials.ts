import {
  createConnectionKeys,
  CryptoError,
  open,
  openLegacyV0,
  rewrapConnectionKey,
  seal,
  toBytes,
  unwrapConnectionKey,
  type ConnectionKeyMaterial,
  type Keyring,
  type SealContext,
} from '../crypto/envelope';

/**
 * Destination credential storage for `integrations` rows (F33–F37).
 *
 * The only module that reads or writes credential columns. Callers get plaintext for exactly
 * one delivery and never see a key, a salt or an envelope.
 */

export interface DestinationCredentials {
  readonly webhookUrl: string;
  readonly signingSecret: string | null;
}

/** Credential columns of an `integrations` row, as D1 returns them. */
export interface CredentialRow {
  readonly id: string;
  readonly organization_id: string;
  readonly webhook_ciphertext: string;
  readonly lark_secret_ciphertext: string | null;
  readonly key_salt: unknown;
  readonly dek_wrapped: unknown;
  readonly kek_version: number | null;
  readonly webhook_envelope: unknown;
  readonly lark_secret_envelope: unknown;
}

export const CREDENTIAL_COLUMNS =
  'id,organization_id,webhook_ciphertext,lark_secret_ciphertext,key_salt,dek_wrapped,kek_version,webhook_envelope,lark_secret_envelope';

function fieldContext(
  row: Pick<CredentialRow, 'id' | 'organization_id'>,
  field: 'url' | 'signing_secret',
): SealContext {
  return { orgId: row.organization_id, connectionId: row.id, field, purpose: 'destination' };
}

function material(row: CredentialRow): ConnectionKeyMaterial {
  const keySalt = toBytes(row.key_salt);
  const dekWrapped = toBytes(row.dek_wrapped);
  if (!keySalt || !dekWrapped || row.kek_version === null) throw new CryptoError('malformed_envelope');
  return {
    orgId: row.organization_id,
    connectionId: row.id,
    purpose: 'destination',
    keySalt,
    dekWrapped,
    kekVersion: row.kek_version,
  };
}

/** True once a row has been sealed in the v1 envelope format. */
export function isSealed(row: CredentialRow): boolean {
  return row.webhook_envelope !== null && row.webhook_envelope !== undefined;
}

/**
 * Open a row's credentials. v1 rows use the envelope; v0 rows fall back to the legacy key
 * until the migration job has converted them. Detection is structural, not a flag (F37).
 */
export async function openCredentials(
  row: CredentialRow,
  keyring: Keyring,
  legacyKeyHex: string,
): Promise<DestinationCredentials> {
  if (!isSealed(row)) {
    return {
      webhookUrl: await openLegacyV0(row.webhook_ciphertext, legacyKeyHex),
      signingSecret: row.lark_secret_ciphertext
        ? await openLegacyV0(row.lark_secret_ciphertext, legacyKeyHex)
        : null,
    };
  }
  const dek = await unwrapConnectionKey(keyring, material(row));
  const webhook = toBytes(row.webhook_envelope);
  if (!webhook) throw new CryptoError('malformed_envelope');
  const secret = toBytes(row.lark_secret_envelope);
  return {
    webhookUrl: await open(dek, webhook, fieldContext(row, 'url')),
    signingSecret: secret ? await open(dek, secret, fieldContext(row, 'signing_secret')) : null,
  };
}

export interface SealedCredentials {
  readonly keySalt: Uint8Array;
  readonly dekWrapped: Uint8Array;
  readonly kekVersion: number;
  readonly webhookEnvelope: Uint8Array;
  readonly signingSecretEnvelope: Uint8Array | null;
}

/** Seal credentials for a connection under fresh key material and the active KEK. */
export async function sealCredentials(
  ids: { organizationId: string; connectionId: string },
  credentials: DestinationCredentials,
  keyring: Keyring,
): Promise<SealedCredentials> {
  const { material: m, dek } = await createConnectionKeys(keyring, {
    orgId: ids.organizationId,
    connectionId: ids.connectionId,
    purpose: 'destination',
  });
  const row = { id: ids.connectionId, organization_id: ids.organizationId };
  return {
    keySalt: m.keySalt,
    dekWrapped: m.dekWrapped,
    kekVersion: m.kekVersion,
    webhookEnvelope: await seal(dek, credentials.webhookUrl, fieldContext(row, 'url')),
    signingSecretEnvelope: credentials.signingSecret
      ? await seal(dek, credentials.signingSecret, fieldContext(row, 'signing_secret'))
      : null,
  };
}

export interface JobReport {
  readonly processed: number;
  readonly quarantined: number;
}

const JOB_BATCH = 25;

async function quarantine(db: D1Database, id: string, reason: string): Promise<void> {
  await db
    .prepare(
      'UPDATE integrations SET credentials_quarantined_at=CURRENT_TIMESTAMP,credentials_quarantine_reason=? WHERE id=?',
    )
    .bind(reason, id)
    .run();
}

function reasonOf(e: unknown): string {
  return e instanceof CryptoError ? e.code : 'internal_error';
}

/**
 * Convert v0 rows to the v1 envelope (F37 migration). Chunked and resumable: each row is
 * rewritten by one guarded UPDATE, so a crash leaves a v0 row or a v1 row, never both.
 * The v0 ciphertext is cleared in the same statement. A row that will not decrypt is
 * quarantined, never silently skipped.
 *
 * Rows without `organization_id` are left alone: the AAD needs a tenant, and such rows
 * are already unroutable until the tenancy backfill assigns one.
 */
export async function migrateLegacyCredentials(
  db: D1Database,
  keyring: Keyring,
  legacyKeyHex: string,
): Promise<JobReport> {
  const rows = await db
    .prepare(
      `SELECT ${CREDENTIAL_COLUMNS} FROM integrations
       WHERE webhook_envelope IS NULL AND organization_id IS NOT NULL AND credentials_quarantined_at IS NULL
       LIMIT ?`,
    )
    .bind(JOB_BATCH)
    .all<CredentialRow>();

  let processed = 0;
  let quarantined = 0;
  for (const row of rows.results) {
    try {
      const plain = await openCredentials(row, keyring, legacyKeyHex);
      const sealed = await sealCredentials(
        { organizationId: row.organization_id, connectionId: row.id },
        plain,
        keyring,
      );
      await db
        .prepare(
          `UPDATE integrations SET key_salt=?,dek_wrapped=?,kek_version=?,webhook_envelope=?,lark_secret_envelope=?,
             webhook_ciphertext='',lark_secret_ciphertext=NULL
           WHERE id=? AND organization_id=? AND webhook_envelope IS NULL`,
        )
        .bind(
          sealed.keySalt,
          sealed.dekWrapped,
          sealed.kekVersion,
          sealed.webhookEnvelope,
          sealed.signingSecretEnvelope,
          row.id,
          row.organization_id,
        )
        .run();
      processed++;
    } catch (e) {
      await quarantine(db, row.id, reasonOf(e));
      quarantined++;
    }
  }
  return { processed, quarantined };
}

/**
 * Rewrap connection keys still on an older KEK (F37). Field envelopes are untouched. The
 * UPDATE is guarded on the version it read, so a concurrent run cannot double-apply.
 */
export async function rewrapStaleKeys(db: D1Database, keyring: Keyring): Promise<JobReport> {
  const rows = await db
    .prepare(
      `SELECT ${CREDENTIAL_COLUMNS} FROM integrations
       WHERE dek_wrapped IS NOT NULL AND kek_version != ? AND credentials_quarantined_at IS NULL
       LIMIT ?`,
    )
    .bind(keyring.activeVersion, JOB_BATCH)
    .all<CredentialRow>();

  let processed = 0;
  let quarantined = 0;
  for (const row of rows.results) {
    try {
      const next = await rewrapConnectionKey(keyring, material(row));
      await db
        .prepare('UPDATE integrations SET dek_wrapped=?,kek_version=? WHERE id=? AND kek_version=?')
        .bind(next.dekWrapped, next.kekVersion, row.id, row.kek_version)
        .run();
      processed++;
    } catch (e) {
      await quarantine(db, row.id, reasonOf(e));
      quarantined++;
    }
  }
  return { processed, quarantined };
}
