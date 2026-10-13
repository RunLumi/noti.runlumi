import type { FilterId, ReasonCode } from './filters';

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

/** `config_invalid`: the stored filters did not re-validate, so the event was delivered (fail open). */
export type DecisionReason = ReasonCode | 'no_filters' | 'config_invalid';

export interface RoutingDecisionRow {
  /** The deterministic delivery id for (dedup key, integration). A redelivery maps to the same row. */
  readonly id: string;
  readonly organizationId: string;
  readonly integrationId: string;
  readonly eventType: string;
  readonly outcome: 'delivered' | 'filtered';
  readonly filterId: FilterId | null;
  readonly reason: DecisionReason;
  readonly unknown: boolean;
  readonly decidedAt: number;
}

/**
 * A provider redelivery maps to the same id and never duplicates a row. If the first attempt
 * was filtered and a redelivery after a filter edit is delivered, the row is corrected to
 * "delivered": a delivered event is never recorded as suppressed.
 */
export function decisionStatement(db: D1Database, row: RoutingDecisionRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO routing_decisions(id,organization_id,integration_id,event_type,outcome,filter_id,reason,unknown_fact,decided_at)
       VALUES(?,?,?,?,?,?,?,?,?)
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
    );
}

/** Retention: drop decisions past the window, a bounded batch per cron tick. */
export async function purgeRoutingDecisions(db: D1Database, now: number): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM routing_decisions WHERE rowid IN (
         SELECT rowid FROM routing_decisions WHERE decided_at < ? LIMIT ?)`,
    )
    .bind(now - ROUTING_RETENTION_MS, ROUTING_PURGE_ROWS_PER_TICK)
    .run();
  return result.meta.changes ?? 0;
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
