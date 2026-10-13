import type { Context } from 'hono';
import type { Bindings, DeliveryMessage } from '../../../env';
import { asRecord, str } from '../../../lib/json';
import { dispatchOutbox } from '../../../pipeline/outbox';
import { isGithubEventType } from './catalog';
import { classifyGithubEvent, verifyGithubSignature } from './events';
import { recordAudit } from '../../../audit/audit';
import { handleLifecycle, LIFECYCLE_EVENTS } from './lifecycle';
import { repositoryInScope, resolveTenant } from './tenant';

/** Hard cap on an inbound body. See docs/specs/05-source-github.md F63. */
const MAX_BODY_BYTES = 1024 * 1024;

const enc = new TextEncoder();

type IntegrationRow = { id: string; event_types: string };

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

function displayFields(event: Record<string, unknown>, eventType: string): { title: string; url: string } {
  const repository = asRecord(event.repository);
  const subject =
    asRecord(event.issue) ?? asRecord(event.pull_request) ?? asRecord(event.workflow_run) ?? event;
  return {
    title: (str(subject.title) ?? str(subject.name) ?? eventType).slice(0, 300),
    url: str(subject.html_url) ?? str(repository?.html_url) ?? '',
  };
}

export async function githubWebhook(c: Context<{ Bindings: Bindings }>): Promise<Response> {
  if (!c.env.GITHUB_WEBHOOK_SECRET) return c.text('Not configured', 503);

  // Size is checked against the declared header AND the encoded body; a header alone is
  // attacker-controlled and may be absent or wrong.
  if (Number(c.req.header('content-length') || 0) > MAX_BODY_BYTES) return c.text('Too large', 413);
  const body = await c.req.text();
  if (enc.encode(body).length > MAX_BODY_BYTES) return c.text('Too large', 413);

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

  const kind = c.req.header('x-github-event') || '';
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

  // `repo` only narrows within the tenant. It is not authorization. GitHub owner and
  // repository names are case-insensitive, so the match is too.
  const rows = await c.env.DB.prepare(
    'SELECT id,event_types FROM integrations WHERE organization_id=? AND repo=? COLLATE NOCASE AND enabled=1',
  )
    .bind(organizationId, repo)
    .all<IntegrationRow>();

  const display = displayFields(event, eventType);
  let queued = 0;
  for (const row of rows.results) {
    let types: unknown;
    try {
      types = JSON.parse(row.event_types);
    } catch {
      continue;
    }
    if (!Array.isArray(types) || !types.includes(eventType)) continue;

    // Identifiers and display text only. Credentials stay in D1 (D5).
    const message: DeliveryMessage = {
      id: `${deliveryId}:${row.id}`,
      integrationId: row.id,
      organizationId,
      ...display,
    };

    // One batch, one transaction: the delivery row and the outbox row commit together.
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT OR IGNORE INTO deliveries(id,integration_id,organization_id,state) VALUES(?,?,?,'pending')",
      ).bind(message.id, row.id, organizationId),
      c.env.DB.prepare(
        'INSERT OR IGNORE INTO notification_outbox(id,organization_id,payload_json) VALUES(?,?,?)',
      ).bind(message.id, organizationId, JSON.stringify(message)),
    ]);
    if (batchResult(results, 1).meta.changes) queued++;
  }

  if (queued > 0) c.executionCtx.waitUntil(dispatchOutbox(c.env));
  return c.json({ accepted: true, persisted: queued }, 202);
}
