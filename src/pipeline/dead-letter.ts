/**
 * Dead-letter queue consumer — docs/specs/12-delivery-reliability.md F180.
 *
 * Cloudflare deletes DLQ messages that have no active consumer after four days, so this
 * consumer exists to make that loss visible rather than silent. It does one thing: move the
 * ledger row to the terminal `dead_lettered` state, so the delivery shows up as failed (and
 * can be replayed, F182) instead of sitting in `pending` or `retrying` forever.
 *
 * It never calls a provider and never retries. Every write is scoped by
 * `id AND organization_id AND integration_id`, like the main consumer.
 */
import type { DeliveryRef } from '../delivery/ledger';
import type { Bindings } from '../env';
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

export async function consumeDeadLetters(
  batch: MessageBatch<unknown>,
  env: Bindings,
  now: () => number = () => Date.now(),
): Promise<void> {
  for (const msg of batch.messages as readonly DeadLetterMessage[]) {
    const d = parseDeliveryMessage(msg.body);
    try {
      const moved = d ? await markDeadLettered(env.DB, d, now()) : false;
      log('warn', 'delivery_dead_lettered_by_queue', {
        delivery_id: d?.id ?? null,
        workspace_id: d?.organizationId ?? null,
        outcome: moved ? 'dead_lettered' : 'unchanged',
      });
    } catch (e) {
      // Retried within the DLQ consumer's own small budget; the log line is the evidence
      // if that runs out too.
      log('error', 'dead_letter_consumer_failed', { delivery_id: d?.id ?? null, error: e });
      msg.retry();
      continue;
    }
    msg.ack();
  }
}
