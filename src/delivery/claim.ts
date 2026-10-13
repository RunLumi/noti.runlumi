/**
 * Atomic outbox claim — docs/specs/12-delivery-reliability.md F172, F173, F174. Fixes D4.
 *
 * SQL text plus pure bind-parameter builders; the integrator runs them with
 * `env.DB.prepare(sql).bind(...params)`. No I/O happens here.
 *
 * Why this is correct on D1: a database is single-threaded, so a conditional `UPDATE … WHERE
 * state='pending'` is atomic. Only the caller whose `RETURNING` yields a row (equivalently
 * `meta.changes === 1`) may call `queue.send()`. Zero rows is the normal outcome of two
 * dispatchers racing (F172), not an error.
 *
 * The lease token is a fencing token: a dispatcher whose lease expired and was reclaimed
 * can no longer mark the row dispatched or release it, because its token no longer matches.
 *
 * Every statement that touches a row carries the `organization_id` predicate (F24, F175:
 * tenant isolation in every query). The reconciler sweep is per workspace for the same
 * reason.
 *
 * Schema these statements expect on `notification_outbox` (a migration is required — the
 * current table has neither the lease columns nor `claimed` in its state CHECK):
 *   state TEXT CHECK(state IN ('pending','claimed','dispatched'))
 *   organization_id TEXT NOT NULL
 *   claimed_at INTEGER, lease_token TEXT, lease_expires_at INTEGER   -- epoch ms
 *   dispatched_at TEXT, last_error_code TEXT, created_at TEXT
 */
import type { ErrorCode } from '../platform/errors';

export const OUTBOX_TABLE = 'notification_outbox';

/**
 * Engineering judgment: F172 asks for "a timeout" but names no value. A claim covers one
 * awaited `queue.send()`; two minutes is far above that and below two reconciler ticks
 * (F174 runs every minute).
 */
export const DEFAULT_LEASE_MS = 120_000;

/** F173: a `pending` row older than this raises `outbox_stalled`. */
export const OUTBOX_STALL_THRESHOLD_MS = 5 * 60_000;

/** Bound on rows per reconciler pass, keeping the cron inside the conservative 30 s CPU budget (F174). */
export const DEFAULT_SWEEP_LIMIT = 50;

/** ?1 claimed_at · ?2 lease_token · ?3 lease_expires_at · ?4 organization_id · ?5 id */
export const CLAIM_OUTBOX_ROW_SQL = `UPDATE ${OUTBOX_TABLE}
SET state = 'claimed', claimed_at = ?1, lease_token = ?2, lease_expires_at = ?3
WHERE organization_id = ?4 AND id = ?5 AND state = 'pending'
RETURNING id, organization_id, lease_token, lease_expires_at`;

/** ?1 dispatched_at (ISO) · ?2 organization_id · ?3 id · ?4 lease_token */
export const MARK_DISPATCHED_SQL = `UPDATE ${OUTBOX_TABLE}
SET state = 'dispatched', dispatched_at = ?1, lease_token = NULL, lease_expires_at = NULL
WHERE organization_id = ?2 AND id = ?3 AND state = 'claimed' AND lease_token = ?4`;

/** F173 send failure → back to `pending` for the reconciler. ?1 last_error_code · ?2 org · ?3 id · ?4 lease_token */
export const RELEASE_CLAIM_SQL = `UPDATE ${OUTBOX_TABLE}
SET state = 'pending', last_error_code = ?1, claimed_at = NULL, lease_token = NULL, lease_expires_at = NULL
WHERE organization_id = ?2 AND id = ?3 AND state = 'claimed' AND lease_token = ?4`;

/** F174 reclaim of a crashed claim. ?1 now (epoch ms) · ?2 organization_id · ?3 id */
export const RECLAIM_EXPIRED_LEASE_SQL = `UPDATE ${OUTBOX_TABLE}
SET state = 'pending', claimed_at = NULL, lease_token = NULL, lease_expires_at = NULL
WHERE organization_id = ?2 AND id = ?3 AND state = 'claimed' AND lease_expires_at <= ?1
RETURNING id`;

/**
 * F174 candidates for one workspace: `pending` rows, and `claimed` rows whose lease has
 * expired. ?1 organization_id · ?2 now (epoch ms) · ?3 limit
 */
