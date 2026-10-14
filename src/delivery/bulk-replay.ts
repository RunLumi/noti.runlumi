/**
 * Bulk and scoped replay — docs/specs/12-delivery-reliability.md F182 ("replay one dead letter, or all
 * for a destination since a date").
 *
 * Two steps, so a person sees the number before anything is sent:
 *
 * 1. PLAN: the eligible dead-lettered deliveries for a filter (workspace, optionally one integration
 *    and a time window), counted, with a token. Nothing is written.
 * 2. RUN: the same filter plus the plan token. The server recomputes the eligible set; if it is not
 *    exactly the set the person saw (a delivery was replayed, delivered, or newly failed in between)
 *    it refuses with `plan_stale` and the new count, and writes nothing. So a double click, a retried
 *    request or a changed backlog can never replay more than was previewed.
 *
 * The token is the SHA-256 of the tenant, the filter and the sorted delivery ids, not a secret: it
 * proves "this is the set you were shown", it does not authorise (the route's capability check does).
 *
 * Bounds: at most {@link BULK_REPLAY_MAX} deliveries per request (the rest are reported as
 * `remaining`, run again). Each replay goes through `redeliver()`, so every guard of a single replay
 * applies: the integration must be usable, the original message must still exist, a workspace pending
 * deletion refuses. A replay never mutates the original; it is a new delivery with `replay_of`.
 *
 * Subrequest cost: about three D1 calls per replay (read, batch, existence check), so a full request
 * is ~600 calls, under the 1,000-per-invocation Workers Paid limit. UNVERIFIED on a real deployment.
 *
 * Audit: ONE `delivery.bulk_replay` row with the counts and the filter, not one row per replay; each
 * new delivery carries `replay_of`, so the log still links every replay to its original.
 */
import { encodeComponents, toHex } from './ids';
import { redeliver } from './redeliver';

export const BULK_REPLAY_MAX = 200;
/** Counting stops here: "more than 10,000" is as useful to a person as the exact number. */
export const BULK_COUNT_CAP = 10_000;
/** Above this many replays the dashboard asks the person to type the number to confirm. */
export const BULK_TYPED_CONFIRMATION_THRESHOLD = 20;

export interface BulkFilter {
  readonly integrationId: string | null;
  /** SQLite `YYYY-MM-DD HH:MM:SS` UTC, inclusive, compared with `updated_at`. */
  readonly from: string | null;
  readonly to: string | null;
}

export interface BulkPlan {
  /** The deliveries a run with this token would replay: at most {@link BULK_REPLAY_MAX}. */
  readonly ids: readonly string[];
  /** All eligible deliveries, up to {@link BULK_COUNT_CAP}. */
  readonly total: number;
  readonly totalCapped: boolean;
  readonly token: string;
}

function whereOf(orgId: string, f: BulkFilter): { where: string; values: (string | number)[] } {
  const clauses = [
    'd.organization_id = ?',
    "d.state IN ('dead_lettered','failed')",
    // A failed test notification is not a notification anyone is waiting for.
    'd.is_test = 0',
    // The consumer would dead-letter a replay whose integration is gone, paused or quarantined.
    `EXISTS (SELECT 1 FROM integrations i WHERE i.id = d.integration_id AND i.organization_id = d.organization_id
             AND i.enabled = 1 AND i.credentials_quarantined_at IS NULL)`,
    // Replay re-reads the stored message; after outbox retention there is nothing to send.
    `EXISTS (SELECT 1 FROM notification_outbox o WHERE o.id = d.id AND o.organization_id = d.organization_id)`,
    // Not while a replay of it is in flight or has succeeded (the same rule as a single replay).
    `COALESCE((SELECT r.state FROM deliveries r WHERE r.replay_of = d.id AND r.organization_id = d.organization_id
               ORDER BY r.rowid DESC LIMIT 1), 'dead_lettered') IN ('dead_lettered','failed')`,
  ];
  const values: (string | number)[] = [orgId];
  if (f.integrationId) {
    clauses.push('d.integration_id = ?');
    values.push(f.integrationId);
  }
  if (f.from) {
    clauses.push('d.updated_at >= ?');
    values.push(f.from);
  }
  if (f.to) {
    clauses.push('d.updated_at <= ?');
    values.push(f.to);
  }
  return { where: clauses.join(' AND '), values };
}

