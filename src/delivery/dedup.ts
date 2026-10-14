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
 * Statements to append DIRECTLY after the ingress statement whose `changes()` is 0 exactly when the
 * event was already accepted: the outbox insert on the deliver path (it only inserts when the delivery
 * row was new) and the `held_events` insert on the hold path. They run in that same batch, so the
 * record commits or fails with the event, and none of them reads anything outside the tenant.
 *
 * 1. a `suppressed` row, only when the previous statement changed nothing AND the original exists;
 * 2. the hit counter on the existing `event_dedup` row, only when (1) inserted;
 * 3. the `event_dedup` row itself (first sight), a no-op when it exists.
 */
export function dedupStatements(db: D1Database, input: DedupInput): D1PreparedStatement[] {
  const suppressedId = crypto.randomUUID();
  const expires = input.nowMs + DEDUP_TTL_MS;
  return [
    db
      .prepare(
        `INSERT INTO deliveries(id,integration_id,organization_id,state,duplicate_of,suppressed_reason,created_at)
         SELECT ?1,?2,?3,'suppressed',?4,'duplicate',CURRENT_TIMESTAMP
         WHERE changes() = 0
           AND (EXISTS (SELECT 1 FROM deliveries WHERE id=?4 AND organization_id=?3)
                OR EXISTS (SELECT 1 FROM held_events WHERE id=?4 AND organization_id=?3))`,
      )
      .bind(suppressedId, input.integrationId, input.organizationId, input.deliveryId),
    db
      .prepare(
        `UPDATE event_dedup SET hit_count = hit_count + 1, last_seen = ?3
         WHERE organization_id = ?1 AND delivery_id = ?2
           AND EXISTS (SELECT 1 FROM deliveries WHERE id = ?4 AND organization_id = ?1)`,
      )
      .bind(input.organizationId, input.deliveryId, input.nowMs, suppressedId),
    db
      .prepare(
        `INSERT OR IGNORE INTO event_dedup(organization_id,delivery_id,dedup_key,integration_id,first_seen,last_seen,hit_count,expires_at)
         VALUES(?1,?2,?3,?4,?5,?5,
                CASE WHEN EXISTS (SELECT 1 FROM deliveries WHERE id = ?7 AND organization_id = ?1) THEN 1 ELSE 0 END,
                ?6)`,
      )
      .bind(
        input.organizationId,
        input.deliveryId,
        input.dedupKey,
        input.integrationId,
        input.nowMs,
        expires,
        suppressedId,
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
