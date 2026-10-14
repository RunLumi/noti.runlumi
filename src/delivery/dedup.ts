/**
 * Dedup storage and duplicate suppression — docs/specs/12-delivery-reliability.md F171, F185, F186.
 *
 * Identity is already enforced by the deterministic delivery id (`INSERT OR IGNORE` on
 * `deliveries.id`, F170/F184). What this module adds is the part that used to be silent: when an
 * ingress insert is ignored because the event was already accepted, the duplicate is RECORDED as
 * a `suppressed` delivery row (reason `duplicate`, `duplicate_of` the original) and counted in
 * `event_dedup` (`hit_count`, `last_seen`). Nothing is dropped without a row a person can read.
 *
 * `event_dedup` is keyed `(organization_id, delivery_id)`: the delivery id is `H(dedup key,
 * integration)`, so one event routed to three integrations has three rows, which is the grain the
 * delivery log shows. The window is {@link DEDUP_TTL_MS}; a cron job purges expired rows.
 *
 * Limits, stated plainly:
 * - The window bounds the COUNTER and the suppression record. The delivery row itself still
 *   blocks a redelivery for the whole delivery-retention period (90 days by default), so a
 *   redelivery after the TTL is ignored at the row and recorded again with a fresh `event_dedup`
 *   row; it is never processed twice.
 * - Rows written before migration 0025 have no `event_dedup` row. The first duplicate after the
 *   migration is still suppressed and recorded; its `hit_count` starts at 1.
 * - The TTL is a constant, not a per-connection setting (F171 asks for one; not built).
 */
import { currentCorrelationId } from '../platform/correlation';

const DAY_MS = 24 * 60 * 60 * 1000;

/** F171: the dedup window. Must exceed every provider's redelivery horizon (asserted by a test). */
export const DEDUP_TTL_MS = 7 * DAY_MS;

/**
 * Documented provider redelivery horizons (F171). GitHub redelivers within 3 days; Stripe retries
 * for up to 3 days. If either provider extends its horizon, {@link DEDUP_TTL_MS} must move: the
 * test `dedup_ttl_exceeds_provider_redelivery_horizon` compares them.
 */
export const PROVIDER_REDELIVERY_HORIZON_MS = {
  github: 3 * DAY_MS,
  stripe: 3 * DAY_MS,
} as const;

/** Rows removed per purge statement, and statements per tick (bounded and resumable). */
export const DEDUP_PURGE_BATCH = 500;
export const DEDUP_PURGE_MAX_ROUNDS = 5;

export interface DedupInput {
  readonly organizationId: string;
  readonly integrationId: string;
  /** The deterministic delivery id for (dedup key, integration). */
  readonly deliveryId: string;
  /** Hex dedup key (F170). */
  readonly dedupKey: string;
  readonly nowMs: number;
}

/**
 * F185: at most this many `suppressed` rows are written per original. The counter keeps counting past
 * it (`hit_count` is the truth), so a provider stuck in a retry loop cannot fill the log with rows.
 */
export const SUPPRESSED_ROWS_PER_ORIGINAL = 20;

/**
 * Statements to append DIRECTLY after the statement whose `changes()` is zero exactly when the event
 * was already accepted: the outbox insert on the deliver path and the `held_events` insert on the hold
 * path. The outbox insert only runs when the DELIVERY insert before it changed a row, and it is an upsert,
 * so an outbox row that outlived its purged delivery (an orphan) is taken over by the new delivery and
 * still counts as a change: it can never make a brand-new delivery look like a repeat. They run in that
 * same batch, so the record commits or fails with the event, and none of them reads outside the tenant.
 *
 * 1. on a repeat: count it, creating the `event_dedup` row if it expired and was purged;
 * 2. on a repeat: a `suppressed` row, while the original has fewer than
 *    {@link SUPPRESSED_ROWS_PER_ORIGINAL} of them;
 * 3. first sight: the `event_dedup` row itself, a no-op when it exists.
 */
export function dedupStatements(db: D1Database, input: DedupInput): D1PreparedStatement[] {
  const expires = input.nowMs + DEDUP_TTL_MS;
  return [
    db
      .prepare(
        `INSERT INTO event_dedup(organization_id,delivery_id,dedup_key,integration_id,first_seen,last_seen,hit_count,expires_at)
         SELECT ?1,?2,?3,?4,?5,?5,1,?6
         WHERE changes() = 0
           AND (EXISTS (SELECT 1 FROM deliveries WHERE id=?2 AND organization_id=?1)
                OR EXISTS (SELECT 1 FROM held_events WHERE id=?2 AND organization_id=?1))
         ON CONFLICT(organization_id,delivery_id) DO UPDATE SET hit_count = hit_count + 1, last_seen = excluded.last_seen`,
      )
      .bind(
        input.organizationId,
        input.deliveryId,
        input.dedupKey,
        input.integrationId,
        input.nowMs,
        expires,
      ),
    db
      .prepare(
        `INSERT INTO deliveries(id,integration_id,organization_id,state,duplicate_of,suppressed_reason,created_at,correlation_id)
         SELECT ?1,?2,?3,'suppressed',?4,'duplicate',CURRENT_TIMESTAMP,?6
         WHERE changes() = 1
           AND (SELECT hit_count FROM event_dedup WHERE organization_id=?3 AND delivery_id=?4) <= ?5`,
      )
      .bind(
        crypto.randomUUID(),
        input.integrationId,
        input.organizationId,
        input.deliveryId,
        SUPPRESSED_ROWS_PER_ORIGINAL,
        currentCorrelationId(),
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO event_dedup(organization_id,delivery_id,dedup_key,integration_id,first_seen,last_seen,hit_count,expires_at)
         VALUES(?1,?2,?3,?4,?5,?5,0,?6)`,
      )
      .bind(
        input.organizationId,
        input.deliveryId,
        input.dedupKey,
        input.integrationId,
        input.nowMs,
        expires,
      ),
  ];
}

/** ?1 cutoff (epoch ms) · ?2 limit. Index range seek on `event_dedup_expires`. */
export const PURGE_EVENT_DEDUP_SQL = `DELETE FROM event_dedup WHERE rowid IN (
  SELECT rowid FROM event_dedup WHERE expires_at < ?1 LIMIT ?2)`;

export interface DedupPurgeReport {
  readonly purged: number;
  /** True when the per-tick cap was hit, so the next tick continues. */
  readonly more: boolean;
}

/** One bounded, resumable purge pass: a failure leaves the remaining rows for the next tick. */
export async function purgeEventDedup(
  db: Pick<D1Database, 'prepare'>,
  nowMs: number,
): Promise<DedupPurgeReport> {
  let purged = 0;
  for (let round = 0; round < DEDUP_PURGE_MAX_ROUNDS; round++) {
    const res = await db.prepare(PURGE_EVENT_DEDUP_SQL).bind(nowMs, DEDUP_PURGE_BATCH).run();
    const changed = res.meta?.changes ?? 0;
    purged += changed;
    if (changed < DEDUP_PURGE_BATCH) return { purged, more: false };
  }
  return { purged, more: true };
}
