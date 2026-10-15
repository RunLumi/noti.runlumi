import { credentialFingerprint } from '../crypto/fingerprint';
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

/**
 * `credentials_quarantine_reason` of a row whose secret must be treated as burned (F40). It reuses
 * the quarantine columns on purpose: every delivery path already refuses a quarantined row, so a
 * revoked integration stops sending without a change to the consumer. It differs from a
 * quarantine in cause and cure: quarantine is OUR fault with the row's bytes; revoke is the
 * customer's decision about the secret. Neither is cleared by a job, only by entering a new
 * credential.
 */
export const REVOKED_REASON = 'revoked';

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
  /** Tenant-keyed fingerprint of the webhook URL, non-secret, for display (F39); null without FINGERPRINT_KEY. */
  readonly fingerprint: string | null;
}

/** Seal credentials for a connection under fresh key material and the active KEK. */
export async function sealCredentials(
  ids: { organizationId: string; connectionId: string },
  credentials: DestinationCredentials,
  keyring: Keyring,
  fingerprintKey?: string,
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
    fingerprint: await credentialFingerprint(credentials.webhookUrl, ids.organizationId, fingerprintKey),
  };
}

export interface JobReport {
  readonly processed: number;
  readonly quarantined: number;
  /** Rows a concurrent writer changed between our read and our guarded UPDATE. */
  readonly skipped: number;
}

/** A batch that should stop and be surfaced, not quarantine rows. */
export class CredentialJobAborted extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CredentialJobAborted';
  }
}

const JOB_BATCH = 25;

/**
 * D1 binds BLOBs from `ArrayBuffer`. Every `Bytes` we produce owns an exact-length buffer
 * at offset 0, which this asserts rather than assumes.
 */
export function blob(bytes: Uint8Array | null): ArrayBuffer | null {
  if (!bytes) return null;
  if (
    bytes.byteOffset !== 0 ||
    bytes.byteLength !== bytes.buffer.byteLength ||
    !(bytes.buffer instanceof ArrayBuffer)
  )
    return blob(new Uint8Array(bytes));
  return bytes.buffer;
}

/**
 * Only a failure that is a property of the row's own bytes justifies quarantine. A wrong or
 * missing key, an unknown KEK version or a platform error is a property of the deployment:
 * quarantining would take healthy rows out of service on a bad deploy.
 */
function isRowDefect(e: unknown): e is CryptoError {
  return (
    e instanceof CryptoError &&
    (e.code === 'destination_credentials_invalid' || e.code === 'malformed_envelope')
  );
}

type Outcome =
  | { row: CredentialRow; ok: true; apply: () => Promise<boolean> }
  | { row: CredentialRow; ok: false; reason: string };

/**
 * Run a batch in two phases: compute every outcome first, then write. If every row of a
 * multi-row batch is a "defect", the likelier explanation is a wrong key, so the batch
 * aborts without quarantining anything (circuit breaker).
 */
async function runBatch(
  db: D1Database,
  rows: readonly CredentialRow[],
  prepare: (row: CredentialRow) => Promise<() => Promise<boolean>>,
): Promise<JobReport> {
  const outcomes: Outcome[] = [];
  for (const row of rows) {
    try {
      outcomes.push({ row, ok: true, apply: await prepare(row) });
    } catch (e) {
      if (!isRowDefect(e))
        throw new CredentialJobAborted(e instanceof CryptoError ? e.code : 'internal_error');
      outcomes.push({ row, ok: false, reason: e.code });
    }
  }
  if (outcomes.length >= 2 && outcomes.every((o) => !o.ok))
    throw new CredentialJobAborted('every_row_failed');

  let processed = 0;
  let quarantined = 0;
  let skipped = 0;
  for (const o of outcomes) {
    if (o.ok) {
      if (await o.apply()) processed++;
      else skipped++;
    } else {
      await db
        .prepare(
          `UPDATE integrations SET credentials_quarantined_at=CURRENT_TIMESTAMP,credentials_quarantine_reason=?
           WHERE id=? AND organization_id=? AND credentials_quarantined_at IS NULL`,
        )
        .bind(o.reason, o.row.id, o.row.organization_id)
        .run();
      quarantined++;
    }
  }
  return { processed, quarantined, skipped };
}

/**
 * Convert v0 rows to the v1 envelope (F37 migration). Chunked and resumable.
 *
 * - The new envelope is opened and compared with the plaintext before anything is written.
 * - The v0 columns are left intact. Clearing them is a separate, operator-run contract step
 *   after the zero-check (docs/IMPLEMENTATION.md), so rolling the Worker back still works.
 * - The UPDATE is guarded on the v0 values read, so a concurrent edit is never overwritten
 *   with stale plaintext, and only `changes === 1` counts as processed.
 *
 * Rows without `organization_id` are left alone: the AAD needs a tenant, and such rows are
 * already unroutable until the tenancy backfill assigns one.
 */
