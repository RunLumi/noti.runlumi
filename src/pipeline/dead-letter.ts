/**
 * Dead-letter queue consumer — docs/specs/12-delivery-reliability.md F180.
 *
 * Cloudflare deletes DLQ messages that have no active consumer after four days, so this
 * consumer exists to make that loss visible rather than silent. It does one thing: move the
 * ledger row to the terminal `dead_lettered` state, so the delivery shows up as failed (and
 * can be replayed, F182) instead of sitting in `pending` or `retrying` forever.
 *
 * Each run leaves one `ops_state` record (`dlq_consumer`: when, how many messages, how many rows moved),
 * so an operator can tell "the consumer ran and found nothing to move" from "it never ran". Without the
 * Queues API the Worker cannot read the dead-letter queue's depth (UNVERIFIED), so the alert registry's
 * `dlq_consumer_no_progress` works from the ledger side instead (docs/RUNBOOK.md).
 *
 * It never calls a provider and never retries. Every write is scoped by
 * `id AND organization_id AND integration_id`, like the main consumer.
 */
import type { DeliveryRef } from '../delivery/ledger';
import type { Bindings } from '../env';
import { withMessageCorrelation } from '../platform/correlation';
import { log } from '../platform/log';
import { parseDeliveryMessage } from './outbox';

/** Must match the dead-letter queue name in wrangler.jsonc (asserted by a test). */
export const DEAD_LETTER_QUEUE = 'noti-dead-letters';

/** Minted diagnostic for a delivery whose queue retries ran out. */
export const QUEUE_EXHAUSTED = 'queue_retries_exhausted';

/**
 * Any non-terminal row moves, including a `claimed` one whatever its age: the queue has
 * given up on this message, and a consumer that still held the claim had failed it on every
 * retry (H1). A live holder's later outcome write is fenced on its claim token and changes
 * nothing. Existing error codes are kept: they say why the earlier attempts failed.
 */
const MARK_DEAD_LETTERED_SQL = `UPDATE deliveries
SET state = 'dead_lettered',
    last_error_code = COALESCE(last_error_code, 'internal_error'),
    last_error = COALESCE(last_error, '${QUEUE_EXHAUSTED}'),
    dead_lettered_at = ?4, next_attempt_at = NULL, claimed_at = NULL, claim_token = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE id = ?1 AND organization_id = ?2 AND integration_id = ?3
  AND state IN ('pending', 'retrying', 'claimed')`;

export async function markDeadLettered(db: D1Database, ref: DeliveryRef, nowMs: number): Promise<boolean> {
  const result = await db
    .prepare(MARK_DEAD_LETTERED_SQL)
    .bind(ref.id, ref.organizationId, ref.integrationId, nowMs)
    .run();
  return result.meta.changes === 1;
}

interface DeadLetterMessage {
  readonly body: unknown;
  ack(): void;
  retry(): void;
}

export const DLQ_CONSUMER_STATE_KEY = 'dlq_consumer';

/** Counts and a time only. Never throws: the record is evidence, not a dependency of the move. */
async function recordConsumerRun(db: D1Database, nowMs: number, seen: number, moved: number): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO ops_state(key,value,updated_at) VALUES(?1,?2,?3)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      )
      .bind(DLQ_CONSUMER_STATE_KEY, JSON.stringify({ at: nowMs, seen, moved }), nowMs)
      .run();
  } catch (e) {
    log('warn', 'dead_letter_run_record_failed', { error: e });
  }
}

export async function consumeDeadLetters(
  batch: MessageBatch<unknown>,
  env: Bindings,
  now: () => number = () => Date.now(),
): Promise<void> {
  let moved = 0;
  for (const msg of batch.messages as readonly DeadLetterMessage[]) {
    const d = parseDeliveryMessage(msg.body);
    if (d && !d.correlationId)
      log('warn', 'correlation_missing', { delivery_id: d.id, workspace_id: d.organizationId });
    const handled = await withMessageCorrelation(d?.correlationId, async () => {
      try {
        const changed = d ? await markDeadLettered(env.DB, d, now()) : false;
        if (changed) moved++;
        log('warn', 'delivery_dead_lettered_by_queue', {
          delivery_id: d?.id ?? null,
          workspace_id: d?.organizationId ?? null,
          outcome: changed ? 'dead_lettered' : 'unchanged',
        });
        return true;
      } catch (e) {
        // Retried within the DLQ consumer's own small budget; the log line is the evidence
        // if that runs out too.
        log('error', 'dead_letter_consumer_failed', { delivery_id: d?.id ?? null, error: e });
        msg.retry();
        return false;
      }
    });
    if (handled) msg.ack();
  }
  await recordConsumerRun(env.DB, now(), batch.messages.length, moved);
}
