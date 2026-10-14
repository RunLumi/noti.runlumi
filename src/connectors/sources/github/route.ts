import type { Context } from 'hono';
import { SUMMARY_MAX_CHARS, type Bindings, type DeliveryMessage } from '../../../env';
import { displayOf, routingFactsOf } from '../../../events/canonical';
import { validateCanonicalEvent } from '../../../events/validate';
import { readBodyCapped } from '../../../lib/body';
import { asRecord, str } from '../../../lib/json';
import { newLeaseToken } from '../../../delivery/claim';
import { dedupKey, deliveryId as deriveDeliveryId } from '../../../delivery/ids';
import { dispatchOutbox } from '../../../pipeline/outbox';
import { isGithubEventType } from './catalog';
import { classifyGithubEvent, verifyGithubSignature } from './events';
import { recordAudit } from '../../../audit/audit';
import { handleLifecycle, LIFECYCLE_EVENTS } from './lifecycle';
import { repositoryInScope, resolveTenant } from './tenant';
import { log } from '../../../platform/log';
import { mapGithubEvent } from './map';
import type { RoutingFacts } from '../../../routing/filters';
import { createRouteDecider } from '../../../routing/ingress';
import { decisionStatement, type RoutingDecisionRow } from '../../../routing/provenance';
import { createNoisePlanner } from '../../../routing/noise-ingress';
import {
  closeFailureStatement,
  failureKeyHash,
  hasOpenFailure,
  openFailureStatement,
} from '../../../routing/noise-store';
import { githubNoiseFacts, isWorkflowFailure } from './noise';
import { ingressLimiter } from '../../../security/rate-limit';

/** Hard cap on an inbound body. See docs/specs/05-source-github.md F63. */
export const MAX_BODY_BYTES = 1024 * 1024;

type IntegrationRow = {
  id: string;
  event_types: string;
  filters_json: string | null;
  noise_json: string | null;
};

/**
 * Read one result from a `db.batch()` response, failing loudly if the batch returned a
 * different number of results than we submitted. A silent fallback here would turn a
 * programming error into under-counted deliveries.
 */
function batchResult<T>(results: T[], index: number): T {
  const value = results[index];
  if (value === undefined)
    throw new Error(`D1 batch returned no result at index ${index} of ${results.length}`);
  return value;
}

type DisplayFields = Pick<
  DeliveryMessage,
  'title' | 'url' | 'repo' | 'actor' | 'status' | 'eventType' | 'summary'
>;

/** A success that closes an earlier failure of the same workflow on the same branch. */
function resolvedDisplay(d: DisplayFields): DisplayFields {
  return {
    ...d,
    title: `Resolved: ${d.title}`.slice(0, 300),
    summary: `Back to passing after an earlier failure.${d.summary ? ` ${d.summary}` : ''}`.slice(
      0,
      SUMMARY_MAX_CHARS,
    ),
  };
}

