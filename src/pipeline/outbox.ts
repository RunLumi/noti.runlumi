import {
  DEAD_LETTER_INVALID_DELIVERY_SQL,
  MARK_DISPATCHED_SQL,
  OUTBOX_RETENTION_MS,
  PURGE_OUTBOX_SQL,
  PURGE_ROW_LIMIT,
  SELECT_PURGE_WORKSPACES_SQL,
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
  sqliteTimestamp,
  type Lease,
} from '../delivery/claim';
import {
  COMBINED_COUNT_MAX,
  COMBINED_SUMMARY_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  type Bindings,
  type DeliveryMessage,
} from '../env';
import { withD1Retry } from '../db/retry';
import { asRecord, str } from '../lib/json';
import { sanitiseCorrelationId, withMessageCorrelation } from '../platform/correlation';
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
  return { id, integrationId, organizationId, title, url, ...optionalDisplayFields(r) };
}

const STATUSES: ReadonlySet<unknown> = new Set(['success', 'failure', 'warning', 'info']);

/** A bounded, non-empty string, or nothing: a malformed optional field never blocks delivery. */
function bounded(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined;
}

/** Fields added in slice 5. Absent or malformed values are dropped, so legacy rows deliver. */
function optionalDisplayFields(r: Record<string, unknown>): Partial<DeliveryMessage> {
  const repo = bounded(r.repo, 200);
  const actor = bounded(r.actor, 100);
  const eventType = bounded(r.eventType, 100);
  const count =
    typeof r.count === 'number' && Number.isInteger(r.count) && r.count >= 1 && r.count <= COMBINED_COUNT_MAX
      ? r.count
      : undefined;
  const summary = bounded(r.summary, count ? COMBINED_SUMMARY_MAX_CHARS : SUMMARY_MAX_CHARS);
  const correlationId = sanitiseCorrelationId(r.correlationId);
  const status = STATUSES.has(r.status) ? (r.status as DeliveryMessage['status']) : undefined;
  return {
    ...(repo ? { repo } : {}),
    ...(actor ? { actor } : {}),
    ...(eventType ? { eventType } : {}),
    ...(summary ? { summary } : {}),
    ...(status ? { status } : {}),
    ...(count ? { count } : {}),
    ...(correlationId ? { correlationId } : {}),
  };
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

type CandidateRow = { id: string; state: 'pending' | 'claimed'; correlation_id: string | null };

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

/**
 * D1 write discipline for the dispatcher (F09, ADR 0036). A transient write failure used to abandon the
 * whole pass; the guarded UPDATEs below are retried with full jitter instead, and the retry's
 * `idempotent` flag is chosen per statement, not assumed:
 *
 *  - the claim and the expired-lease reclaim are NOT idempotent: if the first attempt committed and only
 *    the answer was lost, the repeat finds the row no longer `pending` (or no longer expired), reports
 *    `lost_race`, and the row sits `claimed` under a lease nobody holds until it expires and the next
 *    reconcile reclaims it. So only failures that mean "it did not run" are retried for them;
 *  - the dispatched mark, the release and the invalid-payload batch are idempotent: each is guarded on the
 *    lease token and on `state = 'claimed'`, so a repeat after a committed first attempt changes zero rows.
 */
const OUTBOX_WRITE = { idempotent: true } as const;

async function reclaimIfExpired(
  env: Bindings,
  orgId: string,
  row: CandidateRow,
  now: number,
): Promise<boolean> {
  if (row.state !== 'claimed') return false;
  const result = await withD1Retry(
    () =>
      env.DB.prepare(RECLAIM_EXPIRED_LEASE_SQL)
        .bind(...reclaimExpiredParams(orgId, row.id, now))
        .all(),
    { idempotent: false, label: 'outbox_reclaim' },
  );
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
  } catch (error) {
    log('warn', 'outbox_send_failed', { delivery_id: rowId, workspace_id: orgId, error });
    await withD1Retry(
      () =>
        env.DB.prepare(RELEASE_CLAIM_SQL)
          .bind(...releaseClaimParams(orgId, rowId, lease, 'internal_error', now))
          .run(),
      { ...OUTBOX_WRITE, label: 'outbox_release' },
    );
    return 'released';
  }
  await withD1Retry(
    () =>
      env.DB.prepare(MARK_DISPATCHED_SQL)
        .bind(...markDispatchedParams(orgId, rowId, lease, new Date(now).toISOString()))
        .run(),
    { ...OUTBOX_WRITE, label: 'outbox_mark_dispatched' },
  );
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
  deps: DispatchDeps,
): Promise<{ reclaimed: boolean; outcome: RowOutcome }> {
  // The cron pass has no request, so the row's own id is bound here: every line about this row, from
  // its claim to its mark, names it (F193). A row without one (written before 0027) runs unbound.
  return withMessageCorrelation(row.correlation_id, () => dispatchBoundRow(env, orgId, row, deps));
}

