import { Hono } from 'hono';
import { auditStatement, requestOrigin } from '../audit/audit';
import { newLeaseToken } from '../delivery/claim';
import { testDeliveryId } from '../delivery/ids';
import type { Bindings, DeliveryMessage } from '../env';
import { dispatchOutbox } from '../pipeline/outbox';
import { hit } from '../security/rate-limit';
import { gate, mutationRejected, type Ctx } from './integrations';
import { isDeletionPending } from './workspace-lifecycle';

/**
 * `POST /api/integrations/:id/test` — "Send a test notification" (ADR 0018, spec 07 F98).
 *
 * The test is a REAL delivery: a canonical notification, clearly labelled as a test, written
 * as an ordinary `deliveries` + `notification_outbox` pair and sent by the same dispatcher,
 * queue consumer, URL policy and adapters as every other event. So a green result proves what
 * matters (credentials open, destination host allowed, provider accepted the message) and a red
 * one carries the real error classification. Nothing here opens a credential or calls a provider.
 *
 * The response is 202 with the delivery id only; the dashboard polls `GET /api/deliveries/:id`.
 * It never contains a URL, a credential or the message body.
 *
 * Capability: `integration.update` (a member may test what they may edit). Same CSRF rules as
 * every mutation. Abuse limits are stricter than the general 30/min because every click makes
 * an outbound request to a customer's chat: 5 per integration and 20 per user per minute. The
 * limits count only requests that passed the tenant lookup, so probing another workspace's ids
 * neither reveals nor burns anything.
 */

export const TESTS_PER_INTEGRATION_PER_MINUTE = 5;
export const TESTS_PER_USER_PER_MINUTE = 20;
const WINDOW_MS = 60_000;

export const TEST_TITLE = 'Test notification from Noti';
export const TEST_SUMMARY =
  'You asked Noti to send this message to check that this destination works. No action is needed.';

interface Target {
  id: string;
  enabled: number;
  credentials_quarantined_at: string | null;
}

const testSend = new Hono<{ Bindings: Bindings }>();

function limited(c: Ctx, retryAfterSeconds: number): Response {
  return c.json({ error: 'Too many tests; wait a moment and try again.', reason: 'rate_limited' }, 429, {
    'retry-after': String(retryAfterSeconds),
  });
}

testSend.post('/:id/test', async (c) => {
  const rejected = mutationRejected(c);
  if (rejected) return rejected;
  const who = await gate(c, 'integration.update');
  if (who instanceof Response) return who;
  if (await isDeletionPending(c.env.DB, who.orgId))
    return c.json(
      {
        error: 'This workspace is scheduled for deletion. Cancel the deletion to make changes.',
        reason: 'deletion_pending',
      },
      409,
    );

  const integrationId = c.req.param('id');
  const target = await c.env.DB.prepare(
    'SELECT id,enabled,credentials_quarantined_at FROM integrations WHERE id=? AND organization_id=?',
  )
    .bind(integrationId, who.orgId)
    .first<Target>();
  if (!target) return c.json({ error: 'Not found' }, 404);
  if (target.credentials_quarantined_at !== null)
    return c.json(
      { error: 'This integration needs its destination credentials fixed first.', reason: 'quarantined' },
      409,
    );
  if (target.enabled !== 1)
    return c.json(
      { error: 'This integration is paused. Turn it on to send a test.', reason: 'disabled' },
      409,
    );

  const perIntegration = await hit(
    c.env.DB,
    `test-send:integration:${who.orgId}:${integrationId}`,
    TESTS_PER_INTEGRATION_PER_MINUTE,
    WINDOW_MS,
  );
  if (perIntegration.limited) return limited(c, perIntegration.retryAfterSeconds);
  const perUser = await hit(c.env.DB, `test-send:user:${who.userId}`, TESTS_PER_USER_PER_MINUTE, WINDOW_MS);
  if (perUser.limited) return limited(c, perUser.retryAfterSeconds);

  const id = (await testDeliveryId(who.orgId, integrationId, crypto.randomUUID())).hex;
  const message: DeliveryMessage = {
    id,
    integrationId,
    organizationId: who.orgId,
    title: TEST_TITLE,
    url: '',
    status: 'info',
    eventType: 'test',
    summary: TEST_SUMMARY,
  };

  // One batch. The delivery insert repeats the usability and deletion checks, so a pause,
  // quarantine, delete or deletion request that lands after the reads above wins. The outbox
  // and audit rows are written only if the delivery row was (`changes()` is the previous
  // statement's count).
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO deliveries(id,integration_id,organization_id,state,attempts,created_at,is_test)
       SELECT ?1,?2,?3,'pending',0,CURRENT_TIMESTAMP,1
       WHERE EXISTS (SELECT 1 FROM integrations i
                     WHERE i.id = ?2 AND i.organization_id = ?3
                       AND i.enabled = 1 AND i.credentials_quarantined_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM workspace_deletions w
                         WHERE w.organization_id = ?3 AND w.cancelled_at IS NULL AND w.purged_at IS NULL)`,
    ).bind(id, integrationId, who.orgId),
    c.env.DB.prepare(
      `INSERT INTO notification_outbox(id,organization_id,payload_json)
       SELECT ?1,?2,?3 WHERE changes() > 0`,
    ).bind(id, who.orgId, JSON.stringify(message)),
    auditStatement(
      c.env.DB,
      {
        organizationId: who.orgId,
        actorId: who.userId,
        action: 'integration.test',
        subjectType: 'integration',
        subjectId: integrationId,
        outcome: 'success',
        ...requestOrigin(c.req.raw.headers),
        metadata: { deliveryId: id },
      },
      undefined,
      { onlyIfPreviousStatementChangedRows: true },
    ),
  ]);
  if ((results[1]?.meta.changes ?? 0) !== 1)
    return c.json({ error: 'This integration can no longer receive a test.', reason: 'unavailable' }, 409);

  c.executionCtx.waitUntil(
    dispatchOutbox(c.env, { now: () => Date.now(), newLeaseToken, organizationId: who.orgId }),
  );
  return c.json({ deliveryId: id }, 202);
});

export default testSend;
