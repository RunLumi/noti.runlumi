import { DELIVERY_CLAIM_LEASE_MS } from '../delivery/ledger';
import { sqliteTimestamp } from '../delivery/claim';
import { withD1Retry } from '../db/retry';
import { log } from '../platform/log';

/**
 * Cryptographic erasure of a revoked connection's secret (F40, ADR 0036).
 *
 * The order is fixed: REVOKE (the connection stops being used, immediately: the consumer refuses a revoked
 * row and ingress answers 404 for a switched-off source), DRAIN (wait until nothing that already opened the
 * secret can still be using it), DESTROY (wipe the wrapped key and every ciphertext column in one
 * statement), AUDIT (`key_destroyed`, in the same batch, so the event exists exactly when the wipe did).
 *
 * Destroying the wrapped DEK is the claim: with `dek_wrapped` gone, no ciphertext of that connection can be
 * opened even by someone who holds the KEK. What stays is the non-secret fingerprint, so the dashboard can
 * still say WHICH credential was burned, and it is what refuses the same value being entered again.
 *
 * The wipe is one statement and an audit insert guarded by the same predicate, in one batch (one
 * transaction), so a second attempt, a concurrent one, or a cron pass after the inline attempt is a no-op
 * that writes no second event.
 */

/** A source has no consumer claim to wait for; an ingress request that already opened its secret is over well within this. */
export const SOURCE_DRAIN_MS = 60_000;
const BATCH = 25;

/*
 * Integrations: `?1` id, `?2` organization, `?3` the oldest `claimed_at` that still counts as a live consumer
 * claim (now minus the claim lease). A row qualifies when it is revoked, still holds key material, and no
 * consumer claim that may already have opened the secret is live. The predicate is written out in full in
 * each statement (no interpolation: tests/security/bound-parameters.test.ts), and a test keeps them equal.
 */

/** `?1` id · `?2` organization · `?3` live-claim cutoff · `?4` audit id · `?5` actor · `?6` trigger. */
export const INTEGRATION_KEY_DESTROYED_AUDIT_SQL = `INSERT INTO audit_events(id,organization_id,actor_id,action,subject_type,subject_id,outcome,metadata_json)
SELECT ?4, organization_id, ?5, 'integration.key_destroyed', 'integration', id, 'success',
  json_object('kekVersion', kek_version, 'trigger', ?6, 'destinationHost', destination_host)
FROM integrations
WHERE id = ?1 AND organization_id = ?2
  AND credentials_quarantined_at IS NOT NULL AND credentials_quarantine_reason = 'revoked'
  AND (dek_wrapped IS NOT NULL OR key_salt IS NOT NULL OR webhook_envelope IS NOT NULL
       OR lark_secret_envelope IS NOT NULL OR webhook_ciphertext <> '' OR lark_secret_ciphertext IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM deliveries d
                  WHERE d.organization_id = ?2 AND d.integration_id = ?1
                    AND d.state = 'claimed' AND d.claimed_at > ?3)
  AND (?7 = 0 OR credential_fingerprint IS NOT NULL)`;

export const INTEGRATION_KEY_DESTROY_SQL = `UPDATE integrations
SET webhook_ciphertext = '', lark_secret_ciphertext = NULL, key_salt = NULL, dek_wrapped = NULL,
    kek_version = NULL, webhook_envelope = NULL, lark_secret_envelope = NULL, updated_at = CURRENT_TIMESTAMP
WHERE id = ?1 AND organization_id = ?2
  AND credentials_quarantined_at IS NOT NULL AND credentials_quarantine_reason = 'revoked'
  AND (dek_wrapped IS NOT NULL OR key_salt IS NOT NULL OR webhook_envelope IS NOT NULL
       OR lark_secret_envelope IS NOT NULL OR webhook_ciphertext <> '' OR lark_secret_ciphertext IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM deliveries d
                  WHERE d.organization_id = ?2 AND d.integration_id = ?1
                    AND d.state = 'claimed' AND d.claimed_at > ?3)
  AND (?4 = 0 OR credential_fingerprint IS NOT NULL)`;

/** Revoked integrations that still hold key material. `?1` limit · `?2` 1 to skip rows with no fingerprint yet. */
export const SELECT_INTEGRATIONS_TO_DESTROY_SQL = `SELECT id, organization_id FROM integrations
WHERE credentials_quarantined_at IS NOT NULL AND credentials_quarantine_reason = 'revoked'
  AND (dek_wrapped IS NOT NULL OR key_salt IS NOT NULL OR webhook_envelope IS NOT NULL
       OR lark_secret_envelope IS NOT NULL OR webhook_ciphertext <> '' OR lark_secret_ciphertext IS NOT NULL)
  AND (?2 = 0 OR credential_fingerprint IS NOT NULL)
ORDER BY credentials_quarantined_at LIMIT ?1`;

