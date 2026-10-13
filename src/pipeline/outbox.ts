import {
  MARK_DISPATCHED_SQL,
  MARK_INVALID_SQL,
  RECLAIM_EXPIRED_LEASE_SQL,
  RELEASE_CLAIM_SQL,
  SELECT_DUE_WORKSPACES_SQL,
  SELECT_RECONCILE_CANDIDATES_SQL,
  buildClaim,
  claimedRow,
  dueWorkspacesParams,
  markDispatchedParams,
  markInvalidParams,
  newLeaseToken,
  reclaimExpiredParams,
  reconcileCandidatesParams,
  releaseClaimParams,
  type Lease,
} from '../delivery/claim';
import type { Bindings, DeliveryMessage } from '../env';
import { asRecord, str } from '../lib/json';
import { log } from '../platform/log';

/**
 * Parse an outbox row or queue body into a message. Rows written before D5 was fixed also
 * carried ciphertext; those fields are ignored, never forwarded.
 */
export function parseDeliveryMessage(value: unknown): DeliveryMessage | null {
  const r = asRecord(value);
  if (!r) return null;
  const id = str(r.id);
  const integrationId = str(r.integrationId);
  const organizationId = str(r.organizationId);
  const title = typeof r.title === 'string' ? r.title : '';
  const url = typeof r.url === 'string' ? r.url : '';
  if (!id || !integrationId || !organizationId) return null;
  return { id, integrationId, organizationId, title, url };
}

export interface DispatchDeps {
  readonly now: () => number;
  readonly newLeaseToken: () => string;
  /** The ingress kick dispatches only its own workspace; the cron sweeps all due ones. */
  readonly organizationId?: string;
}

const DEFAULT_DEPS: DispatchDeps = { now: () => Date.now(), newLeaseToken };

type RowOutcome = 'dispatched' | 'lost_race' | 'released' | 'invalid';

export interface DispatchReport {
  readonly workspaces: number;
  readonly reclaimed: number;
  readonly dispatched: number;
  readonly lostRace: number;
  readonly released: number;
  readonly invalid: number;
}

type CandidateRow = { id: string; state: 'pending' | 'claimed' };

/** The payload must name the same row and tenant it is stored under, or it is not ours. */
function parseClaimedPayload(payload: string, orgId: string, rowId: string): DeliveryMessage | null {
  let message: DeliveryMessage | null;
  try {
    message = parseDeliveryMessage(JSON.parse(payload));
  } catch {
    return null;
  }
  return message && message.organizationId === orgId && message.id === rowId ? message : null;
}

async function reclaimIfExpired(
  env: Bindings,
  orgId: string,
  row: CandidateRow,
  now: number,
): Promise<boolean> {
  if (row.state !== 'claimed') return false;
  const result = await env.DB.prepare(RECLAIM_EXPIRED_LEASE_SQL)
    .bind(...reclaimExpiredParams(orgId, row.id, now))
    .all();
  return result.results.length === 1;
}

async function publish(
  env: Bindings,
  orgId: string,
  rowId: string,
  lease: Lease,
  message: DeliveryMessage,
  now: number,
): Promise<RowOutcome> {
  try {
    // Awaited, never waitUntil-wrapped: a failed send must be seen (F169, F173).
    await env.DELIVERY_QUEUE.send(message);
  } catch {
    await env.DB.prepare(RELEASE_CLAIM_SQL)
      .bind(...releaseClaimParams(orgId, rowId, lease, 'internal_error'))
      .run();
    return 'released';
  }
  await env.DB.prepare(MARK_DISPATCHED_SQL)
    .bind(...markDispatchedParams(orgId, rowId, lease, new Date(now).toISOString()))
    .run();
  return 'dispatched';
}

/**
 * F172: only the caller whose conditional UPDATE returned the row may send it. A crash
 * after `send()` and before the mark leaves a `claimed` row; its lease expires and the
 * reconciler sends again. The consumer's own claim (F175) turns that duplicate message
 * into a no-op.
 */
async function dispatchRow(
  env: Bindings,
  orgId: string,
  row: CandidateRow,
  now: number,
  deps: DispatchDeps,
): Promise<{ reclaimed: boolean; outcome: RowOutcome }> {
  const reclaimed = await reclaimIfExpired(env, orgId, row, now);
  if (row.state === 'claimed' && !reclaimed) return { reclaimed, outcome: 'lost_race' };
  const claim = buildClaim({ orgId, rowId: row.id, nowMs: now, leaseToken: deps.newLeaseToken() });
  const result = await env.DB.prepare(claim.sql)
    .bind(...claim.params)
    .all();
  const claimed = claimedRow(result.results, claim);
  if (!claimed) return { reclaimed, outcome: 'lost_race' };
  const message = parseClaimedPayload(claimed.payload_json, orgId, row.id);
  if (!message) {
    await env.DB.prepare(MARK_INVALID_SQL)
      .bind(...markInvalidParams(orgId, row.id, claim.lease))
      .run();
    return { reclaimed, outcome: 'invalid' };
  }
  return { reclaimed, outcome: await publish(env, orgId, row.id, claim.lease, message, now) };
}

async function dueWorkspaces(env: Bindings, now: number, deps: DispatchDeps): Promise<string[]> {
  if (deps.organizationId) return [deps.organizationId];
  const rows = await env.DB.prepare(SELECT_DUE_WORKSPACES_SQL)
    .bind(...dueWorkspacesParams(now))
    .all<{ organization_id: string }>();
  return rows.results.map((r) => r.organization_id);
}

const EMPTY_REPORT: DispatchReport = {
  workspaces: 0,
  reclaimed: 0,
  dispatched: 0,
  lostRace: 0,
  released: 0,
  invalid: 0,
};

function tally(report: DispatchReport, reclaimed: boolean, outcome: RowOutcome): DispatchReport {
  return {
    ...report,
    reclaimed: report.reclaimed + (reclaimed ? 1 : 0),
    dispatched: report.dispatched + (outcome === 'dispatched' ? 1 : 0),
    lostRace: report.lostRace + (outcome === 'lost_race' ? 1 : 0),
    released: report.released + (outcome === 'released' ? 1 : 0),
    invalid: report.invalid + (outcome === 'invalid' ? 1 : 0),
  };
}

/**
 * Publish due outbox rows to the queue (F172–F174). Safe to run concurrently: the ingress
 * `waitUntil` kick and the every-minute cron can both reach a row, and exactly one of them
 * wins its claim. Bounded per workspace and per pass.
 */
export async function dispatchOutbox(
  env: Bindings,
  deps: DispatchDeps = DEFAULT_DEPS,
): Promise<DispatchReport> {
  const now = deps.now();
  const workspaces = await dueWorkspaces(env, now, deps);
  let report: DispatchReport = { ...EMPTY_REPORT, workspaces: workspaces.length };
  for (const orgId of workspaces) {
    const candidates = await env.DB.prepare(SELECT_RECONCILE_CANDIDATES_SQL)
      .bind(...reconcileCandidatesParams(orgId, now))
      .all<CandidateRow>();
    for (const row of candidates.results) {
      const { reclaimed, outcome } = await dispatchRow(env, orgId, row, now, deps);
      report = tally(report, reclaimed, outcome);
    }
  }
  if (report.released > 0 || report.invalid > 0) log('warn', 'outbox_dispatch_incomplete', { ...report });
  return report;
}