async function tokenOf(orgId: string, f: BulkFilter, ids: readonly string[]): Promise<string> {
  const bytes = encodeComponents([
    ['domain', 'noti.bulk-replay.v1'],
    ['organizationId', orgId],
    ['integrationId', f.integrationId ?? '-'],
    ['from', f.from ?? '-'],
    ['to', f.to ?? '-'],
    ['ids', ids.length === 0 ? '-' : ids.join(',')],
  ]);
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

/** Read-only. The set is ordered by id, so the same backlog always yields the same plan and token. */
export async function planBulkReplay(db: D1Database, orgId: string, f: BulkFilter): Promise<BulkPlan> {
  const { where, values } = whereOf(orgId, f);
  const [idRows, countRow] = await Promise.all([
    db
      .prepare(`SELECT d.id FROM deliveries d WHERE ${where} ORDER BY d.id LIMIT ?`)
      .bind(...values, BULK_REPLAY_MAX)
      .all<{ id: string }>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM deliveries d WHERE ${where} LIMIT ?)`)
      .bind(...values, BULK_COUNT_CAP)
      .first<{ n: number }>(),
  ]);
  const ids = idRows.results.map((r) => r.id);
  const total = Math.max(countRow?.n ?? 0, ids.length);
  return { ids, total, totalCapped: total >= BULK_COUNT_CAP, token: await tokenOf(orgId, f, ids) };
}

export interface BulkRunResult {
  readonly requested: number;
  /** New replay deliveries written. */
  readonly replayed: number;
  /** Already replayed by an earlier request (idempotent no-op). */
  readonly alreadyInFlight: number;
  /** Refused by a single-replay guard (integration paused, message gone, deletion pending). */
  readonly refused: number;
  /** Eligible deliveries beyond this request's bound: run again for the next batch. */
  readonly remaining: number;
  readonly deletionPending: boolean;
}

export type BulkRunOutcome =
  | { readonly ok: true; readonly result: BulkRunResult }
  | {
      readonly ok: false;
      readonly error: 'plan_stale' | 'nothing_to_replay' | 'count_mismatch';
      readonly eligible: number;
    };

export interface BulkRunRequest {
  readonly organizationId: string;
  readonly filter: BulkFilter;
  readonly token: string;
  /** The count the person confirmed (typed, above the threshold). */
  readonly expectedCount: number;
}

/**
 * Replay the planned set. Refuses unless the freshly computed set matches `token`; the check and the
 * replays are not one transaction (D1 cannot hold one across `redeliver`'s reads), so a concurrent
 * change after the check is handled per delivery by `redeliver()`'s own guards and idempotent ids.
 */
export async function runBulkReplay(db: D1Database, req: BulkRunRequest): Promise<BulkRunOutcome> {
  const plan = await planBulkReplay(db, req.organizationId, req.filter);
  if (plan.ids.length === 0) return { ok: false, error: 'nothing_to_replay', eligible: 0 };
  if (plan.token !== req.token) return { ok: false, error: 'plan_stale', eligible: plan.total };
  if (req.expectedCount !== plan.ids.length) {
    return { ok: false, error: 'count_mismatch', eligible: plan.ids.length };
  }
  let replayed = 0;
  let alreadyInFlight = 0;
  let refused = 0;
  let deletionPending = false;
  for (const id of plan.ids) {
    const result = await redeliver(db, { organizationId: req.organizationId, deliveryId: id });
    if (result.ok) {
      if (result.created) replayed++;
      else alreadyInFlight++;
      continue;
    }
    refused++;
    if (result.error === 'deletion_pending') {
      deletionPending = true;
      // Every remaining replay would be refused the same way.
      break;
    }
  }
  return {
    ok: true,
    result: {
      requested: plan.ids.length,
      replayed,
      alreadyInFlight,
      refused,
      remaining: Math.max(0, plan.total - plan.ids.length),
      deletionPending,
    },
  };
}
