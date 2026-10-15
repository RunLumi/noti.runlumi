import { heldStatus } from '../routing/noise-store';

/**
 * What pausing or deleting one integration would touch (F217, ADR 0050). Read-only, tenant-scoped
 * (every statement binds the organization first) and bounded: each delivery count stops at
 * {@link IMPACT_COUNT_CAP} rows, so a large history costs at most that many index entries and the
 * answer says "more than" instead of a number it did not finish counting.
 *
 * The categories follow what the pipeline actually does:
 *  - `unsent`: `pending` or `retrying`. While the integration is paused or deleted, the consumer
 *    marks each one failed (`integration_unavailable`) when its turn comes (src/pipeline/consumer.ts).
 *  - `sending`: `claimed`, i.e. an attempt already past the integration check. It may still arrive.
 *  - `total`: every delivery row of the integration. Deleting the integration keeps these rows in
 *    the activity log (the DELETE removes no delivery row); retention removes them later.
 *  - `held`: noise-control rows (src/routing/noise-store.ts). A pause keeps them waiting; a delete
 *    removes them.
 */
export const IMPACT_COUNT_CAP = 10_000;

export const COUNT_ALL_SQL = `SELECT COUNT(*) AS n FROM (
  SELECT 1 FROM deliveries WHERE organization_id=?1 AND integration_id=?2 LIMIT ?3)`;

export const COUNT_UNSENT_SQL = `SELECT COUNT(*) AS n FROM (
  SELECT 1 FROM deliveries
  WHERE organization_id=?1 AND integration_id=?2 AND state IN ('pending','retrying') LIMIT ?3)`;

export const COUNT_SENDING_SQL = `SELECT COUNT(*) AS n FROM (
  SELECT 1 FROM deliveries WHERE organization_id=?1 AND integration_id=?2 AND state='claimed' LIMIT ?3)`;

export interface BoundedCount {
  readonly count: number;
  /** True when counting stopped at the cap: the real number is at least `count`. */
  readonly capped: boolean;
}

export interface IntegrationImpact {
  readonly deliveries: {
    readonly total: BoundedCount;
    readonly unsent: BoundedCount;
    readonly sending: BoundedCount;
  };
  readonly held: { readonly waiting: number; readonly failed: number };
}

const bounded = (n: number | null | undefined): BoundedCount => {
  const raw = n ?? 0;
  return raw > IMPACT_COUNT_CAP ? { count: IMPACT_COUNT_CAP, capped: true } : { count: raw, capped: false };
};

/**
 * The caller must already have proven that `integrationId` belongs to `organizationId` (the route
 * loads the row with both). The statements bind both anyway, so a wrong pairing counts nothing.
 */
export async function integrationImpact(
  db: D1Database,
  organizationId: string,
  integrationId: string,
): Promise<IntegrationImpact> {
  // One row past the cap tells "exactly the cap" apart from "more than the cap".
  const limit = IMPACT_COUNT_CAP + 1;
  const count = (sql: string) =>
    db.prepare(sql).bind(organizationId, integrationId, limit).first<{ n: number }>();
  const [total, unsent, sending, held] = await Promise.all([
    count(COUNT_ALL_SQL),
    count(COUNT_UNSENT_SQL),
    count(COUNT_SENDING_SQL),
    heldStatus(db, organizationId, integrationId),
  ]);
  return {
    deliveries: { total: bounded(total?.n), unsent: bounded(unsent?.n), sending: bounded(sending?.n) },
    held: { waiting: held.count, failed: held.failed },
  };
}