/**
 * Sources. `secret_envelope`, `key_salt` and `dek_wrapped` are NOT NULL, so the wiped state is an empty blob
 * and `kek_version` 0 (no KEK version is 0, so the KEK destruction check no longer counts the row).
 * `?1` id · `?2` organization · `?3` the latest `credentials_revoked_at` that has drained · `?4` audit id ·
 * `?5` actor · `?6` trigger.
 */
export const SOURCE_KEY_DESTROYED_AUDIT_SQL = `INSERT INTO audit_events(id,organization_id,actor_id,action,subject_type,subject_id,outcome,metadata_json)
SELECT ?4, organization_id, ?5, 'source.key_destroyed', 'source', id, 'success',
  json_object('kekVersion', kek_version, 'trigger', ?6, 'kind', kind)
FROM sources
WHERE id = ?1 AND organization_id = ?2 AND credentials_revoked_at IS NOT NULL AND credentials_revoked_at <= ?3
  AND (length(dek_wrapped) > 0 OR length(key_salt) > 0 OR length(secret_envelope) > 0)
  AND (?7 = 0 OR credential_fingerprint IS NOT NULL)`;

export const SOURCE_KEY_DESTROY_SQL = `UPDATE sources
SET secret_envelope = x'', key_salt = x'', dek_wrapped = x'', kek_version = 0, updated_at = CURRENT_TIMESTAMP
WHERE id = ?1 AND organization_id = ?2 AND credentials_revoked_at IS NOT NULL AND credentials_revoked_at <= ?3
  AND (length(dek_wrapped) > 0 OR length(key_salt) > 0 OR length(secret_envelope) > 0)
  AND (?4 = 0 OR credential_fingerprint IS NOT NULL)`;

/** Revoked sources that still hold key material. `?1` limit · `?2` 1 to skip rows with no fingerprint yet. */
export const SELECT_SOURCES_TO_DESTROY_SQL = `SELECT id, organization_id FROM sources
WHERE credentials_revoked_at IS NOT NULL
  AND (length(dek_wrapped) > 0 OR length(key_salt) > 0 OR length(secret_envelope) > 0)
  AND (?2 = 0 OR credential_fingerprint IS NOT NULL)
ORDER BY credentials_revoked_at LIMIT ?1`;

/**
 * Migration 0026 keeps the pre-swap `integrations` as `integrations_old` until an operator finalizes it
 * (docs/RUNBOOK.md), and that copy holds the sealed secrets as they were BEFORE the revoke. Erasure is not
 * complete while it does. Wiped in the same batch as the live row, guarded by org + id and by the live row
 * being revoked and already wiped; the table may not exist (fresh database, or finalized).
 * `?1` id · `?2` organization.
 */
export const LEGACY_TABLE_PRESENT_SQL =
  "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'integrations_old'";

export const INTEGRATION_OLD_WIPE_SQL = `UPDATE integrations_old
SET webhook_ciphertext = '', lark_secret_ciphertext = NULL, key_salt = NULL, dek_wrapped = NULL,
    kek_version = NULL, webhook_envelope = NULL, lark_secret_envelope = NULL
WHERE id = ?1 AND organization_id = ?2
  AND EXISTS (SELECT 1 FROM integrations i
              WHERE i.id = ?1 AND i.organization_id = ?2
                AND i.credentials_quarantined_at IS NOT NULL AND i.credentials_quarantine_reason = 'revoked'
                AND i.dek_wrapped IS NULL AND i.webhook_envelope IS NULL AND i.webhook_ciphertext = '')
  AND (dek_wrapped IS NOT NULL OR key_salt IS NOT NULL OR webhook_envelope IS NOT NULL
       OR lark_secret_envelope IS NOT NULL OR webhook_ciphertext <> '' OR lark_secret_ciphertext IS NOT NULL)`;

/** The sweep's form: every kept original of a connection that is revoked and already wiped. */
export const INTEGRATION_OLD_WIPE_ALL_SQL = `UPDATE integrations_old
SET webhook_ciphertext = '', lark_secret_ciphertext = NULL, key_salt = NULL, dek_wrapped = NULL,
    kek_version = NULL, webhook_envelope = NULL, lark_secret_envelope = NULL
WHERE EXISTS (SELECT 1 FROM integrations i
              WHERE i.id = integrations_old.id AND i.organization_id = integrations_old.organization_id
                AND i.credentials_quarantined_at IS NOT NULL AND i.credentials_quarantine_reason = 'revoked'
                AND i.dek_wrapped IS NULL AND i.webhook_envelope IS NULL AND i.webhook_ciphertext = '')
  AND (dek_wrapped IS NOT NULL OR key_salt IS NOT NULL OR webhook_envelope IS NOT NULL
       OR lark_secret_envelope IS NOT NULL OR webhook_ciphertext <> '' OR lark_secret_ciphertext IS NOT NULL)`;

