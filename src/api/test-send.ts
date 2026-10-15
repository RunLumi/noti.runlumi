import { Hono } from 'hono';
import { auditStatement, requestOrigin } from '../audit/audit';
import { newLeaseToken } from '../delivery/claim';
import { testDeliveryId } from '../delivery/ids';
import type { Bindings, DeliveryMessage } from '../env';
import { settleBackground } from '../platform/background';
import { correlationField, currentCorrelationId } from '../platform/correlation';
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
 * an outbound request to a customer-chosen destination: per minute, 5 per integration, 20 per
 * user, 30 per workspace and 10 per destination host across tenants, plus a `test_in_flight`
 * guard (one test per integration while the last is pending or retrying). The
 * limits count only requests that passed the tenant lookup, so probing another workspace's ids
 * neither reveals nor burns anything.
 */

export const TESTS_PER_INTEGRATION_PER_MINUTE = 5;
export const TESTS_PER_USER_PER_MINUTE = 20;
/** Whole workspace: many members and integrations cannot multiply the per-user figure. */
export const TESTS_PER_WORKSPACE_PER_MINUTE = 30;
/**
 * Per destination host across ALL tenants: a customer-chosen host (a custom webhook, or a shared
 * provider host like hooks.slack.com) must not receive a flood assembled from many workspaces.
 */
export const TESTS_PER_HOST_PER_MINUTE = 10;
/** A test still pending, claimed or retrying this recently blocks another one for the same integration. */
export const IN_FLIGHT_WINDOW = '-15 minutes';
const WINDOW_MS = 60_000;

export const TEST_TITLE = 'Test notification from Noti';
export const TEST_SUMMARY =
  'You asked Noti to send this message to check that this destination works. No action is needed.';

interface Target {
  id: string;
  destination_host: string | null;
  enabled: number;
  credentials_quarantined_at: string | null;
}

async function testInFlight(db: D1Database, orgId: string, integrationId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS x FROM deliveries
       WHERE integration_id=?1 AND organization_id=?2 AND is_test=1
         AND state IN ('pending','claimed','retrying') AND created_at >= datetime('now', ?3) LIMIT 1`,
    )
    .bind(integrationId, orgId, IN_FLIGHT_WINDOW)
    .first();
  return row !== null;
}

function inFlightResponse(c: Ctx): Response {
  return c.json({ error: 'A test is already running for this integration.', reason: 'test_in_flight' }, 409);
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
    'SELECT id,destination_host,enabled,credentials_quarantined_at FROM integrations WHERE id=? AND organization_id=?',
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

  // Before any budget is spent: a second click while a test is still running is not a new test.
  const inFlight = await testInFlight(c.env.DB, who.orgId, integrationId);
  if (inFlight) return inFlightResponse(c);

  const perIntegration = await hit(
    c.env.DB,
    `test-send:integration:${who.orgId}:${integrationId}`,
    TESTS_PER_INTEGRATION_PER_MINUTE,
    WINDOW_MS,
  );
  if (perIntegration.limited) return limited(c, perIntegration.retryAfterSeconds);
  const perUser = await hit(c.env.DB, `test-send:user:${who.userId}`, TESTS_PER_USER_PER_MINUTE, WINDOW_MS);
  if (perUser.limited) return limited(c, perUser.retryAfterSeconds);
  const perOrg = await hit(c.env.DB, `test-send:org:${who.orgId}`, TESTS_PER_WORKSPACE_PER_MINUTE, WINDOW_MS);
  if (perOrg.limited) return limited(c, perOrg.retryAfterSeconds);
  if (target.destination_host) {
    const perHost = await hit(
      c.env.DB,
      `test-send:host:${target.destination_host}`,
      TESTS_PER_HOST_PER_MINUTE,
      WINDOW_MS,
    );
    if (perHost.limited) return limited(c, perHost.retryAfterSeconds);
  }

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
    ...correlationField(),
  };

  // One batch. The delivery insert repeats the usability and deletion checks, so a pause,
  // quarantine, delete or deletion request that lands after the reads above wins. The outbox
  // and audit rows are written only if the delivery row was (`changes()` is the previous
  // statement's count).
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO deliveries(id,integration_id,organization_id,state,attempts,created_at,is_test,correlation_id)
       SELECT ?1,?2,?3,'pending',0,CURRENT_TIMESTAMP,1,?5
       WHERE EXISTS (SELECT 1 FROM integrations i
                     WHERE i.id = ?2 AND i.organization_id = ?3
                       AND i.enabled = 1 AND i.credentials_quarantined_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM workspace_deletions w
                         WHERE w.organization_id = ?3 AND w.cancelled_at IS NULL AND w.purged_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM deliveries t
                         WHERE t.integration_id = ?2 AND t.organization_id = ?3 AND t.is_test = 1
                           AND t.state IN ('pending','claimed','retrying')
                           AND t.created_at >= datetime('now', ?4))`,
    ).bind(id, integrationId, who.orgId, IN_FLIGHT_WINDOW, currentCorrelationId()),
    c.env.DB.prepare(
      `INSERT INTO notification_outbox(id,organization_id,payload_json,correlation_id)
       SELECT ?1,?2,?3,?4 WHERE changes() > 0`,
    ).bind(id, who.orgId, JSON.stringify(message), currentCorrelationId()),
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
  if ((results[1]?.meta.changes ?? 0) !== 1) {
    // Lost a race with another click: report what the winner made.
    if (await testInFlight(c.env.DB, who.orgId, integrationId)) return inFlightResponse(c);
    return c.json({ error: 'This integration can no longer receive a test.', reason: 'unavailable' }, 409);
  }

  c.executionCtx.waitUntil(
    settleBackground(
      dispatchOutbox(c.env, { now: () => Date.now(), newLeaseToken, organizationId: who.orgId }),
      'outbox_dispatch',
    ),
  );
  return c.json({ deliveryId: id }, 202);
});

export default testSend;