export async function migrateLegacyCredentials(
  db: D1Database,
  keyring: Keyring,
  legacyKeyHex: string,
  fingerprintKey?: string,
): Promise<JobReport> {
  const rows = await db
    .prepare(
      `SELECT ${CREDENTIAL_COLUMNS} FROM integrations
       WHERE webhook_envelope IS NULL AND organization_id IS NOT NULL AND credentials_quarantined_at IS NULL
       LIMIT ?`,
    )
    .bind(JOB_BATCH)
    .all<CredentialRow>();

  return runBatch(db, rows.results, async (row) => {
    const plain = await openCredentials(row, keyring, legacyKeyHex);
    const ids = { organizationId: row.organization_id, connectionId: row.id };
    const sealed = await sealCredentials(ids, plain, keyring, fingerprintKey);
    const reopened = await openCredentials(
      {
        ...row,
        key_salt: sealed.keySalt,
        dek_wrapped: sealed.dekWrapped,
        kek_version: sealed.kekVersion,
        webhook_envelope: sealed.webhookEnvelope,
        lark_secret_envelope: sealed.signingSecretEnvelope,
      },
      keyring,
      legacyKeyHex,
    );
    if (reopened.webhookUrl !== plain.webhookUrl || reopened.signingSecret !== plain.signingSecret)
      throw new CredentialJobAborted('seal_verification_failed');

    return async () => {
      const result = await db
        .prepare(
          `UPDATE integrations SET key_salt=?,dek_wrapped=?,kek_version=?,webhook_envelope=?,lark_secret_envelope=?,
             credential_fingerprint=?
           WHERE id=? AND organization_id=? AND webhook_envelope IS NULL
             AND webhook_ciphertext=? AND lark_secret_ciphertext IS ?`,
        )
        .bind(
          blob(sealed.keySalt),
          blob(sealed.dekWrapped),
          sealed.kekVersion,
          blob(sealed.webhookEnvelope),
          blob(sealed.signingSecretEnvelope),
          sealed.fingerprint,
          row.id,
          row.organization_id,
          row.webhook_ciphertext,
          row.lark_secret_ciphertext,
        )
        .run();
      return result.meta.changes === 1;
    };
  });
}

/**
 * Rewrap connection keys still on another KEK version (F37). Field envelopes are untouched.
 * The UPDATE is guarded on the exact wrapped bytes read, so a concurrent run or a version
 * rollback cannot overwrite a newer DEK wrap.
 */
export async function rewrapStaleKeys(db: D1Database, keyring: Keyring): Promise<JobReport> {
  const rows = await db
    .prepare(
      `SELECT ${CREDENTIAL_COLUMNS} FROM integrations
       WHERE dek_wrapped IS NOT NULL AND kek_version IS NOT ? AND credentials_quarantined_at IS NULL
       LIMIT ?`,
    )
    .bind(keyring.activeVersion, JOB_BATCH)
    .all<CredentialRow>();

  return runBatch(db, rows.results, async (row) => {
    const current = material(row);
    const next = await rewrapConnectionKey(keyring, current);
    return async () => {
      const result = await db
        .prepare(
          `UPDATE integrations SET dek_wrapped=?,kek_version=?
           WHERE id=? AND organization_id=? AND kek_version=? AND dek_wrapped=?`,
        )
        .bind(
          blob(next.dekWrapped),
          next.kekVersion,
          row.id,
          row.organization_id,
          current.kekVersion,
          blob(current.dekWrapped),
        )
        .run();
      return result.meta.changes === 1;
    };
  });
}

export interface CredentialStatus {
  readonly legacyRemaining: number;
  readonly staleKekRemaining: number;
  /** Quarantined for a defect in the row's own bytes (not counting revoked rows). */
  readonly quarantined: number;
  /** Revoked by the customer (F40): the secret is burned and a new one must be entered. */
  readonly revoked: number;
  /**
   * Revoked connections (integrations and sources) whose key material has not been destroyed yet: the drain
   * has not completed. Zero once every revoke has run its course (F40, src/pipeline/credential-destroy.ts).
   */
  readonly revokedKeysRemaining: number;
}

/** The numbers the rotation runbook's zero-check reads (F37). Counts only, never values. */
export async function credentialStatus(db: D1Database, activeVersion: number): Promise<CredentialStatus> {
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN webhook_envelope IS NULL AND organization_id IS NOT NULL AND credentials_quarantined_at IS NULL THEN 1 ELSE 0 END) AS legacy,
         SUM(CASE WHEN dek_wrapped IS NOT NULL AND kek_version IS NOT ? AND credentials_quarantined_at IS NULL THEN 1 ELSE 0 END) AS stale,
         SUM(CASE WHEN credentials_quarantined_at IS NOT NULL AND credentials_quarantine_reason IS NOT ? THEN 1 ELSE 0 END) AS quarantined,
         SUM(CASE WHEN credentials_quarantined_at IS NOT NULL AND credentials_quarantine_reason IS ? THEN 1 ELSE 0 END) AS revoked,
         COALESCE(SUM(CASE WHEN credentials_quarantined_at IS NOT NULL AND credentials_quarantine_reason IS ?
                   AND (dek_wrapped IS NOT NULL OR key_salt IS NOT NULL OR webhook_envelope IS NOT NULL
                        OR lark_secret_envelope IS NOT NULL OR webhook_ciphertext <> '' OR lark_secret_ciphertext IS NOT NULL)
                  THEN 1 ELSE 0 END), 0)
           + (SELECT COUNT(*) FROM sources WHERE credentials_revoked_at IS NOT NULL
                AND (length(dek_wrapped) > 0 OR length(key_salt) > 0 OR length(secret_envelope) > 0)) AS revoked_keys
       FROM integrations`,
    )
    .bind(activeVersion, REVOKED_REASON, REVOKED_REASON, REVOKED_REASON)
    .first<{
      legacy: number | null;
      stale: number | null;
      quarantined: number | null;
      revoked: number | null;
      revoked_keys: number | null;
    }>();
  return {
    legacyRemaining: row?.legacy ?? 0,
    staleKekRemaining: row?.stale ?? 0,
    quarantined: row?.quarantined ?? 0,
    revoked: row?.revoked ?? 0,
    revokedKeysRemaining: row?.revoked_keys ?? 0,
  };
}
