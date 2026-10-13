/**
 * The delivery ledger (docs/specs/12-delivery-reliability.md F175, F180, F184).
 *
 * Every statement is scoped by `id AND organization_id AND integration_id`: the consumer
 * re-checks the tenant on every read and write, so a forged message cannot touch another
 * workspace's row. Rows written before 0009 keep their legacy `${githubDelivery}:${integration}`
 * id; the consumer only ever looks rows up by the id the message carries, so those rows are
 * found and updated like any other.
 */
import type { ErrorCode } from '../platform/errors';
import type { DeliveryState } from './state';

/** Identifies one delivery row within its tenant. */
export interface DeliveryRef {
  readonly id: string;
  readonly organizationId: string;
  readonly integrationId: string;
}

export interface DeliveryRow {
  readonly state: DeliveryState;
  readonly attempts: number;
  readonly claimed_at: number | null;
}

/**
 * F175: how long a consumer's claim on a delivery protects it. One attempt is bounded by
 * the outbound timeout (F189), so five minutes only matters when a consumer crashed
 * mid-attempt; after it, the redelivered queue message may claim the row again.
 * Engineering judgment — no spec value.
 */
export const DELIVERY_CLAIM_LEASE_MS = 5 * 60_000;

const WHERE_REF = 'WHERE id=?1 AND organization_id=?2 AND integration_id=?3';

export async function loadDelivery(db: D1Database, ref: DeliveryRef): Promise<DeliveryRow | null> {
  return db
    .prepare(`SELECT state,attempts,claimed_at FROM deliveries ${WHERE_REF}`)
    .bind(ref.id, ref.organizationId, ref.integrationId)
    .first<DeliveryRow>();
}

/**
 * F175 consumer claim: a single conditional UPDATE. Claimable from `pending`, `retrying`,
 * or a `claimed` row whose claimer has been silent past the lease. `false` means another
 * consumer holds it — a normal outcome under at-least-once delivery.
 */
export async function claimDelivery(db: D1Database, ref: DeliveryRef, nowMs: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE deliveries SET state='claimed', claimed_at=?4, first_attempt_at=COALESCE(first_attempt_at,?4),
         updated_at=CURRENT_TIMESTAMP
       ${WHERE_REF}
         AND (state IN ('pending','retrying') OR (state='claimed' AND claimed_at <= ?5))`,
    )
    .bind(ref.id, ref.organizationId, ref.integrationId, nowMs, nowMs - DELIVERY_CLAIM_LEASE_MS)
    .run();
  return result.meta.changes === 1;
}

export interface OutcomeRecord {
  readonly state: Extract<DeliveryState, 'sent' | 'accepted' | 'retrying' | 'dead_lettered'>;
  readonly attempt: number;
  readonly nowMs: number;
  readonly code: ErrorCode | null;
  /** A code we minted (`provider_http_503`); never provider text. */
  readonly diagnostic: string | null;
  readonly nextAttemptAtMs: number | null;
}

/** Record an attempt's outcome. Only the current claimer (`state='claimed'`) may write. */
export function recordOutcomeStatement(
  db: D1Database,
  ref: DeliveryRef,
  r: OutcomeRecord,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE deliveries SET state=?4, attempts=?5, last_attempt_at=?6, last_error_code=?7, last_error=?8,
         next_attempt_at=?9, dead_lettered_at=CASE WHEN ?4='dead_lettered' THEN ?6 ELSE dead_lettered_at END,
         claimed_at=NULL, updated_at=CURRENT_TIMESTAMP
       ${WHERE_REF} AND state='claimed'`,
    )
    .bind(
      ref.id,
      ref.organizationId,
      ref.integrationId,
      r.state,
      r.attempt,
      r.nowMs,
      r.code,
      r.diagnostic,
      r.nextAttemptAtMs,
    );
}
