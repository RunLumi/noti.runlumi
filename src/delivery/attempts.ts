/**
 * Per-attempt ledger — docs/specs/12-delivery-reliability.md F184, F181, F99.
 *
 * One `delivery_attempts` row per consumer attempt, and one per deferral (the circuit breaker or the
 * pacing hold sent the delivery back without calling the destination). The row is written in the SAME
 * batch as the ledger transition and only when that transition changed a row, so a consumer that lost
 * its claim leaves no trace and a double-consumed message records one attempt, not two.
 *
 * Everything stored is from a closed vocabulary or a number: the taxonomy code (F13), a diagnostic we
 * minted, a status CLASS (never the status itself, never a body, header or URL), and the provider's
 * `Retry-After` in ms. `provider_message_id` is nullable and stays NULL: no current adapter response
 * carries one (Slack, Teams and Lark webhooks reply without an id; Discord only with `?wait=true`,
 * which we do not send). UNVERIFIED against real providers.
 */
import type { ProviderResponse } from '../connectors/destinations';
import type { ErrorCode } from '../platform/errors';
import type { AttemptResult } from './classify';
import type { DeliveryRef } from './ledger';

import {
  ATTEMPT_ROW_OUTCOMES,
  STATUS_CLASSES,
  type AttemptRecord,
  type AttemptRowOutcome,
  type StatusClass,
} from './attempt-types';

export { STATUS_CLASSES, type AttemptRecord, type AttemptRowOutcome, type StatusClass };

/** What the consumer learned about one attempt beyond the retry policy's inputs. */
export interface AttemptReport {
  readonly result: AttemptResult;
  readonly statusClass: StatusClass;
  /** How long the destination asked to be left alone, in ms (rate-limit headers, 429), or null. */
  readonly paceMs: number | null;
  readonly providerMessageId: string | null;
}

/** HTTP status (or its absence) to the bucket we store. */
export function statusClassOf(
  res: Pick<ProviderResponse, 'status'> | null,
  diagnostic: string | null,
): StatusClass {
  if (res) {
    const s = res.status;
    if (s >= 200 && s < 300) return '2xx';
    if (s >= 300 && s < 400) return '3xx';
    if (s >= 400 && s < 500) return '4xx';
    if (s >= 500 && s < 600) return '5xx';
    return 'none';
  }
  if (diagnostic === 'provider_timeout') return 'timeout';
  if (diagnostic === 'transient_error' || diagnostic === 'destination_unreachable') return 'network';
  return 'none';
}

/**
 * F185: after this attempt the provider may nonetheless have processed the request, so a retry can
 * show the message twice. True for a failure whose outcome we could not observe: a timeout, a dropped
 * connection, or a 5xx (Slack documents that part of an operation can succeed before an internal
 * error). A 4xx is the provider telling us it did NOT process the request.
 */
export function isUnconfirmed(report: AttemptReport): boolean {
  return (
    report.result.outcome.kind === 'failed' &&
    (report.statusClass === 'timeout' || report.statusClass === 'network' || report.statusClass === '5xx')
  );
}

export interface AttemptRow {
  readonly attempt: number;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly outcome: AttemptRowOutcome;
  readonly errorCode: ErrorCode | null;
  readonly reason: string | null;
  readonly statusClass: StatusClass;
  readonly retryAfterMs: number | null;
  readonly providerMessageId: string | null;
  readonly possibleDuplicate: boolean;
}

/**
 * Insert directly after the ledger write: `changes()` is that write's row count, so nothing is
 * recorded for a consumer that lost its claim. Leaves `changes()` at 1 for the next gated statement.
 */
export function attemptStatement(db: D1Database, ref: DeliveryRef, row: AttemptRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO delivery_attempts(id,organization_id,delivery_id,integration_id,attempt,started_at,finished_at,
         outcome,error_code,reason,status_class,retry_after_ms,provider_message_id,possible_duplicate)
       SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14 WHERE changes() = 1`,
    )
    .bind(
      crypto.randomUUID(),
      ref.organizationId,
      ref.id,
      ref.integrationId,
      row.attempt,
      row.startedAtMs,
      row.finishedAtMs,
      row.outcome,
      row.errorCode,
      row.reason,
      row.statusClass,
      row.retryAfterMs,
      row.providerMessageId,
      row.possibleDuplicate ? 1 : 0,
    );
}

type StoredAttempt = {
  attempt: number;
  started_at: number;
  finished_at: number;
  outcome: string;
  error_code: string | null;
  reason: string | null;
  status_class: string;
  retry_after_ms: number | null;
  provider_message_id: string | null;
  possible_duplicate: number;
};

/** A delivery has at most 13 attempts plus deferrals, so this is a safety bound, not a page size. */
export const ATTEMPT_LIST_LIMIT = 50;

const OUTCOMES: ReadonlySet<string> = new Set(ATTEMPT_ROW_OUTCOMES);
const CLASSES: ReadonlySet<string> = new Set(STATUS_CLASSES);

/** Tenant-scoped read, oldest first. */
export async function listAttempts(
  db: D1Database,
  organizationId: string,
  deliveryId: string,
): Promise<AttemptRecord[]> {
  const rows = await db
    .prepare(
      `SELECT attempt,started_at,finished_at,outcome,error_code,reason,status_class,retry_after_ms,
              provider_message_id,possible_duplicate
       FROM delivery_attempts WHERE organization_id = ?1 AND delivery_id = ?2
       ORDER BY started_at, finished_at, rowid LIMIT ?3`,
    )
    .bind(organizationId, deliveryId, ATTEMPT_LIST_LIMIT)
    .all<StoredAttempt>();
  return rows.results.map((r) => ({
    attempt: r.attempt,
    startedAtMs: r.started_at,
    finishedAtMs: r.finished_at,
    outcome: (OUTCOMES.has(r.outcome) ? r.outcome : 'retry_scheduled') as AttemptRowOutcome,
    errorCode: r.error_code,
    reason: r.reason,
    statusClass: (CLASSES.has(r.status_class) ? r.status_class : 'none') as StatusClass,
    retryAfterMs: r.retry_after_ms,
    providerMessageId: r.provider_message_id,
    possibleDuplicate: r.possible_duplicate === 1,
  }));
}