/**
 * Revoked connections that still hold key material and have NO fingerprint: the destroy waits for one, and the
 * backfill needs to open the secret. A row that cannot be opened (sealed before fingerprints existed under a
 * key that is gone, a corrupt envelope, a missing `ENCRYPTION_KEY`) is never wiped by the sweep, so these are
 * counted, logged and shown to the operator, who wipes them with `scripts/force-destroy-revoked.mjs`
 * (docs/RUNBOOK.md, "Revoked credentials").
 */
export const AWAITING_FINGERPRINT_SQL = `SELECT
  (SELECT COUNT(*) FROM integrations
    WHERE credentials_quarantined_at IS NOT NULL AND credentials_quarantine_reason = 'revoked'
      AND credential_fingerprint IS NULL
      AND (dek_wrapped IS NOT NULL OR key_salt IS NOT NULL OR webhook_envelope IS NOT NULL
           OR lark_secret_envelope IS NOT NULL OR webhook_ciphertext <> '' OR lark_secret_ciphertext IS NOT NULL))
  + (SELECT COUNT(*) FROM sources
      WHERE credentials_revoked_at IS NOT NULL AND credential_fingerprint IS NULL
        AND (length(dek_wrapped) > 0 OR length(key_salt) > 0 OR length(secret_envelope) > 0)) AS n`;

