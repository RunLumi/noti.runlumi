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
 * The token is the SHA-256 of the tenant, the filter and the sorted delivery ids. It is not a secret and
 * not a security boundary: it detects that the set changed since it was shown, nothing more;
 * authorisation is the route's capability check.
 *
 * Bounds: at most {@link BULK_REPLAY_MAX} deliveries per request (the rest are reported as
 * `remaining`, run again). Each replay goes through `redeliver()`, so every guard of a single replay
 * applies: the integration must be usable, the original message must still exist, a workspace pending
 * deletion refuses. A replay never mutates the original; it is a new delivery with `replay_of`.
 *
 * Subrequest cost: two D1 calls per created replay (the source read and the write batch; the existence
 * check runs only when nothing was created), plus the plan and the audit rows, so a full request is about
 * 400 calls, under the 1,000-per-invocation Workers Paid limit. UNVERIFIED on a real deployment.
 *
 * Concurrent identical requests: both may pass the plan check, and both then call `redeliver()`, whose ids
 * are deterministic in `(original, replay sequence)` and whose sequence advances only inside the batch that
 * inserts the row. One creates the replay, the other is told `created: false` and counts it as
 * `alreadyInFlight`. Nothing is sent twice; both requests are audited.
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

function queriesOf(
  orgId: string,
  f: BulkFilter,
): { ids: { sql: string }; count: { sql: string }; values: (string | number)[] } {
  const where = [
    'd.organization_id = ?',
    "d.state IN ('dead_lettered','failed')",
    // A failed test notification is not a notification anyone is waiting for.
    'd.is_test = 0',
    // The consumer would dead-letter a replay whose integration is gone, paused or quarantined.
    `EXISTS (SELECT 1 FROM integrations i WHERE i.id = d.integration_id AND i.organization_id = d.organization_id
             AND i.enabled = 1 AND i.credentials_quarantined_at IS NULL)`,
    // Replay re-reads the stored message; after outbox retention there is nothing to send.
    `EXISTS (SELECT 1 FROM notification_outbox o WHERE o.id = d.id AND o.organization_id = d.organization_id)`,
    // Chain ROOTS only. A replay that itself failed is not a second thing to replay: its root is, and the
    // latest-replay clause below decides whether the root is eligible, so the same notification is
    // never sent twice by one bulk request.
    'd.replay_of IS NULL',
    // Not while a replay of it is in flight or has succeeded (the same rule as a single replay).
    `COALESCE((SELECT r.state FROM deliveries r WHERE r.replay_of = d.id AND r.organization_id = d.organization_id
               ORDER BY r.rowid DESC LIMIT 1), 'dead_lettered') IN ('dead_lettered','failed')`,
  ];
  const values: (string | number)[] = [orgId];
  if (f.integrationId) {
    where.push('d.integration_id = ?');
    values.push(f.integrationId);
  }
  if (f.from) {
    where.push('d.updated_at >= ?');
    values.push(f.from);
  }
  if (f.to) {
    where.push('d.updated_at <= ?');
    values.push(f.to);
  }
  return {
    ids: { sql: `SELECT d.id FROM deliveries d WHERE ${where.join(' AND ')} ORDER BY d.id LIMIT ?` },
    count: {
      sql: `SELECT COUNT(*) AS n FROM (SELECT 1 FROM deliveries d WHERE ${where.join(' AND ')} LIMIT ?)`,
    },
    values,
  };
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
  const listIds = async (): Promise<string[]> => {
    const { ids: query, values } = queriesOf(orgId, f);
    const rows = await db
      .prepare(query.sql)
      .bind(...values, BULK_REPLAY_MAX)
      .all<{ id: string }>();
    return rows.results.map((r) => r.id);
  };
  const countAll = async (): Promise<number> => {
    const { count: query, values } = queriesOf(orgId, f);
    const row = await db
      .prepare(query.sql)
      .bind(...values, BULK_COUNT_CAP)
      .first<{ n: number }>();
    return row?.n ?? 0;
  };
  const [ids, counted] = await Promise.all([listIds(), countAll()]);
  const total = Math.max(counted, ids.length);
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
  /**
   * Called once the plan is verified and BEFORE the first replay. The route writes its audit row here: if
   * that write throws, nothing has been replayed and the request fails whole (retryable), so a failed
   * audit can never leave up to 200 unaudited replays behind.
   */
  readonly beforeReplay?: (requested: number) => Promise<void>;
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
  await req.beforeReplay?.(plan.ids.length);
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
