/**
 * Manual redelivery — docs/specs/12-delivery-reliability.md F182.
 *
 * A replay never mutates the delivery it replays. It writes a NEW delivery row with
 * `replay_of` pointing at the original, a fresh attempt counter, and a new outbox row; the
 * normal dispatcher and consumer take it from there. The history therefore shows both.
 *
 * Only offered when the replay could be delivered: the integration must exist in the
 * workspace, be enabled and not be quarantined (the consumer would dead-letter it
 * otherwise), and the workspace must not be pending deletion. Both are checked in the same
 * batch that writes the row, so a change between the read and the write cannot slip through.
 *
 * The audit row (when `audit` is given) is a statement in that batch, written only if the
 * replay row was actually inserted: one replay, one audit row, never one without the other.
 *
 * Idempotent: the new id is derived from `(original id, replay sequence)`, and the
 * sequence advances only in the same transaction that inserts the row. Two concurrent
 * requests for the same replay produce one row; the loser gets `created: false`.
 *
 * Tenant-scoped: every read and write is `WHERE organization_id = ?`. Authorization (the
 * `delivery.replay` capability, F24) is the calling route's job —
 * `POST /api/deliveries/:id/replay` in `src/api/deliveries.ts`.
 */
import { auditStatement } from '../audit/audit';
import { replayDeliveryId } from './ids';
import { normalizeDeliveryState, planReplay } from './state';

export interface RedeliverRequest {
  readonly organizationId: string;
  readonly deliveryId: string;
  /** Who asked, for the `delivery.replay` audit row that commits with the replay. */
  readonly audit?: {
    readonly actorId: string | null;
    readonly ip?: string | null;
    readonly userAgent?: string | null;
  };
}

export type RedeliverResult =
  | { readonly ok: true; readonly deliveryId: string; readonly replayOf: string; readonly created: boolean }
  | {
      readonly ok: false;
      readonly error:
        | 'not_found'
        | 'already_delivered'
        | 'not_replayable'
        | 'payload_unavailable'
        | 'integration_unavailable'
        | 'deletion_pending';
    };

type SourceRow = {
  id: string;
  integration_id: string;
  state: string;
  dedup_key: string | null;
  replay_count: number;
  payload_json: string | null;
  integration_usable: number;
};

function readSource(db: D1Database, req: RedeliverRequest): Promise<SourceRow | null> {
  return db
    .prepare(
      `SELECT d.id, d.integration_id, d.state, d.dedup_key, d.replay_count, o.payload_json,
              EXISTS (SELECT 1 FROM integrations i
                      WHERE i.id = d.integration_id AND i.organization_id = d.organization_id
                        AND i.enabled = 1 AND i.credentials_quarantined_at IS NULL) AS integration_usable
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

function writeStatements(
  db: D1Database,
  req: RedeliverRequest,
  source: SourceRow,
  newId: string,
  payload: string,
  sequence: number,
): D1PreparedStatement[] {
  const org = req.organizationId;
  const statements: D1PreparedStatement[] = [
    // The gate. The guards repeat the checks made before the batch, so a pause, quarantine,
    // delete or deletion request in between wins.
    db
      .prepare(
        `INSERT OR IGNORE INTO deliveries(id,integration_id,organization_id,state,attempts,dedup_key,replay_of,created_at,is_test)
         SELECT ?1,?2,?3,'pending',0,?4,?5,CURRENT_TIMESTAMP,
                COALESCE((SELECT is_test FROM deliveries WHERE id = ?5 AND organization_id = ?3), 0)
         WHERE EXISTS (SELECT 1 FROM integrations i
                       WHERE i.id = ?2 AND i.organization_id = ?3
                         AND i.enabled = 1 AND i.credentials_quarantined_at IS NULL)
           AND NOT EXISTS (SELECT 1 FROM workspace_deletions w
                           WHERE w.organization_id = ?3 AND w.cancelled_at IS NULL AND w.purged_at IS NULL)`,
      )
      .bind(newId, source.integration_id, org, source.dedup_key, source.id),
  ];
  if (req.audit) {
    // Directly after the insert, so `changes()` is that insert's row count.
    statements.push(
      auditStatement(
        db,
        {
          organizationId: org,
          actorId: req.audit.actorId,
          action: 'delivery.replay',
          subjectType: 'delivery',
          subjectId: source.id,
          outcome: 'success',
          ip: req.audit.ip ?? null,
          userAgent: req.audit.userAgent ?? null,
          metadata: { replayDeliveryId: newId },
        },
        undefined,
        { onlyIfPreviousStatementChangedRows: true },
      ),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT OR IGNORE INTO notification_outbox(id,organization_id,payload_json)
         SELECT ?1,?2,?3
         WHERE EXISTS (SELECT 1 FROM deliveries WHERE id = ?1 AND organization_id = ?2 AND replay_of = ?4)`,
      )
      .bind(newId, org, payload, source.id),
    // Guarded on the count we read, so a concurrent request cannot advance it twice. It does
    // not touch the source's `updated_at`: that would reorder the log under a reader's cursor.
    db
      .prepare(
        `UPDATE deliveries SET replay_count = ?3
         WHERE id = ?1 AND organization_id = ?2 AND replay_count = ?4
           AND EXISTS (SELECT 1 FROM deliveries WHERE id = ?5 AND organization_id = ?2)`,
      )
      .bind(source.id, org, sequence, source.replay_count, newId),
  );
  return statements;
}

export async function redeliver(db: D1Database, req: RedeliverRequest): Promise<RedeliverResult> {
  const source = await readSource(db, req);
  if (!source) return { ok: false, error: 'not_found' };
  const plan = planReplay({ id: source.id, state: normalizeDeliveryState(source.state) });
  if (!plan.ok) return { ok: false, error: plan.error };
  if (source.integration_usable !== 1) return { ok: false, error: 'integration_unavailable' };

  const sequence = source.replay_count + 1;
  const newId = (await replayDeliveryId(source.id, sequence)).hex;
  const payload = replayPayload(source.payload_json, newId, source, req.organizationId);
  if (!payload) return { ok: false, error: 'payload_unavailable' };

  const results = await db.batch(writeStatements(db, req, source, newId, payload, sequence));
  const created = (results[0]?.meta.changes ?? 0) === 1;
  if (created) return { ok: true, deliveryId: newId, replayOf: source.id, created };

  // Either an earlier request already made this exact replay, or a guard refused it.
  const exists = await db
    .prepare('SELECT 1 AS x FROM deliveries WHERE id = ? AND organization_id = ?')
    .bind(newId, req.organizationId)
    .first();
  if (exists) return { ok: true, deliveryId: newId, replayOf: source.id, created: false };
  const pending = await db
    .prepare(
      'SELECT 1 AS x FROM workspace_deletions WHERE organization_id = ? AND cancelled_at IS NULL AND purged_at IS NULL',
    )
    .bind(req.organizationId)
    .first();
  return { ok: false, error: pending ? 'deletion_pending' : 'integration_unavailable' };
}