export async function countAwaitingFingerprint(db: D1Database): Promise<number> {
  const row = await db.prepare(AWAITING_FINGERPRINT_SQL).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** Does `integrations_old` exist right now? Checked once per sweep and once per inline destroy. */
export async function legacyOldPresent(db: D1Database): Promise<boolean> {
  const row = await db.prepare(LEGACY_TABLE_PRESENT_SQL).first<{ n: number }>();
  return Number(row?.n ?? 0) > 0;
}

export interface DestroyActor {
  /** The person who revoked, when the destruction runs in their request; `null` for the scheduled sweep. */
  readonly actorId: string | null;
  readonly trigger: 'revoke' | 'sweep';
}

export type DestroyOutcome = 'destroyed' | 'deferred';

export interface DestroyOptions {
  /**
   * Destroy only a row whose non-secret fingerprint exists (default true). The fingerprint is what refuses the
   * burned value being pasted back once the secret is gone; without it that check fails open, so the wipe
   * waits until one exists (the revoke computes it when a fingerprint key is configured). `false` only in
   * `development`, where there is nothing to protect.
   */
  readonly requireFingerprint?: boolean;
  /** `integrations_old` exists (migration 0026 not finalized): wipe its copy in the same batch. */
  readonly legacyOld?: boolean;
}

/** Wipe one revoked integration's key material once its consumer claims have drained. Idempotent. */
export async function destroyIntegrationKey(
  db: D1Database,
  organizationId: string,
  id: string,
  nowMs: number,
  actor: DestroyActor,
  options: DestroyOptions = {},
): Promise<DestroyOutcome> {
  const claimCutoff = nowMs - DELIVERY_CLAIM_LEASE_MS;
  const need = options.requireFingerprint === false ? 0 : 1;
  const results = await withD1Retry(
    () =>
      db.batch([
        db
          .prepare(INTEGRATION_KEY_DESTROYED_AUDIT_SQL)
          .bind(id, organizationId, claimCutoff, crypto.randomUUID(), actor.actorId, actor.trigger, need),
        db.prepare(INTEGRATION_KEY_DESTROY_SQL).bind(id, organizationId, claimCutoff, need),
        // Always last, so it sees the wiped live row; not run at all when the table is absent.
        ...(options.legacyOld ? [db.prepare(INTEGRATION_OLD_WIPE_SQL).bind(id, organizationId)] : []),
      ]),
    // Both statements carry the predicate "still holds key material": after a committed first attempt the
    // repeat matches nothing and writes no second event.
    { idempotent: true, label: 'integration_key_destroy' },
  );
  return (results[1]?.meta.changes ?? 0) === 1 ? 'destroyed' : 'deferred';
}

/** Wipe one revoked source's key material once the drain window since revoke has passed. Idempotent. */
export async function destroySourceKey(
  db: D1Database,
  organizationId: string,
  id: string,
  nowMs: number,
  actor: DestroyActor,
  options: DestroyOptions = {},
): Promise<DestroyOutcome> {
  const drained = sqliteTimestamp(nowMs - SOURCE_DRAIN_MS);
  const need = options.requireFingerprint === false ? 0 : 1;
  const results = await withD1Retry(
    () =>
      db.batch([
        db
          .prepare(SOURCE_KEY_DESTROYED_AUDIT_SQL)
          .bind(id, organizationId, drained, crypto.randomUUID(), actor.actorId, actor.trigger, need),
        db.prepare(SOURCE_KEY_DESTROY_SQL).bind(id, organizationId, drained, need),
      ]),
    { idempotent: true, label: 'source_key_destroy' },
  );
  return (results[1]?.meta.changes ?? 0) === 1 ? 'destroyed' : 'deferred';
}

export interface DestroySweepReport {
  readonly integrations: number;
  readonly sources: number;
  /** Revoked rows still holding key material after this pass: not drained yet, or waiting for a fingerprint. */
  readonly deferred: number;
  /** Rows whose destroy threw (logged); the others were still processed. */
  readonly failed: number;
  /** Revoked rows that hold a secret and have no fingerprint, so this sweep could not select them (see above). */
  readonly awaitingFingerprint: number;
}

/**
 * The scheduled pass: finish every revoke whose drain has completed, a bounded number per tick. A row that
 * has not drained is left for the next tick, so a stuck consumer claim delays the wipe by at most one lease.
 * It needs no key, and one row's failure never stops the others: each is caught on its own.
 */
export async function destroyRevokedCredentials(
  db: D1Database,
  nowMs: number,
  options: DestroyOptions = {},
): Promise<DestroySweepReport> {
  const need = options.requireFingerprint === false ? 0 : 1;
  const legacyOld = await legacyOldPresent(db).catch(() => false);
  const integrations = await db
    .prepare(SELECT_INTEGRATIONS_TO_DESTROY_SQL)
    .bind(BATCH, need)
    .all<{ id: string; organization_id: string }>();
  const sources = await db
    .prepare(SELECT_SOURCES_TO_DESTROY_SQL)
    .bind(BATCH, need)
    .all<{ id: string; organization_id: string }>();
  let destroyedIntegrations = 0;
  let destroyedSources = 0;
  let deferred = 0;
  let failed = 0;
  const sweep: DestroyActor = { actorId: null, trigger: 'sweep' };
  const settings = { ...options, legacyOld };
  for (const row of integrations.results) {
    try {
      const out = await destroyIntegrationKey(db, row.organization_id, row.id, nowMs, sweep, settings);
      if (out === 'destroyed') destroyedIntegrations++;
      else deferred++;
    } catch (error) {
      failed++;
      log('error', 'integration_key_destroy_failed', { integration_id: row.id, error });
    }
  }
  for (const row of sources.results) {
    try {
      const out = await destroySourceKey(db, row.organization_id, row.id, nowMs, sweep, settings);
      if (out === 'destroyed') destroyedSources++;
      else deferred++;
    } catch (error) {
      failed++;
      log('error', 'source_key_destroy_failed', { source_id: row.id, error });
    }
  }
  // Kept originals of anything already wiped (a destroy from before the table existed, or a partial wipe).
  if (legacyOld) {
    try {
      await db.prepare(INTEGRATION_OLD_WIPE_ALL_SQL).run();
    } catch (error) {
      failed++;
      log('error', 'integration_old_wipe_failed', { error });
    }
  }
  // Rows the selection above skipped on purpose: they would otherwise be invisible ("0 deferred").
  let awaitingFingerprint = 0;
  if (need === 1) {
    awaitingFingerprint = await countAwaitingFingerprint(db).catch(() => 0);
    if (awaitingFingerprint > 0)
      log('warn', 'revoked_secret_awaiting_fingerprint', { count: awaitingFingerprint });
  }
  return {
    integrations: destroyedIntegrations,
    sources: destroyedSources,
    deferred: deferred + awaitingFingerprint,
    failed,
    awaitingFingerprint,
  };
}

/**
 * The options every caller passes: wait for a fingerprint outside `development`, and wipe the kept
 * `integrations_old` copy while migration 0026 has not been finalized.
 */
export async function destroySettings(env: {
  readonly DB: D1Database;
  readonly ENVIRONMENT_NAME?: string;
}): Promise<DestroyOptions> {
  return {
    requireFingerprint: env.ENVIRONMENT_NAME !== 'development',
    legacyOld: await legacyOldPresent(env.DB).catch(() => false),
  };
}
