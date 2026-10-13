import type { FilterId, ReasonCode } from './filters';
import type { DeliverReason, HoldReason } from './noise';

/**
 * Routing provenance: why an event was delivered to, or held back from, one integration
 * (docs/specs/10-routing-and-filtering.md F137). One row per integration CONSIDERED, meaning
 * it was enabled, in the tenant, on the repository and subscribed to the event type.
 *
 * A row stores ids, the event type, the outcome and a closed reason vocabulary. It never stores
 * field values, compared literals or any part of the payload (F137 Security). It is
 * tenant-scoped, bounded by a retention window, and purged with the workspace.
 */
export const ROUTING_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const ROUTING_PURGE_ROWS_PER_TICK = 500;

/**
 * `config_invalid`: the stored filters did not re-validate, so the event was held back (fail
 * closed). `config_newer`: they were written by a newer release (a rollback), so it was sent.
 */
export type DecisionReason =
  | ReasonCode
  | 'config_invalid'
  | 'config_newer'
  // Noise control (ADR 0016): a delivered row whose reason says why it was delayed or not.
  | HoldReason
  | Extract<DeliverReason, 'critical_bypass' | 'hold_capacity'>;

export interface RoutingDecisionRow {
  /** The deterministic delivery id for (dedup key, integration). A redelivery maps to the same row. */
  readonly id: string;
  readonly organizationId: string;
  readonly integrationId: string;
  readonly eventType: string;
  readonly outcome: 'delivered' | 'filtered';
  readonly filterId: FilterId | 'config' | null;
  readonly reason: DecisionReason;
  readonly unknown: boolean;
  readonly decidedAt: number;
}

/**
 * A provider redelivery maps to the same id and never duplicates a row. If the first attempt
 * was filtered and a redelivery after a filter edit is delivered, the row is corrected to
 * "delivered": a delivered event is never recorded as suppressed.
 */
export function decisionStatement(
  db: D1Database,
  row: RoutingDecisionRow,
  deliveryIds: readonly [string, string],
): D1PreparedStatement {
  // A "filtered" row is not written when a delivery for the same event already exists (an
  // event first delivered before filters existed, or before a filter edit, and redelivered).
  const guard =
    row.outcome === 'filtered'
      ? 'WHERE NOT EXISTS (SELECT 1 FROM deliveries WHERE organization_id=? AND id IN (?,?))'
      : 'WHERE 1';
  const bindings = row.outcome === 'filtered' ? [row.organizationId, ...deliveryIds] : [];
  return db
    .prepare(
      `INSERT INTO routing_decisions(id,organization_id,integration_id,event_type,outcome,filter_id,reason,unknown_fact,decided_at)
       SELECT ?,?,?,?,?,?,?,?,? ${guard}
       ON CONFLICT(id) DO UPDATE SET outcome=excluded.outcome,filter_id=excluded.filter_id,reason=excluded.reason,
         unknown_fact=excluded.unknown_fact,decided_at=excluded.decided_at
       WHERE excluded.outcome='delivered' AND routing_decisions.outcome='filtered'`,
    )
    .bind(
      row.id,
      row.organizationId,
      row.integrationId,
      row.eventType,
      row.outcome,
      row.filterId,
      row.reason,
      row.unknown ? 1 : 0,
      row.decidedAt,
      ...bindings,
    );
}

/** One bounded delete round. */
async function purgeRound(db: D1Database, now: number): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM routing_decisions WHERE rowid IN (
         SELECT rowid FROM routing_decisions WHERE decided_at < ? LIMIT ?)`,
    )
    .bind(now - ROUTING_RETENTION_MS, ROUTING_PURGE_ROWS_PER_TICK)
    .run();
  return result.meta.changes ?? 0;
}

/** Rounds per cron tick: bounded work, but capacity (rounds x rows x ticks per day) outruns growth. */
export const ROUTING_PURGE_ROUNDS = 5;

/**
 * Retention: drop decisions past the window. Rounds repeat while a round is full, up to a bound,
 * so a backlog drains over a few ticks and cannot outgrow the purge.
 */
export async function purgeRoutingDecisions(
  db: D1Database,
  now: number,
  rounds = ROUTING_PURGE_ROUNDS,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < rounds; i++) {
    const deleted = await purgeRound(db, now);
    total += deleted;
    if (deleted < ROUTING_PURGE_ROWS_PER_TICK) break;
  }
  return total;
}

export interface RoutingLogEntry {
  readonly id: string;
  readonly eventType: string;
  readonly outcome: 'delivered' | 'filtered';
  readonly filterId: string | null;
  readonly reason: string;
  readonly unknownFact: boolean;
  readonly decidedAt: string;
}

interface LogRow {
  id: string;
  event_type: string;
  outcome: 'delivered' | 'filtered';
  filter_id: string | null;
  reason: string;
  unknown_fact: number;
  decided_at: number;
}

export const LOG_PAGE_DEFAULT = 50;
export const LOG_PAGE_MAX = 100;

/** Opaque keyset cursor over (decided_at, id). Malformed input reads as "invalid", not "start". */
export function encodeCursor(decidedAt: number, id: string): string {
  return btoa(`${decidedAt}:${id}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor(cursor: string): { decidedAt: number; id: string } | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) return null;
  try {
    const text = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
    const m = /^(\d{1,16}):([0-9a-f]{1,128})$/.exec(text);
    return m ? { decidedAt: Number(m[1]), id: m[2] ?? '' } : null;
  } catch {
    return null;
  }
}

/** Newest first. Always scoped to the organization AND the integration. */
export async function listRoutingLog(
  db: D1Database,
  organizationId: string,
  integrationId: string,
  limit: number,
  after: { decidedAt: number; id: string } | null,
): Promise<{ entries: RoutingLogEntry[]; nextCursor: string | null }> {
  const keyset = after ? 'AND (decided_at < ? OR (decided_at = ? AND id < ?))' : '';
  const params = after ? [after.decidedAt, after.decidedAt, after.id] : [];
  const rows = await db
    .prepare(
      `SELECT id,event_type,outcome,filter_id,reason,unknown_fact,decided_at FROM routing_decisions
       WHERE organization_id=? AND integration_id=? ${keyset}
       ORDER BY decided_at DESC, id DESC LIMIT ?`,
    )
    .bind(organizationId, integrationId, ...params, limit + 1)
    .all<LogRow>();
  const page = rows.results.slice(0, limit);
  const last = page.at(-1);
  return {
    entries: page.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      outcome: r.outcome,
      filterId: r.filter_id,
      reason: r.reason,
      unknownFact: r.unknown_fact === 1,
      decidedAt: new Date(r.decided_at).toISOString(),
    })),
    nextCursor: rows.results.length > limit && last ? encodeCursor(last.decided_at, last.id) : null,
  };
}
