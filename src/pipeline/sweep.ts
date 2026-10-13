/**
 * Cron backstop for consumer claims (docs/specs/12-delivery-reliability.md F174/F175).
 *
 * A consumer that crashes or loses D1 after claiming a delivery leaves it `claimed`, with
 * its outbox row already `dispatched`. Nothing else would ever touch it. Each tick, claims
 * older than the lease are released: the abandoned attempt is counted (it may have reached
 * the provider), the row becomes `retrying` and is due now, and its outbox row is parked
 * for immediate redispatch — or, if the attempt budget is spent, it is dead-lettered.
 *
 * Enumeration is by workspace (ids only); every write is scoped by `organization_id`.
 */
import { SCHEDULE_REDISPATCH_SQL, scheduleRedispatchParams } from '../delivery/claim';
import {
  DELIVERY_CLAIM_LEASE_MS,
  RELEASE_STALE_CLAIM_SQL,
  SELECT_STALE_CLAIMS_SQL,
  SELECT_STALE_CLAIM_WORKSPACES_SQL,
  STALE_CLAIM_ROW_LIMIT,
  STALE_CLAIM_WORKSPACE_LIMIT,
} from '../delivery/ledger';
import { maxAttempts } from '../delivery/retry';
import type { Bindings } from '../env';

export async function sweepStaleClaims(env: Bindings, nowMs: number = Date.now()): Promise<number> {
  const cutoff = nowMs - DELIVERY_CLAIM_LEASE_MS;
  const workspaces = await env.DB.prepare(SELECT_STALE_CLAIM_WORKSPACES_SQL)
    .bind(cutoff, STALE_CLAIM_WORKSPACE_LIMIT)
    .all<{ organization_id: string }>();
  let released = 0;
  for (const { organization_id: orgId } of workspaces.results) {
    const rows = await env.DB.prepare(SELECT_STALE_CLAIMS_SQL)
      .bind(orgId, cutoff, STALE_CLAIM_ROW_LIMIT)
      .all<{ id: string }>();
    for (const { id } of rows.results) {
      // One transaction; the park is guarded on the row being `retrying` at `nowMs`, so a
      // dead-lettered row is never redispatched.
      const [result] = await env.DB.batch([
        env.DB.prepare(RELEASE_STALE_CLAIM_SQL).bind(id, orgId, cutoff, nowMs, maxAttempts()),
        env.DB.prepare(SCHEDULE_REDISPATCH_SQL).bind(...scheduleRedispatchParams(orgId, id, nowMs)),
      ]);
      released += result?.meta.changes ?? 0;
    }
  }
  return released;
}
