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
 * Schema: `migrations/0009_delivery_reliability.sql` (lease columns, `not_before`, and
 * `claimed` in the state CHECK). Lease and schedule timestamps are epoch ms.
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

/** Bound on workspaces visited per reconciler pass. */
export const DEFAULT_WORKSPACE_LIMIT = 25;

/**
 * ?1 claimed_at · ?2 lease_token · ?3 lease_expires_at · ?4 organization_id · ?5 id.
 * A row parked by a scheduled retry is not claimable until `not_before` (F177 Tier 2).
 */
export const CLAIM_OUTBOX_ROW_SQL = `UPDATE ${OUTBOX_TABLE}
SET state = 'claimed', claimed_at = ?1, lease_token = ?2, lease_expires_at = ?3
WHERE organization_id = ?4 AND id = ?5 AND state = 'pending' AND (not_before IS NULL OR not_before <= ?1)
RETURNING id, organization_id, lease_token, lease_expires_at, payload_json`;

/** ?1 dispatched_at (ISO) · ?2 organization_id · ?3 id · ?4 lease_token */
export const MARK_DISPATCHED_SQL = `UPDATE ${OUTBOX_TABLE}
SET state = 'dispatched', dispatched_at = ?1, lease_token = NULL, lease_expires_at = NULL, not_before = NULL
WHERE organization_id = ?2 AND id = ?3 AND state = 'claimed' AND lease_token = ?4`;

/** An unparseable payload is marked, not retried forever. ?1 organization_id · ?2 id · ?3 lease_token */
export const MARK_INVALID_SQL = `UPDATE ${OUTBOX_TABLE}
SET state = 'invalid', lease_token = NULL, lease_expires_at = NULL
WHERE organization_id = ?1 AND id = ?2 AND state = 'claimed' AND lease_token = ?3`;

/**
 * F173 send failure → back to `pending`, not before ?5, so a failing queue is not hammered
 * every tick. ?1 last_error_code · ?2 org · ?3 id · ?4 lease_token · ?5 not_before
 */
export const RELEASE_CLAIM_SQL = `UPDATE ${OUTBOX_TABLE}
SET state = 'pending', last_error_code = ?1, not_before = ?5, claimed_at = NULL, lease_token = NULL, lease_expires_at = NULL
WHERE organization_id = ?2 AND id = ?3 AND state = 'claimed' AND lease_token = ?4`;

/** Engineering judgment: wait this long before re-sending a row whose `queue.send()` failed. */
export const RELEASE_BACKOFF_MS = 30_000;

/** F174 reclaim of a crashed claim. ?1 now (epoch ms) · ?2 organization_id · ?3 id */
export const RECLAIM_EXPIRED_LEASE_SQL = `UPDATE ${OUTBOX_TABLE}
SET state = 'pending', claimed_at = NULL, lease_token = NULL, lease_expires_at = NULL
WHERE organization_id = ?2 AND id = ?3 AND state = 'claimed' AND lease_expires_at <= ?1
RETURNING id`;

/**
 * F177 Tier 2: a wait the queue cannot hold is parked on the outbox row and re-enqueued by
 * the reconciler once due. Guarded on the ledger: it only parks when the delivery really is
 * `retrying` with exactly this `next_attempt_at`, so a ledger write that lost its claim (0
 * rows changed) can never schedule a redispatch. ?1 not_before (epoch ms) · ?2 org · ?3 id
 */
export const SCHEDULE_REDISPATCH_SQL = `UPDATE ${OUTBOX_TABLE}
SET state = 'pending', not_before = ?1, dispatched_at = NULL, claimed_at = NULL, lease_token = NULL, lease_expires_at = NULL
WHERE organization_id = ?2 AND id = ?3 AND state IN ('pending', 'dispatched', 'claimed')
  AND EXISTS (SELECT 1 FROM deliveries d
              WHERE d.id = ?3 AND d.organization_id = ?2 AND d.state = 'retrying' AND d.next_attempt_at = ?1)`;

/**
 * M7 / F180: a payload the dispatcher cannot use dead-letters its delivery in the same
 * batch as {@link MARK_INVALID_SQL}, so the ledger never waits on it forever.
 * ?1 organization_id · ?2 id · ?3 now (epoch ms)
 */
export const DEAD_LETTER_INVALID_DELIVERY_SQL = `UPDATE deliveries
SET state = 'dead_lettered', last_error_code = 'config_invalid', last_error = 'outbox_payload_invalid',
    dead_lettered_at = ?3, next_attempt_at = NULL, claim_token = NULL, claimed_at = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE organization_id = ?1 AND id = ?2 AND state IN ('pending', 'retrying', 'claimed')`;

/**
 * Retention (bounded per tick, per workspace): an outbox row is only needed to dispatch and,
 * for a failed delivery, to replay it (F182). Rows whose delivery succeeded, and invalid
 * rows, are deleted once older than the cutoff. Dead-lettered deliveries keep theirs.
 * ?1 organization_id · ?2 cutoff (`YYYY-MM-DD HH:MM:SS`, UTC) · ?3 limit
 */
