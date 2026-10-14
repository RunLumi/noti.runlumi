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
 *
 * Cost: the purge runs at most hourly (`ops_state` key `last_retention_at`), and every
 * statement is a range seek on an index (see the EXPLAIN QUERY PLAN test). The throttle is
 * only advanced once a pass is complete, so a backlog continues on the next tick. If
 * `ops_state` is unreadable the purge runs anyway: retention must not depend on it.
 *
 * UNVERIFIED: the loops stop on `meta.changes < RETENTION_BATCH`. D1's `meta.changes`
 * semantics for DELETE were exercised only through the Node SQLite fake, not real D1.
 */
import { sqliteTimestamp } from '../delivery/claim';
import type { Bindings } from '../env';
import { log } from '../platform/log';

const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_BATCH = 500;
export const RETENTION_MAX_ROUNDS = 5;

export const DELIVERY_RETENTION = { default: 90, min: 30, max: 365 } as const;
export const AUDIT_RETENTION = { default: 365, min: 30, max: 3650 } as const;

type Bounds = { readonly default: number; readonly min: number; readonly max: number };

/** The configured value, or null when it is unset, non-numeric or out of range. */
function parseStrict(raw: string | number | undefined, bounds: Bounds): number | null {
  const n =
    typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= bounds.min && n <= bounds.max ? n : null;
}

export function parseRetentionDays(raw: string | number | undefined, bounds: Bounds): number {
  return parseStrict(raw, bounds) ?? bounds.default;
}

export const RETENTION_STATE_KEY = 'last_retention_at';
/** The purge is not urgent; hourly is plenty and keeps a quiet tick to one read. */
export const RETENTION_INTERVAL_MS = 60 * 60_000;

/** Names (never values) of retention vars that are set but unusable. */
export function invalidRetentionVars(
  env: Pick<Bindings, 'DELIVERY_RETENTION_DAYS' | 'AUDIT_RETENTION_DAYS'>,
): string[] {
  const pairs = [
    ['DELIVERY_RETENTION_DAYS', env.DELIVERY_RETENTION_DAYS, DELIVERY_RETENTION],
    ['AUDIT_RETENTION_DAYS', env.AUDIT_RETENTION_DAYS, AUDIT_RETENTION],
  ] as const;
  return pairs
    .filter(([, raw, b]) => raw !== undefined && raw !== '' && parseStrict(raw, b) === null)
    .map(([name]) => name);
}

export interface RetentionReport {
  /** True when the hourly throttle skipped this tick. */
  readonly skipped: boolean;
  readonly deliveries: number;
  readonly outbox: number;
  readonly audit: number;
  /** True when a table hit the per-tick cap, so the next tick continues. */
  readonly more: boolean;
}

type Db = Pick<D1Database, 'prepare'>;

/**
 * ?1 text cutoff · ?2 epoch-ms cutoff · ?3 limit. Range-seeks `deliveries_state_created`
 * (state, created_at). Rows with a NULL `created_at` are handled by the next statement.
 */
export const PURGE_DELIVERIES_SQL = `DELETE FROM deliveries WHERE rowid IN (
  SELECT rowid FROM deliveries
  WHERE state IN ('sent','accepted','suppressed','dead_lettered','failed')
    AND created_at < ?1
    AND (state NOT IN ('dead_lettered','failed') OR dead_lettered_at IS NULL OR dead_lettered_at < ?2)
  LIMIT ?3)`;

/** Rare: rows written before 0009 have no `created_at`; fall back to `updated_at`. ?1 text cutoff · ?2 epoch-ms cutoff · ?3 limit */
export const PURGE_DELIVERIES_NO_CREATED_SQL = `DELETE FROM deliveries WHERE rowid IN (
  SELECT rowid FROM deliveries
  WHERE state IN ('sent','accepted','suppressed','dead_lettered','failed')
    AND created_at IS NULL AND updated_at < ?1
    AND (state NOT IN ('dead_lettered','failed') OR dead_lettered_at IS NULL OR dead_lettered_at < ?2)
  LIMIT ?3)`;

/** ?1 text cutoff · ?2 limit. Orphans only: a retained delivery keeps its outbox message. */
export const PURGE_ORPHAN_OUTBOX_SQL = `DELETE FROM notification_outbox WHERE rowid IN (
  SELECT o.rowid FROM notification_outbox o
  WHERE o.state IN ('dispatched','invalid') AND o.created_at < ?1
    AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.id = o.id)
  LIMIT ?2)`;

/**
 * ?1 text cutoff · ?2 limit. A `key.destroy` event is platform-level evidence that a KEK version was
 * authorised for destruction (F37); it is not subject to the workspace audit retention.
 */
export const PURGE_AUDIT_SQL = `DELETE FROM audit_events WHERE rowid IN (
  SELECT rowid FROM audit_events WHERE created_at < ?1 AND action <> 'key.destroy' LIMIT ?2)`;

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

async function lastRun(db: Pick<D1Database, 'prepare'>): Promise<number | null> {
  try {
    const row = await db
      .prepare('SELECT value FROM ops_state WHERE key=?1')
      .bind(RETENTION_STATE_KEY)
      .first<{ value: string }>();
    const n = row ? Number(row.value) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null; // ops_state unreadable: run the purge rather than skip it
  }
}

async function markRun(db: Pick<D1Database, 'prepare'>, nowMs: number): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO ops_state(key,value,updated_at) VALUES(?1,?2,?3)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      )
      .bind(RETENTION_STATE_KEY, String(nowMs), nowMs)
      .run();
  } catch {
    // The next tick simply runs again.
  }
}

export async function purgeExpiredRecords(
  env: Pick<Bindings, 'DB' | 'DELIVERY_RETENTION_DAYS' | 'AUDIT_RETENTION_DAYS'>,
  nowMs: number = Date.now(),
): Promise<RetentionReport> {
  for (const name of invalidRetentionVars(env)) log('warn', 'retention_config_invalid', { var: name });
  const previous = await lastRun(env.DB);
  if (previous !== null && nowMs - previous >= 0 && nowMs - previous < RETENTION_INTERVAL_MS) {
    return { skipped: true, deliveries: 0, outbox: 0, audit: 0, more: false };
  }
  const deliveryCutoff = nowMs - parseRetentionDays(env.DELIVERY_RETENTION_DAYS, DELIVERY_RETENTION) * DAY_MS;
  const auditCutoff = nowMs - parseRetentionDays(env.AUDIT_RETENTION_DAYS, AUDIT_RETENTION) * DAY_MS;
  const text = sqliteTimestamp(deliveryCutoff);
  const deliveries = await drain(env.DB, PURGE_DELIVERIES_SQL, [text, deliveryCutoff]);
  const legacy = await drain(env.DB, PURGE_DELIVERIES_NO_CREATED_SQL, [text, deliveryCutoff]);
  const outbox = await drain(env.DB, PURGE_ORPHAN_OUTBOX_SQL, [text]);
  const audit = await drain(env.DB, PURGE_AUDIT_SQL, [sqliteTimestamp(auditCutoff)]);
  const more = deliveries.more || legacy.more || outbox.more || audit.more;
  if (!more) await markRun(env.DB, nowMs);
  return { skipped: false, deliveries: deliveries.n + legacy.n, outbox: outbox.n, audit: audit.n, more };
}
