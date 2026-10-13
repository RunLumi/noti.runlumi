/**
 * Retention for operational records (docs/specs/13-observability.md F196/F198 retention
 * notes, docs/specs/02-identity-tenancy.md F28; `retention.purge` in F204).
 *
 * Configured by two vars in wrangler.jsonc, parsed defensively (an unset, non-numeric or
 * out-of-range value falls back to the default, never to "keep nothing"):
 *   DELIVERY_RETENTION_DAYS  default 90  (30..365)   delivery ledger rows, and their outbox rows
 *   AUDIT_RETENTION_DAYS     default 365 (30..3650)  audit_events
 *
 * The 30-day floor on deliveries keeps the SLI window cap (30 days, src/observability/slis.ts)
 * answerable from the ledger. 90 days matches the spec's stated delivery-metadata horizon.
 *
 * Safety rules:
 *  - only TERMINAL deliveries are deleted (sent, accepted, suppressed, dead_lettered, legacy
 *    failed); pending, claimed and retrying rows are never touched, however old;
 *  - a dead-lettered row is kept until BOTH its creation and its dead-lettering are older
 *    than the cutoff, so a late failure of an old row is never purged on arrival;
 *  - deletes are age-based and tenant-agnostic, bounded per statement and per tick, and
 *    resumable (the next tick continues). Ciphertext is never read.
 *  - outbox rows are only removed once no delivery row with the same id remains, so manual
 *    redelivery (which re-reads the outbox message) keeps working for every retained row.
 *
 * D1 Time Travel can still restore purged rows for up to 30 days; this is not erasure.
 */
import { sqliteTimestamp } from '../delivery/claim';
import type { Bindings } from '../env';

const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_BATCH = 500;
export const RETENTION_MAX_ROUNDS = 5;

export const DELIVERY_RETENTION = { default: 90, min: 30, max: 365 } as const;
export const AUDIT_RETENTION = { default: 365, min: 30, max: 3650 } as const;

export function parseRetentionDays(
  raw: string | number | undefined,
  bounds: { readonly default: number; readonly min: number; readonly max: number },
): number {
  const n =
    typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= bounds.min && n <= bounds.max ? n : bounds.default;
}

export interface RetentionReport {
  readonly deliveries: number;
  readonly outbox: number;
  readonly audit: number;
  /** True when a table hit the per-tick cap, so the next tick continues. */
  readonly more: boolean;
}

type Db = Pick<D1Database, 'prepare'>;

/** ?1 text cutoff · ?2 epoch-ms cutoff · ?3 limit */
export const PURGE_DELIVERIES_SQL = `DELETE FROM deliveries WHERE rowid IN (
  SELECT rowid FROM deliveries
  WHERE state IN ('sent','accepted','suppressed','dead_lettered','failed')
    AND COALESCE(created_at, updated_at) < ?1
    AND (state NOT IN ('dead_lettered','failed') OR dead_lettered_at IS NULL OR dead_lettered_at < ?2)
  LIMIT ?3)`;

/** ?1 text cutoff · ?2 limit. Orphans only: a retained delivery keeps its outbox message. */
export const PURGE_ORPHAN_OUTBOX_SQL = `DELETE FROM notification_outbox WHERE rowid IN (
  SELECT o.rowid FROM notification_outbox o
  WHERE o.state IN ('dispatched','invalid') AND o.created_at < ?1
    AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.id = o.id)
  LIMIT ?2)`;

/** ?1 text cutoff · ?2 limit */
export const PURGE_AUDIT_SQL = `DELETE FROM audit_events WHERE rowid IN (
  SELECT rowid FROM audit_events WHERE created_at < ?1 LIMIT ?2)`;

async function drain(db: Db, sql: string, binds: readonly unknown[]): Promise<{ n: number; more: boolean }> {
  let n = 0;
  for (let i = 0; i < RETENTION_MAX_ROUNDS; i++) {
    const res = await db
      .prepare(sql)
      .bind(...binds, RETENTION_BATCH)
      .run();
    const changed = res.meta?.changes ?? 0;
    n += changed;
    if (changed < RETENTION_BATCH) return { n, more: false };
  }
  return { n, more: true };
}

export async function purgeExpiredRecords(
  env: Pick<Bindings, 'DB' | 'DELIVERY_RETENTION_DAYS' | 'AUDIT_RETENTION_DAYS'>,
  nowMs: number = Date.now(),
): Promise<RetentionReport> {
  const deliveryCutoff = nowMs - parseRetentionDays(env.DELIVERY_RETENTION_DAYS, DELIVERY_RETENTION) * DAY_MS;
  const auditCutoff = nowMs - parseRetentionDays(env.AUDIT_RETENTION_DAYS, AUDIT_RETENTION) * DAY_MS;
  const deliveries = await drain(env.DB, PURGE_DELIVERIES_SQL, [
    sqliteTimestamp(deliveryCutoff),
    deliveryCutoff,
  ]);
  const outbox = await drain(env.DB, PURGE_ORPHAN_OUTBOX_SQL, [sqliteTimestamp(deliveryCutoff)]);
  const audit = await drain(env.DB, PURGE_AUDIT_SQL, [sqliteTimestamp(auditCutoff)]);
  return {
    deliveries: deliveries.n,
    outbox: outbox.n,
    audit: audit.n,
    more: deliveries.more || outbox.more || audit.more,
  };
}
