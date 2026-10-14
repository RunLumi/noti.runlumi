import {
  createConnectionKeys,
  open,
  rewrapConnectionKey,
  seal,
  toBytes,
  unwrapConnectionKey,
  CryptoError,
  type ConnectionKeyMaterial,
  type Keyring,
  type SealContext,
} from '../../../crypto/envelope';
import { credentialFingerprint } from '../../../crypto/fingerprint';
import { blob } from '../../../pipeline/credentials';
import { SECRET_PREFIX, fromBase64 } from './encoding';

export { SECRET_PREFIX, fromBase64, generateEndpointId, generateSigningSecret, toBase64 } from './encoding';

/**
 * Storage for a generic source's signing secret (ADR 0012, building on ADR 0004).
 *
 * The secret is the Standard Webhooks form `whsec_<base64 of 32 random bytes>`. Only this
 * module reads or writes the credential columns of `sources`; callers get plaintext for one
 * verification and never see a key, a salt or an envelope.
 */

/** The credential columns of a `sources` row, as D1 returns them. */
export interface SourceCredentialRow {
  readonly id: string;
  readonly organization_id: string;
  readonly secret_envelope: unknown;
  readonly key_salt: unknown;
  readonly dek_wrapped: unknown;
  readonly kek_version: number | null;
}

export const SOURCE_CREDENTIAL_COLUMNS =
  'id,organization_id,secret_envelope,key_salt,dek_wrapped,kek_version';

function context(row: Pick<SourceCredentialRow, 'id' | 'organization_id'>): SealContext {
  return {
    orgId: row.organization_id,
    connectionId: row.id,
    field: 'signing_secret',
    purpose: 'source.signing',
  };
}

function material(row: SourceCredentialRow): ConnectionKeyMaterial {
  const keySalt = toBytes(row.key_salt);
  const dekWrapped = toBytes(row.dek_wrapped);
  if (!keySalt || !dekWrapped || row.kek_version === null) throw new CryptoError('malformed_envelope');
  return {
    orgId: row.organization_id,
    connectionId: row.id,
    purpose: 'source.signing',
    keySalt,
    dekWrapped,
    kekVersion: row.kek_version,
  };
}

export interface SealedSourceSecret {
  readonly keySalt: ArrayBuffer;
  readonly dekWrapped: ArrayBuffer;
  readonly kekVersion: number;
  readonly secretEnvelope: ArrayBuffer;
  /** Tenant-keyed fingerprint, non-secret, for display (F39); null without FINGERPRINT_KEY. */
  readonly fingerprint: string | null;
}

/** Seal a secret under FRESH key material; used for create and for every rotation. */
export async function sealSourceSecret(
  ids: { organizationId: string; sourceId: string },
  secret: string,
  keyring: Keyring,
  fingerprintKey?: string,
): Promise<SealedSourceSecret> {
  const { material: m, dek } = await createConnectionKeys(keyring, {
    orgId: ids.organizationId,
    connectionId: ids.sourceId,
    purpose: 'source.signing',
  });
  const envelope = await seal(
    dek,
    secret,
    context({ id: ids.sourceId, organization_id: ids.organizationId }),
  );
  const salt = blob(m.keySalt);
  const wrapped = blob(m.dekWrapped);
  const sealed = blob(envelope);
  if (!salt || !wrapped || !sealed) throw new CryptoError('malformed_envelope');
  return {
    keySalt: salt,
    dekWrapped: wrapped,
    kekVersion: m.kekVersion,
    secretEnvelope: sealed,
    fingerprint: await credentialFingerprint(secret, ids.organizationId, fingerprintKey),
  };
}

/**
 * Open the sealed secret as the text that was sealed. Provider sources (GitLab, Stripe) store
 * the credential exactly as the person pasted it. Throws CryptoError on any defect.
 */
export async function openSourceSecretText(row: SourceCredentialRow, keyring: Keyring): Promise<string> {
  const dek = await unwrapConnectionKey(keyring, material(row));
  const envelope = toBytes(row.secret_envelope);
  if (!envelope) throw new CryptoError('malformed_envelope');
  return open(dek, envelope, context(row));
}

/** Open the secret and decode the HMAC key bytes. Throws CryptoError on any defect. */
export async function openSourceSecret(
  row: SourceCredentialRow,
  keyring: Keyring,
): Promise<Uint8Array<ArrayBuffer>> {
  const secret = await openSourceSecretText(row, keyring);
  if (!secret.startsWith(SECRET_PREFIX)) throw new CryptoError('malformed_envelope');
  const key = fromBase64(secret.slice(SECRET_PREFIX.length));
  if (!key || key.length === 0) throw new CryptoError('malformed_envelope');
  return key;
}

const REWRAP_BATCH = 25;

/**
 * KEK rotation for sources (ADR 0004, F37): rewrap each connection key still on another KEK
 * version. Field envelopes are untouched. Guarded on the exact wrapped bytes read, so a
 * concurrent rotation of the secret is never overwritten with a stale wrap.
 */
export async function rewrapStaleSourceKeys(db: D1Database, keyring: Keyring): Promise<number> {
  const rows = await db
    .prepare(`SELECT ${SOURCE_CREDENTIAL_COLUMNS} FROM sources WHERE kek_version IS NOT ? LIMIT ?`)
    .bind(keyring.activeVersion, REWRAP_BATCH)
    .all<SourceCredentialRow>();
  let done = 0;
  for (const row of rows.results) {
    const current = material(row);
    const next = await rewrapConnectionKey(keyring, current);
    const res = await db
      .prepare(
        `UPDATE sources SET dek_wrapped=?,kek_version=? WHERE id=? AND organization_id=? AND kek_version=? AND dek_wrapped=?`,
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
    if (res.meta.changes === 1) done++;
  }
  return done;
}
