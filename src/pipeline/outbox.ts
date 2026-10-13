import type { Bindings, DeliveryMessage } from '../env';
import { asRecord, str } from '../lib/json';

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

/**
 * Publish pending outbox rows to the queue. The scheduled reconciler is the recovery
 * mechanism; neither path is atomic with the claim yet (D4, F172/F174 in slice 4).
 */
export async function dispatchOutbox(env: Bindings): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT id,payload_json FROM notification_outbox WHERE state='pending' ORDER BY created_at LIMIT 50",
  ).all<{ id: string; payload_json: string }>();

  for (const row of rows.results) {
    let message: DeliveryMessage | null;
    try {
      message = parseDeliveryMessage(JSON.parse(row.payload_json));
    } catch {
      message = null;
    }
    if (!message) {
      // Unparseable rows are marked, not skipped forever and not retried forever.
      await env.DB.prepare("UPDATE notification_outbox SET state='invalid' WHERE id=?").bind(row.id).run();
      continue;
    }
    try {
      // `send()` is awaited deliberately. Wrapping a queue send in waitUntil makes its
      // errors "implicitly ignored" per Cloudflare docs — silent event loss.
      await env.DELIVERY_QUEUE.send(message);
      // The payload is rewritten to the id-only shape, which scrubs any legacy ciphertext.
      await env.DB.prepare(
        "UPDATE notification_outbox SET state='dispatched',dispatched_at=CURRENT_TIMESTAMP,payload_json=? WHERE id=?",
      )
        .bind(JSON.stringify(message), row.id)
        .run();
    } catch {
      // Leave the row pending; the reconciler retries it.
    }
  }
}