export const PURGE_OUTBOX_SQL = `DELETE FROM ${OUTBOX_TABLE}
WHERE rowid IN (
  SELECT o.rowid FROM ${OUTBOX_TABLE} o
  WHERE o.organization_id = ?1 AND o.created_at < ?2
    AND (o.state = 'invalid'
      OR (o.state = 'dispatched' AND EXISTS (
            SELECT 1 FROM deliveries d
            WHERE d.id = o.id AND d.organization_id = o.organization_id
              AND d.state IN ('sent', 'accepted', 'suppressed'))))
  LIMIT ?3)`;

/** Workspaces with purgeable rows. ?1 cutoff · ?2 limit */
export const SELECT_PURGE_WORKSPACES_SQL = `SELECT organization_id FROM ${OUTBOX_TABLE}
WHERE organization_id IS NOT NULL AND created_at < ?1 AND state IN ('dispatched', 'invalid')
GROUP BY organization_id ORDER BY MIN(created_at) LIMIT ?2`;

/** Engineering judgment: 7 days, matching the F171 dedup horizon. */
export const OUTBOX_RETENTION_MS = 7 * 24 * 3_600_000;
export const PURGE_ROW_LIMIT = 200;

/** SQLite `CURRENT_TIMESTAMP` text form, UTC, for comparing with `created_at`. */
export function sqliteTimestamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * F174 candidates for one workspace: due `pending` rows, and `claimed` rows whose lease has
 * expired. ?1 organization_id · ?2 now (epoch ms) · ?3 limit
 */
export const SELECT_RECONCILE_CANDIDATES_SQL = `SELECT id, state, correlation_id FROM ${OUTBOX_TABLE}
WHERE organization_id = ?1
  AND ((state = 'pending' AND (not_before IS NULL OR not_before <= ?2))
    OR (state = 'claimed' AND lease_expires_at <= ?2))
ORDER BY created_at
LIMIT ?3`;

/** Every row-touching statement above; each carries the tenant predicate. */
export const OUTBOX_STATEMENTS = {
  claim: CLAIM_OUTBOX_ROW_SQL,
  markDispatched: MARK_DISPATCHED_SQL,
  markInvalid: MARK_INVALID_SQL,
  release: RELEASE_CLAIM_SQL,
  reclaimExpired: RECLAIM_EXPIRED_LEASE_SQL,
  scheduleRedispatch: SCHEDULE_REDISPATCH_SQL,
  reconcileCandidates: SELECT_RECONCILE_CANDIDATES_SQL,
  deadLetterInvalid: DEAD_LETTER_INVALID_DELIVERY_SQL,
  purge: PURGE_OUTBOX_SQL,
} as const;

/**
 * The reconciler's only cross-tenant read: *which* workspaces have due work. It returns
 * organization ids and nothing else; every subsequent read and write is scoped to one of
 * them. Rows with no organization (written before 0006) are excluded — they cannot be
 * routed safely. Oldest work first, so one busy workspace cannot starve the rest.
 * ?1 now (epoch ms) · ?2 limit
 */
export const SELECT_DUE_WORKSPACES_SQL = `SELECT organization_id FROM ${OUTBOX_TABLE}
WHERE organization_id IS NOT NULL
  AND ((state = 'pending' AND (not_before IS NULL OR not_before <= ?1))
    OR (state = 'claimed' AND lease_expires_at <= ?1))
GROUP BY organization_id
ORDER BY MIN(created_at)
LIMIT ?2`;

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
  readonly payload_json: string;
}

/**
 * Interpret the `RETURNING` rows: we own the claim only if exactly our row came back with
 * our token. Anything else means another dispatcher won (F172) — a normal outcome.
 */
export function claimedRow(rows: readonly unknown[], statement: ClaimStatement): ClaimedRow | null {
  if (rows.length !== 1) return null;
  const row = rows[0];
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Partial<Record<keyof ClaimedRow, unknown>>;
  const ours =
    r.id === statement.params[4] &&
    r.organization_id === statement.params[3] &&
    r.lease_token === statement.lease.token &&
    typeof r.payload_json === 'string';
  return ours ? (row as ClaimedRow) : null;
}

export function claimWon(rows: readonly unknown[], statement: ClaimStatement): boolean {
  return claimedRow(rows, statement) !== null;
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
  nowMs: number,
): readonly [ErrorCode, string, string, string, number] {
  return [code, orgId, rowId, lease.token, nowMs + RELEASE_BACKOFF_MS];
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

export function markInvalidParams(
  orgId: string,
  rowId: string,
  lease: Lease,
): readonly [string, string, string] {
  return [orgId, rowId, lease.token];
}

export function scheduleRedispatchParams(
  orgId: string,
  rowId: string,
  notBeforeMs: number,
): readonly [number, string, string] {
  return [notBeforeMs, orgId, rowId];
}

export function dueWorkspacesParams(
  nowMs: number,
  limit: number = DEFAULT_WORKSPACE_LIMIT,
): readonly [number, number] {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
  return [nowMs, limit];
}

/** F173: whether a pending row has waited long enough to raise `outbox_stalled`. */
export function isOutboxStalled(createdAtMs: number, nowMs: number): boolean {
  return nowMs - createdAtMs > OUTBOX_STALL_THRESHOLD_MS;
}