async function dispatchBoundRow(
  env: Bindings,
  orgId: string,
  row: CandidateRow,
  deps: DispatchDeps,
): Promise<{ reclaimed: boolean; outcome: RowOutcome }> {
  // Read per row: a pass can visit many rows serially, and a lease stamped with a stale
  // clock would expire early (M3).
  const now = deps.now();
  const reclaimed = await reclaimIfExpired(env, orgId, row, now);
  if (row.state === 'claimed' && !reclaimed) return { reclaimed, outcome: 'lost_race' };
  const claim = buildClaim({ orgId, rowId: row.id, nowMs: now, leaseToken: deps.newLeaseToken() });
  const result = await withD1Retry(
    () =>
      env.DB.prepare(claim.sql)
        .bind(...claim.params)
        .all(),
    { idempotent: false, label: 'outbox_claim' },
  );
  const claimed = claimedRow(result.results, claim);
  if (!claimed) return { reclaimed, outcome: 'lost_race' };
  const message = parseClaimedPayload(claimed.payload_json, orgId, row.id);
  if (message && !message.correlationId)
    log('warn', 'correlation_missing', { delivery_id: row.id, workspace_id: orgId });
  if (!message) {
    // One transaction: the outbox row is retired and its delivery reaches a terminal state,
    // so the ledger never waits on a row that will not be sent (F180).
    await withD1Retry(
      () =>
        env.DB.batch([
          env.DB.prepare(MARK_INVALID_SQL).bind(...markInvalidParams(orgId, row.id, claim.lease)),
          env.DB.prepare(DEAD_LETTER_INVALID_DELIVERY_SQL).bind(orgId, row.id, now),
        ]),
      { ...OUTBOX_WRITE, label: 'outbox_mark_invalid' },
    );
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
      const { reclaimed, outcome } = await dispatchRow(env, orgId, row, deps);
      report = tally(report, reclaimed, outcome);
    }
  }
  if (report.released > 0 || report.invalid > 0) log('warn', 'outbox_dispatch_incomplete', { ...report });
  return report;
}

/**
 * Retention for the outbox (bounded per tick): deletes rows whose delivery succeeded, and
 * invalid rows, once older than {@link OUTBOX_RETENTION_MS}. Rows of failed deliveries are
 * kept because replay (F182) re-reads their message.
 */
export async function purgeOutbox(env: Bindings, nowMs: number = Date.now()): Promise<number> {
  const cutoff = sqliteTimestamp(nowMs - OUTBOX_RETENTION_MS);
  const workspaces = await env.DB.prepare(SELECT_PURGE_WORKSPACES_SQL)
    .bind(cutoff, 10)
    .all<{ organization_id: string }>();
  let purged = 0;
  for (const { organization_id: orgId } of workspaces.results) {
    const result = await env.DB.prepare(PURGE_OUTBOX_SQL).bind(orgId, cutoff, PURGE_ROW_LIMIT).run();
    purged += result.meta.changes;
  }
  return purged;
}
