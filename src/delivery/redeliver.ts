/**
 * Manual redelivery — docs/specs/12-delivery-reliability.md F182.
 *
 * A replay never mutates the delivery it replays. It writes a NEW delivery row with
 * `replay_of` pointing at the original, a fresh attempt counter, and a new outbox row; the
 * normal dispatcher and consumer take it from there. The history therefore shows both.
 *
 * Idempotent: the new id is derived from `(original id, replay sequence)`, and the
 * sequence advances only in the same transaction that inserts the row. Two concurrent
 * requests for the same replay produce one row; the loser gets `created: false`.
 *
 * Tenant-scoped: every read and write is `WHERE organization_id = ?`. Authorization (the
 * `delivery.replay` capability, F24) and the audit record are the calling route's job and
 * are NOT implemented yet — there is no route.
 */
import { replayDeliveryId } from './ids';
import { planReplay, type DeliveryState } from './state';

export interface RedeliverRequest {
  readonly organizationId: string;
  readonly deliveryId: string;
}

export type RedeliverResult =
  | { readonly ok: true; readonly deliveryId: string; readonly replayOf: string; readonly created: boolean }
  | {
      readonly ok: false;
      readonly error: 'not_found' | 'already_delivered' | 'not_replayable' | 'payload_unavailable';
    };

type SourceRow = {
  id: string;
  integration_id: string;
  state: DeliveryState;
  dedup_key: string | null;
  replay_count: number;
  payload_json: string | null;
};

function readSource(db: D1Database, req: RedeliverRequest): Promise<SourceRow | null> {
  return db
    .prepare(
      `SELECT d.id, d.integration_id, d.state, d.dedup_key, d.replay_count, o.payload_json
       FROM deliveries d
       LEFT JOIN notification_outbox o ON o.id = d.id AND o.organization_id = d.organization_id
       WHERE d.id = ?1 AND d.organization_id = ?2`,
    )
    .bind(req.deliveryId, req.organizationId)
    .first<SourceRow>();
}

/** The stored message, re-addressed to the new row. `null` if it is not one we wrote. */
function replayPayload(
  payload: string | null,
  newId: string,
  source: SourceRow,
  orgId: string,
): string | null {
  if (payload === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const message = parsed as Record<string, unknown>;
  if (message.organizationId !== orgId || message.integrationId !== source.integration_id) return null;
  return JSON.stringify({ ...message, id: newId });
}

export async function redeliver(db: D1Database, req: RedeliverRequest): Promise<RedeliverResult> {
  const source = await readSource(db, req);
  if (!source) return { ok: false, error: 'not_found' };
  const plan = planReplay({ id: source.id, state: source.state });
  if (!plan.ok) return { ok: false, error: plan.error };

  const sequence = source.replay_count + 1;
  const newId = (await replayDeliveryId(source.id, sequence)).hex;
  const payload = replayPayload(source.payload_json, newId, source, req.organizationId);
  if (!payload) return { ok: false, error: 'payload_unavailable' };

  const results = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO deliveries(id,integration_id,organization_id,state,attempts,dedup_key,replay_of,created_at)
         VALUES(?1,?2,?3,'pending',0,?4,?5,CURRENT_TIMESTAMP)`,
      )
      .bind(newId, source.integration_id, req.organizationId, source.dedup_key, source.id),
    db
      .prepare('INSERT OR IGNORE INTO notification_outbox(id,organization_id,payload_json) VALUES(?1,?2,?3)')
      .bind(newId, req.organizationId, payload),
    // Guarded on the count we read, so a concurrent request cannot advance it twice.
    db
      .prepare(
        `UPDATE deliveries SET replay_count = ?3, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?1 AND organization_id = ?2 AND replay_count = ?4`,
      )
      .bind(source.id, req.organizationId, sequence, source.replay_count),
  ]);
  const created = (results[0]?.meta.changes ?? 0) === 1;
  return { ok: true, deliveryId: newId, replayOf: source.id, created };
}
