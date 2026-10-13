/**
 * The delivery ledger (docs/specs/12-delivery-reliability.md F175, F180, F184).
 *
 * Every statement is scoped by `id AND organization_id` (and `integration_id` where the
 * caller knows it): the consumer re-checks the tenant on every read and write, so a forged
 * message cannot touch another workspace's row. Rows written before 0009 keep their legacy
 * `${githubDelivery}:${integration}` id; rows are only ever looked up by the id the message
 * carries, so those rows are found and updated like any other.
 */
import type { ErrorCode } from '../platform/errors';
import { normalizeDeliveryState, type DeliveryState } from './state';

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
  readonly next_attempt_at: number | null;
}

/**
 * F175: how long a consumer's claim on a delivery protects it. One attempt is bounded by
 * the outbound timeout (F189), so five minutes only matters when a consumer crashed
 * mid-attempt. Engineering judgment — no spec value.
 */
export const DELIVERY_CLAIM_LEASE_MS = 5 * 60_000;

/** Bounds for the stale-claim backstop sweep, per cron tick. */
export const STALE_CLAIM_WORKSPACE_LIMIT = 25;
export const STALE_CLAIM_ROW_LIMIT = 50;

const WHERE_REF = 'WHERE id=?1 AND organization_id=?2 AND integration_id=?3';

type RawRow = Omit<DeliveryRow, 'state'> & { state: string };

export async function loadDelivery(db: D1Database, ref: DeliveryRef): Promise<DeliveryRow | null> {
  const row = await db
    .prepare(`SELECT state,attempts,claimed_at,next_attempt_at FROM deliveries ${WHERE_REF}`)
    .bind(ref.id, ref.organizationId, ref.integrationId)
    .first<RawRow>();
  return row ? { ...row, state: normalizeDeliveryState(row.state) } : null;
}

export interface Claim {
  readonly token: string;
  /** Attempts already recorded, read atomically with the claim (never from an earlier read). */
  readonly attempts: number;
}

/**
 * F175 consumer claim: one conditional UPDATE … RETURNING. Claimable when `pending`, when
 * `retrying` and due (F177/F178: a duplicate message must not skip backoff or
 * `Retry-After`), or when `claimed` by a consumer silent past the lease. `null` means the
 * row is not ours to attempt now — a normal outcome under at-least-once delivery.
 */
export async function claimDelivery(
  db: D1Database,
  ref: DeliveryRef,
  nowMs: number,
  token: string,
): Promise<Claim | null> {
  const result = await db
    .prepare(
      `UPDATE deliveries SET state='claimed', claimed_at=?4, claim_token=?6,
         first_attempt_at=COALESCE(first_attempt_at,?4), updated_at=CURRENT_TIMESTAMP
       ${WHERE_REF}
         AND (state = 'pending'
           OR (state = 'retrying' AND (next_attempt_at IS NULL OR next_attempt_at <= ?4))
           OR (state = 'claimed' AND claimed_at <= ?5))
       RETURNING attempts`,
    )
    .bind(ref.id, ref.organizationId, ref.integrationId, nowMs, nowMs - DELIVERY_CLAIM_LEASE_MS, token)
    .all<{ attempts: number }>();
  const row = result.results.length === 1 ? result.results[0] : undefined;
  return row ? { token, attempts: row.attempts } : null;
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

/**
 * Record an attempt's outcome. Fenced on the claim token: a consumer whose claim was taken
 * over (lease expiry) cannot overwrite the new holder's result.
 */
export function recordOutcomeStatement(
  db: D1Database,
  ref: DeliveryRef,
  claimToken: string,
  r: OutcomeRecord,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE deliveries SET state=?4, attempts=?5, last_attempt_at=?6, last_error_code=?7, last_error=?8,
         next_attempt_at=?9, dead_lettered_at=CASE WHEN ?4='dead_lettered' THEN ?6 ELSE dead_lettered_at END,
         claimed_at=NULL, claim_token=NULL, updated_at=CURRENT_TIMESTAMP
       ${WHERE_REF} AND state='claimed' AND claim_token=?10`,
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
      claimToken,
    );
}

/**
 * Backstop (cron): which workspaces hold claims older than the lease. Oldest first, so no
 * workspace starves. Returns organization ids only. ?1 cutoff (epoch ms) · ?2 limit
 */
export const SELECT_STALE_CLAIM_WORKSPACES_SQL = `SELECT organization_id FROM deliveries
WHERE state = 'claimed' AND claimed_at <= ?1 AND organization_id IS NOT NULL
GROUP BY organization_id ORDER BY MIN(claimed_at) LIMIT ?2`;

/** ?1 organization_id · ?2 cutoff · ?3 limit */
export const SELECT_STALE_CLAIMS_SQL = `SELECT id FROM deliveries
WHERE organization_id = ?1 AND state = 'claimed' AND claimed_at <= ?2
ORDER BY claimed_at LIMIT ?3`;

/**
 * Release a claim whose consumer vanished. The crashed attempt may have reached the
 * provider, so it is counted; once the budget is spent the row is dead-lettered instead.
 * ?1 id · ?2 organization_id · ?3 cutoff · ?4 now · ?5 max attempts
 */
export const RELEASE_STALE_CLAIM_SQL = `UPDATE deliveries SET
  state = CASE WHEN attempts + 1 >= ?5 THEN 'dead_lettered' ELSE 'retrying' END,
  next_attempt_at = CASE WHEN attempts + 1 >= ?5 THEN NULL ELSE ?4 END,
  dead_lettered_at = CASE WHEN attempts + 1 >= ?5 THEN ?4 ELSE dead_lettered_at END,
  attempts = attempts + 1, last_attempt_at = ?4,
  last_error_code = 'internal_error', last_error = 'claim_expired',
  claim_token = NULL, claimed_at = NULL, updated_at = CURRENT_TIMESTAMP
WHERE id = ?1 AND organization_id = ?2 AND state = 'claimed' AND claimed_at <= ?3`;