export const SELECT_RECONCILE_CANDIDATES_SQL = `SELECT id, state FROM ${OUTBOX_TABLE}
WHERE organization_id = ?1
  AND (state = 'pending' OR (state = 'claimed' AND lease_expires_at <= ?2))
ORDER BY created_at
LIMIT ?3`;

/** Every statement above, for tests and for the integrator's statement registry. */
export const OUTBOX_STATEMENTS = {
  claim: CLAIM_OUTBOX_ROW_SQL,
  markDispatched: MARK_DISPATCHED_SQL,
  release: RELEASE_CLAIM_SQL,
  reclaimExpired: RECLAIM_EXPIRED_LEASE_SQL,
  reconcileCandidates: SELECT_RECONCILE_CANDIDATES_SQL,
} as const;

export interface ClaimRequest {
  readonly orgId: string;
  readonly rowId: string;
  readonly nowMs: number;
  /** Inject for tests; production uses {@link newLeaseToken}. */
  readonly leaseToken: string;
  readonly leaseMs?: number;
}

export interface Lease {
  readonly token: string;
  readonly claimedAtMs: number;
  readonly expiresAtMs: number;
}

export interface ClaimStatement {
  readonly sql: typeof CLAIM_OUTBOX_ROW_SQL;
  readonly params: readonly [number, string, number, string, string];
  readonly lease: Lease;
}

export function newLeaseToken(): string {
  return crypto.randomUUID();
}

function assertNonEmpty(name: string, value: string): void {
  if (value.length === 0) throw new RangeError(`${name} must be non-empty`);
}

/** Describe the atomic claim for one row; the caller executes it and checks for a returned row. */
export function buildClaim(request: ClaimRequest): ClaimStatement {
  assertNonEmpty('orgId', request.orgId);
  assertNonEmpty('rowId', request.rowId);
  assertNonEmpty('leaseToken', request.leaseToken);
  const leaseMs = request.leaseMs ?? DEFAULT_LEASE_MS;
  if (!Number.isInteger(leaseMs) || leaseMs <= 0) throw new RangeError('leaseMs must be a positive integer');
  const lease = {
    token: request.leaseToken,
    claimedAtMs: request.nowMs,
    expiresAtMs: request.nowMs + leaseMs,
  };
  return {
    sql: CLAIM_OUTBOX_ROW_SQL,
    params: [lease.claimedAtMs, lease.token, lease.expiresAtMs, request.orgId, request.rowId],
    lease,
  };
}

export interface ClaimedRow {
  readonly id: string;
  readonly organization_id: string;
  readonly lease_token: string;
  readonly lease_expires_at: number;
}

/**
 * Interpret the `RETURNING` rows: we own the claim only if exactly our row came back with
 * our token. Anything else means another dispatcher won (F172) — a normal outcome.
 */
export function claimWon(rows: readonly unknown[], statement: ClaimStatement): boolean {
  if (rows.length !== 1) return false;
  const row = rows[0];
  if (typeof row !== 'object' || row === null) return false;
  const r = row as Partial<Record<keyof ClaimedRow, unknown>>;
  return (
    r.id === statement.params[4] &&
    r.organization_id === statement.params[3] &&
    r.lease_token === statement.lease.token
  );
}

export function markDispatchedParams(
  orgId: string,
  rowId: string,
  lease: Lease,
  dispatchedAtIso: string,
): readonly [string, string, string, string] {
  return [dispatchedAtIso, orgId, rowId, lease.token];
}

export function releaseClaimParams(
  orgId: string,
  rowId: string,
  lease: Lease,
  code: ErrorCode,
): readonly [ErrorCode, string, string, string] {
  return [code, orgId, rowId, lease.token];
}

export function reclaimExpiredParams(
  orgId: string,
  rowId: string,
  nowMs: number,
): readonly [number, string, string] {
  return [nowMs, orgId, rowId];
}

export function reconcileCandidatesParams(
  orgId: string,
  nowMs: number,
  limit: number = DEFAULT_SWEEP_LIMIT,
): readonly [string, number, number] {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
  return [orgId, nowMs, limit];
}

/** F173: whether a pending row has waited long enough to raise `outbox_stalled`. */
export function isOutboxStalled(createdAtMs: number, nowMs: number): boolean {
  return nowMs - createdAtMs > OUTBOX_STALL_THRESHOLD_MS;
}