export async function githubWebhook(c: Context<{ Bindings: Bindings }>): Promise<Response> {
  if (!c.env.GITHUB_WEBHOOK_SECRET) return c.text('Not configured', 503);

  // Size is checked against the declared header AND the encoded body; a header alone is
  // attacker-controlled and may be absent or wrong.
  const read = await readBodyCapped(c.req.raw, MAX_BODY_BYTES);
  if (!read.ok) {
    // F63: say WHY, honestly. GitHub itself drops payloads over 25 MB and delivers nothing; a
    // delivery between this cap and that one reaches us and is refused here, which GitHub shows
    // as a failed delivery. Constants only: the request is not authenticated yet.
    log('warn', 'github_event_too_large', { reason: 'over_ingress_cap', limit_bytes: MAX_BODY_BYTES });
    return c.text('Too large', 413);
  }
  const body = new TextDecoder().decode(read.bytes);

  const signature = c.req.header('x-hub-signature-256') || '';
  if (!(await verifyGithubSignature(body, signature, c.env.GITHUB_WEBHOOK_SECRET)))
    return c.text('Unauthorized', 401);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return c.text('Invalid JSON', 400);
  }
  const event = asRecord(parsed);
  if (!event) return c.text('Invalid event', 400);

  // F59: the event name is a header, and a delivery without one cannot be classified.
  const kind = c.req.header('x-github-event') || '';
  if (!kind) return c.text('Invalid event', 400);
  // GitHub pings the App webhook when it is configured. It carries no installation and
  // routes nothing; acknowledging it is what makes "Redeliver" in GitHub's UI go green.
  if (kind === 'ping') return c.json({ accepted: true, ping: true }, 202);
  // Lifecycle events change installation state and never route a notification (F68).
  if (LIFECYCLE_EVENTS.has(kind)) {
    try {
      const outcome = await handleLifecycle(c.env.DB, c.env.GITHUB_APP_ID, kind, event);
      return c.json({ accepted: true, lifecycle: outcome.kind }, 202);
    } catch {
      // A 5xx makes the failure visible in GitHub's delivery log, where it can be
      // redelivered; a revocation must never be silently dropped. No payload is logged.
      console.error(JSON.stringify({ event: 'github_lifecycle_failed', kind }));
      return c.text('Lifecycle update failed', 500);
    }
  }

  const repository = asRecord(event.repository);
  const repo = str(repository?.full_name);
  const deliveryId = c.req.header('x-github-delivery');
  if (!repo || !deliveryId) return c.text('Invalid event', 400);

  // The tenant comes ONLY from the verified installation (D3). Every failure rejects, and
  // the unknown/foreign/missing cases share one response so callers cannot probe which.
  const tenant = await resolveTenant(c.env.DB, c.env.GITHUB_APP_ID, event);
  switch (tenant.kind) {
    case 'ok':
      break;
    case 'no-installation':
    case 'app-mismatch':
    case 'unknown-installation':
      return c.text('Unknown installation', 403);
    case 'not-active':
      // Suspended or uninstalled. Must stop delivery immediately (05-source-github.md F68).
      return c.text('Installation not active', 403);
  }
  const organizationId = tenant.organizationId;

  // Flood control (F29), after signature verification and tenant resolution so an
  // unauthenticated caller cannot spend an installation's budget. Lifecycle events and
  // pings returned earlier and are never limited. A limiter fault fails OPEN: losing a
  // notification to a bookkeeping error is worse than briefly skipping a flood guard.
  try {
    const decision = await ingressLimiter(c.env, Number(asRecord(event.installation)?.id));
    if (decision.limited) {
      return c.text('Too many events; retry later', 429, {
        'retry-after': String(decision.retryAfterSeconds),
      });
    }
  } catch {
    log('warn', 'rate_limit_error', { scope: 'ingress' });
  }

  // Repository scope (F67): a restricted installation never routes an excluded repository.
  const installationId = String(asRecord(event.installation)?.id);
  if (!(await repositoryInScope(c.env.DB, c.env.GITHUB_APP_ID, installationId, repository?.id))) {
    await recordAudit(c.env.DB, {
      organizationId,
      actorId: null,
      action: 'github.repository.out_of_scope',
      subjectType: 'repository',
      subjectId: repo.slice(0, 200),
      outcome: 'denied',
    });
    return c.text('Repository not in scope', 403);
  }
  const eventType = classifyGithubEvent(kind, event);
  // Outside the closed catalog nothing can be subscribed, so nothing is looked up (D16).
  if (!isGithubEventType(eventType)) return c.json({ accepted: true, persisted: 0 }, 202);

  // Normalise before routing: from here on nothing reads the provider payload except the noise
  // facts below (ADR 0020). A mapper that produces an invalid event is a bug and answers 400
  // before any write, so an invalid event can never reach a renderer.
  const normalised = validateCanonicalEvent(mapGithubEvent({ kind, event, eventType, deliveryId }));
  if (!normalised.ok) {
    log('error', 'canonical_event_invalid', {
      source: 'github',
      fields: normalised.errors.map((e) => `${e.field}:${e.reason}`).slice(0, 10),
    });
    return c.json({ error: 'schema_invalid' }, 400);
  }
  const canonical = normalised.event;

  // `repo` only narrows within the tenant. It is not authorization. GitHub owner and
  // repository names are case-insensitive, so the match is too.
  const rows = await c.env.DB.prepare(
    'SELECT id,event_types,filters_json,noise_json FROM integrations WHERE organization_id=? AND repo=? COLLATE NOCASE AND enabled=1',
  )
    .bind(organizationId, repo)
    .all<IntegrationRow>();

  const display: DisplayFields = displayOf(canonical);
  // F170: transport identity, tenant-bound. GitHub keeps X-GitHub-Delivery on a manual
  // redelivery, so the same event maps to the same key and is accepted once.
  const dedup = await dedupKey({
    orgId: organizationId,
    connectionId: tenant.installationId,
    source: 'github',
    eventId: deliveryId,
  });
  let queued = 0;
  let held = 0;
  // Facts are extracted and folded at most once, and each distinct stored filters document is
  // parsed and compiled at most once per request. They are the only part of the payload routing
  // reads, and are never stored (ADR 0010).
  let facts: RoutingFacts | undefined;
  const decide = createRouteDecider(eventType, () => (facts ??= routingFactsOf(canonical)));
  // Provenance is best effort and kept OUT of the delivery transaction: a failed record must
  // never block or lose a delivery.
  const provenance: D1PreparedStatement[] = [];
  const decidedAt = Date.now();
  // Noise control (ADR 0016) decides, per integration that has settings, deliver now or hold.
  const planner = createNoisePlanner(c.env.DB, organizationId, decidedAt);
  const noiseFacts = githubNoiseFacts(kind, event);
  for (const row of rows.results) {
    let types: unknown;
    try {
      types = JSON.parse(row.event_types);
    } catch {
      continue;
    }
    if (!Array.isArray(types)) continue;

    const subscribed = types.includes(eventType);
    // Only a success can be wanted without being subscribed (a resolution notice).
    if (!subscribed && eventType !== 'workflow_run.success') continue;
    const settings = planner.settingsOf(row.id, row.noise_json);
    // A resolution notice may be wanted by an integration that follows failures only: a success
    // it did not subscribe to is sent solely when it closes a failure that integration saw.
    const resolutionOnly =
      !subscribed &&
      eventType === 'workflow_run.success' &&
      settings?.resolution === true &&
      (types.includes('workflow_run.failure') || types.includes('workflow_run.timed_out'));
    if (!subscribed && !resolutionOnly) continue;

    let failureKey: string | null = null;
    let resolved = false;
    if (
      settings?.resolution &&
      noiseFacts.workflow !== null &&
      noiseFacts.branch !== null &&
      (eventType === 'workflow_run.success' || isWorkflowFailure(eventType))
    ) {
      failureKey = await failureKeyHash({
        organizationId,
        integrationId: row.id,
        repo,
        workflow: noiseFacts.workflow,
        branch: noiseFacts.branch,
      });
      if (eventType === 'workflow_run.success')
        resolved = await hasOpenFailure(c.env.DB, organizationId, row.id, failureKey, decidedAt);
    }
    if (resolutionOnly && !resolved) continue;

    // F184 / D10: identity is (dedup_key, destination), hashed — never a hand-built string.
    const id = (await deriveDeliveryId(dedup.hex, row.id)).hex;
    const decision = decide(row.id, row.filters_json);
    // Rows written before 0009 used this id. A redelivery of such an event must not be
    // accepted a second time under the new id.
    const legacyId = `${deliveryId}:${row.id}`;
    const record = (over: Partial<RoutingDecisionRow>): RoutingDecisionRow => ({
      id,
      organizationId,
      integrationId: row.id,
      eventType,
      outcome: decision?.pass === false ? 'filtered' : 'delivered',
      filterId: decision?.filterId ?? null,
      reason: decision?.reason ?? 'allowed',
      unknown: decision?.unknown ?? false,
      decidedAt,
      ...over,
    });
    if (decision && !decision.pass) {
      // Held back by this integration's own filters: nothing is queued, and the reason is
      // recorded so "why did I not get this" has an answer.
      provenance.push(decisionStatement(c.env.DB, record({}), [id, legacyId]));
      continue;
    }

    const itemDisplay: DisplayFields = resolved ? resolvedDisplay(display) : display;
    const plan = await planner.plan({
      integrationId: row.id,
      noiseJson: row.noise_json,
      deliveryId: id,
      legacyId,
      eventType,
      subject: noiseFacts.subject,
      // The RAW display: a held "resolved" update gets its wording once, at release time.
      display,
      resolved,
    });
    // Open or close this workflow's failure in the same transaction as what it accompanies. Opening
    // runs FIRST (it checks that this event has no delivery or held row yet, so a redelivery cannot
    // re-open a failure a later success closed); closing runs after and is idempotent.
    const opening: D1PreparedStatement[] = [];
    const closing: D1PreparedStatement[] = [];
    if (failureKey) {
      if (isWorkflowFailure(eventType))
        opening.push(
          openFailureStatement(c.env.DB, organizationId, row.id, failureKey, decidedAt, [id, legacyId]),
        );
      else if (resolved) closing.push(closeFailureStatement(c.env.DB, organizationId, row.id, failureKey));
    }
    // An event the noise settings changed the outcome of always leaves a provenance row, with
    // the reason code (held for quiet hours / digest / grouping, critical bypass, backlog full).
    if (decision || plan.reason !== null) {
      provenance.push(
        decisionStatement(c.env.DB, record(plan.reason !== null ? { reason: plan.reason } : {}), [
          id,
          legacyId,
        ]),
      );
    }
    if (plan.action === 'hold') {
      // Durable before the 2xx, exactly like a delivery. Nothing is dropped: it has a release time.
      const results = await c.env.DB.batch([...opening, plan.statement, ...closing]);
      if (batchResult(results, opening.length).meta.changes) held++;
      continue;
    }

    // Identifiers and display text only. Credentials stay in D1 (D5).
    const message: DeliveryMessage = { id, integrationId: row.id, organizationId, ...itemDisplay };

    // One batch, one transaction: the delivery row and the outbox row commit together.
    const notLegacy = 'WHERE NOT EXISTS (SELECT 1 FROM deliveries WHERE id=? AND organization_id=?)';
    const results = await c.env.DB.batch([
      ...opening,
      // Not when this very event is already waiting in `held_events` (it was held, then the
      // settings changed and GitHub redelivered it): it is released on schedule, once.
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO deliveries(id,integration_id,organization_id,state,dedup_key,created_at)
         SELECT ?,?,?,'pending',?,CURRENT_TIMESTAMP ${notLegacy}
           AND NOT EXISTS (SELECT 1 FROM held_events WHERE id=? AND organization_id=?)`,
      ).bind(id, row.id, organizationId, dedup.hex, legacyId, organizationId, id, organizationId),
      // Only when the delivery row above was new (`changes()` is the previous statement's row
      // count): a redelivery after the outbox row was purged must not be sent again.
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO notification_outbox(id,organization_id,payload_json)
         SELECT ?,?,? ${notLegacy} AND changes() > 0`,
      ).bind(id, organizationId, JSON.stringify(message), legacyId, organizationId),
      ...closing,
    ]);
    if (batchResult(results, opening.length + 1).meta.changes) queued++;
  }
  if (provenance.length > 0) {
    try {
      await c.env.DB.batch(provenance);
    } catch {
      // Redacted: counts only. The deliveries above are already durable.
      log('warn', 'routing_provenance_failed', { records: provenance.length });
    }
  }

  // The prompt path; the every-minute reconciler is the recovery path (F174). Both are
  // safe together because each row's claim is atomic (F172).
  if (queued > 0)
    c.executionCtx.waitUntil(dispatchOutbox(c.env, { now: () => Date.now(), newLeaseToken, organizationId }));
  return c.json({ accepted: true, persisted: queued, ...(held > 0 ? { held } : {}) }, 202);
}
