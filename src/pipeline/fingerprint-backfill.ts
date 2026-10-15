import {
  SOURCE_CREDENTIAL_COLUMNS,
  openSourceSecretText,
  type SourceCredentialRow,
} from '../connectors/sources/generic/secret';
import { isFingerprintKey, credentialFingerprint } from '../crypto/fingerprint';
import { keyringFromEnv } from '../crypto/keyring-env';
import type { Bindings } from '../env';
import { log } from '../platform/log';
import { CREDENTIAL_COLUMNS, openCredentials, type CredentialRow } from './credentials';

/**
 * A revoke is only as good as the check that refuses the burned value being pasted back, and once the secret is
 * destroyed that check is the non-secret fingerprint (ADR 0036). A connection sealed before fingerprints existed,
 * or while no `FINGERPRINT_KEY` was configured, has none. While its secret can still be opened (it is revoked
 * but not yet destroyed) this computes and stores one, so the destroy can proceed. Needs the KEK and a valid
 * `FINGERPRINT_KEY`; without either it does nothing, and the destroy stays deferred (the readiness view warns).
 * Rotating `FINGERPRINT_KEY` later makes every stored fingerprint stop matching: see RUNBOOK.
 */
const BATCH = 25;

type Env = Pick<Bindings, 'DB' | 'FINGERPRINT_KEY' | 'ENCRYPTION_KEY' | 'KEK_V1' | 'KMS_ACTIVE_VERSION'> &
  Partial<Pick<Bindings, 'KEK_V2'>>;

export async function backfillIntegrationFingerprint(env: Env, orgId: string, id: string): Promise<boolean> {
  if (!isFingerprintKey(env.FINGERPRINT_KEY)) return false;
  const row = await env.DB.prepare(
    `SELECT ${CREDENTIAL_COLUMNS} FROM integrations
     WHERE id=? AND organization_id=? AND credential_fingerprint IS NULL
       AND credentials_quarantine_reason='revoked' AND credentials_quarantined_at IS NOT NULL`,
  )
    .bind(id, orgId)
    .first<CredentialRow>();
  if (!row) return false;
  const credentials = await openCredentials(row, keyringFromEnv(env), env.ENCRYPTION_KEY ?? '');
  const fingerprint = await credentialFingerprint(credentials.webhookUrl, orgId, env.FINGERPRINT_KEY);
  if (fingerprint === null) return false;
  const result = await env.DB.prepare(
    `UPDATE integrations SET credential_fingerprint=?
     WHERE id=? AND organization_id=? AND credential_fingerprint IS NULL`,
  )
    .bind(fingerprint, id, orgId)
    .run();
  return result.meta.changes === 1;
}

export async function backfillSourceFingerprint(env: Env, orgId: string, id: string): Promise<boolean> {
  if (!isFingerprintKey(env.FINGERPRINT_KEY)) return false;
  const row = await env.DB.prepare(
    `SELECT ${SOURCE_CREDENTIAL_COLUMNS} FROM sources
     WHERE id=? AND organization_id=? AND credential_fingerprint IS NULL
       AND credentials_revoked_at IS NOT NULL AND length(dek_wrapped) > 0`,
  )
    .bind(id, orgId)
    .first<SourceCredentialRow>();
  if (!row) return false;
  const secret = await openSourceSecretText(row, keyringFromEnv(env));
  const fingerprint = await credentialFingerprint(secret, orgId, env.FINGERPRINT_KEY);
  if (fingerprint === null) return false;
  const result = await env.DB.prepare(
    `UPDATE sources SET credential_fingerprint=?
     WHERE id=? AND organization_id=? AND credential_fingerprint IS NULL`,
  )
    .bind(fingerprint, id, orgId)
    .run();
  return result.meta.changes === 1;
}

/** The scheduled pass: every revoked connection that still has a secret and no fingerprint, bounded. Per row. */
export async function backfillRevokedFingerprints(env: Env): Promise<number> {
  if (!isFingerprintKey(env.FINGERPRINT_KEY)) return 0;
  let done = 0;
  const integrations = await env.DB.prepare(
    `SELECT id, organization_id FROM integrations
     WHERE credentials_quarantine_reason='revoked' AND credentials_quarantined_at IS NOT NULL
       AND credential_fingerprint IS NULL AND dek_wrapped IS NOT NULL LIMIT ?`,
  )
    .bind(BATCH)
    .all<{ id: string; organization_id: string }>();
  for (const row of integrations.results) {
    try {
      if (await backfillIntegrationFingerprint(env, row.organization_id, row.id)) done++;
    } catch (error) {
      log('warn', 'fingerprint_backfill_failed', { integration_id: row.id, error });
    }
  }
  const sources = await env.DB.prepare(
    `SELECT id, organization_id FROM sources
     WHERE credentials_revoked_at IS NOT NULL AND credential_fingerprint IS NULL AND length(dek_wrapped) > 0 LIMIT ?`,
  )
    .bind(BATCH)
    .all<{ id: string; organization_id: string }>();
  for (const row of sources.results) {
    try {
      if (await backfillSourceFingerprint(env, row.organization_id, row.id)) done++;
    } catch (error) {
      log('warn', 'fingerprint_backfill_failed', { source_id: row.id, error });
    }
  }
  return done;
}
