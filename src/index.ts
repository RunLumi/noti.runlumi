import { createAuth, type AuthBindings } from './auth/better-auth';
import workspace from './auth/workspace';
import { classifyGithubEvent, verifyGithubSignature } from './connectors/sources/github/events';
import { larkPayload, larkAccepted } from './connectors/destinations/lark/webhook';
import { Hono } from 'hono';

type Bindings = AuthBindings & {
  DELIVERY_QUEUE: Queue<Delivery>;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_ID: string;
  ENCRYPTION_KEY: string;
};

type Delivery = {
  id: string;
  integrationId: string;
  /** Resolved from the verified installation. Carried so the consumer can re-check scope. */
  organizationId: string;
  destination: 'lark' | 'slack';
  ciphertext: string;
  larkSecretCiphertext?: string | null;
  title: string;
  url: string;
};

type IntegrationRow = {
  id: string;
  destination: 'lark' | 'slack';
  webhook_ciphertext: string;
  lark_secret_ciphertext: string | null;
  event_types: string;
};

/** Hard cap on an inbound body. See docs/specs/05-source-github.md F63. */
const MAX_BODY_BYTES = 1024 * 1024;

const enc = new TextEncoder();

const app = new Hono<{ Bindings: Bindings }>();

/**
 * Read one result from a `db.batch()` response, failing loudly if the batch returned a
 * different number of results than we submitted. A silent fallback here would turn a
 * programming error into under-counted deliveries.
 */
function outboxResult<T>(results: T[], index: number): T {
  const value = results[index];
  if (value === undefined)
    throw new Error(`D1 batch returned no result at index ${index} of ${results.length}`);
  return value;
}

/**
 * Narrow an untrusted value to a plain object. Provider payloads are `unknown` until
 * proven otherwise — this is the boundary that stops an attacker-chosen field from
 * reaching a query. See docs/specs/00-current-state.md D3.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Read a non-empty string field, or undefined. Never coerces; coercion hides bugs. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function decrypt(ciphertext: string, keyHex: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/i.test(keyHex)) throw new Error('Invalid encryption key');
  // `ArrayBuffer` is explicit: TypeScript 5.7+ parameterises typed arrays and
  // `crypto.subtle.importKey` requires an ArrayBuffer-backed BufferSource.
  const raw = new Uint8Array(new ArrayBuffer(32));
  for (let i = 0; i < 32; i++) raw[i] = parseInt(keyHex.slice(i * 2, i * 2 + 2), 16);
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const bytes = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12)),
  );
}

type InstallationRow = { organization_id: string; status: string };

/**
 * Resolve the workspace that owns an inbound GitHub delivery.
 *
 * The signature alone proves only that the request was signed with our App-wide webhook
 * secret — which every installation of our App holds. It does **not** identify a tenant.
 * The `installation` block in the verified payload body is the only tenant signal we can
 * trust, because it arrives inside the signed bytes.
 *
 * `X-GitHub-Hook-Installation-Target-ID` / `-Type` are deliberately NOT used: GitHub
 * documents them only as "the resource where the webhook was created", and the sole worked
 * example is a repository webhook, so their meaning for an App webhook is undefined.
 *
 * Returns a discriminated result rather than throwing so the caller can map each failure to
 * the right status code. **Every non-`ok` outcome is a rejection.** There is no fallback to
 * "route it everywhere" — that was the original defect.
 */
export type TenantResolution =
  | { kind: 'ok'; organizationId: string }
  | { kind: 'no-installation' }
  | { kind: 'app-mismatch' }
  | { kind: 'unknown-installation' }
  | { kind: 'not-active' };

/** Pure part of tenant resolution: validate the payload's installation block. */
export function readInstallationBlock(
  event: Record<string, unknown>,
  expectedAppId: string,
): { kind: 'ok'; installationId: string } | { kind: 'no-installation' | 'app-mismatch' } {
  const installation = asRecord(event.installation);
  if (!installation) return { kind: 'no-installation' };

  const appId = installation.app_id;
  // Absent `app_id` is tolerated (GitHub omits it in some shapes) and the installation
  // lookup below is still scoped to OUR app id. But a *present* app_id must be a number
  // that matches ours — any other type or value is a cross-App payload and is rejected.
  if (appId !== undefined && (typeof appId !== 'number' || String(appId) !== expectedAppId)) {
    return { kind: 'app-mismatch' };
  }

  const id = installation.id;
  // GitHub installation ids are positive integers; anything else is not a real installation.
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return { kind: 'no-installation' };

  return { kind: 'ok', installationId: String(id) };
}

async function resolveTenant(env: Bindings, event: Record<string, unknown>): Promise<TenantResolution> {
  const block = readInstallationBlock(event, env.GITHUB_APP_ID);
  if (block.kind !== 'ok') return block;

  const row = await env.DB.prepare(
    'SELECT organization_id, status FROM github_installations WHERE installation_id=? AND app_id=?',
  )
    .bind(block.installationId, env.GITHUB_APP_ID)
    .first<InstallationRow>();

  // Unknown installation: 403. Never "allow", never fall back.
  if (!row) return { kind: 'unknown-installation' };
  if (row.status !== 'active') return { kind: 'not-active' };

  return { kind: 'ok', organizationId: row.organization_id };
}

app.all('/api/auth/*', (c) => createAuth(c.env, c.executionCtx).handler(c.req.raw));
app.route('/api/workspace', workspace);

app.get('/health', (c) => c.json({ ok: true, service: 'lumi-noti' }));

app.post('/webhooks/github', async (c) => {
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

  const repository = asRecord(event.repository);
  const repo = str(repository?.full_name);
  const deliveryId = c.req.header('x-github-delivery');
  if (!repo || !deliveryId) return c.text('Invalid event', 400);

  // ---- Tenant resolution (fixes D2/D3) -------------------------------------
  // Previously this routed on `repo`, a field chosen by the sender. The organization is
  // now resolved ONLY from the verified installation, and every failure rejects.
  const tenant = await resolveTenant(c.env, event);
  switch (tenant.kind) {
    case 'ok':
      break;
    // No installation block (e.g. a repository-webhook style `ping`): there is nowhere to
    // route, so reject rather than guess. A payload claiming a different App is rejected
    // before any lookup. All three share one response so callers cannot probe which applied.
    case 'no-installation':
    case 'app-mismatch':
    case 'unknown-installation':
      return c.text('Unknown installation', 403);
    case 'not-active':
      // Suspended or uninstalled. Must stop delivery immediately (05-source-github.md F68).
      return c.text('Installation not active', 403);
  }
  const organizationId = tenant.organizationId;

  const eventType = classifyGithubEvent(c.req.header('x-github-event') || '', event);

  // `repo` is retained only as a display/narrowing attribute. It is NOT authorization:
  // the tenant already came from the verified installation above.
  const rows = await c.env.DB.prepare(
    'SELECT id,destination,webhook_ciphertext,lark_secret_ciphertext,event_types FROM integrations WHERE organization_id=? AND repo=? AND enabled=1',
  )
    .bind(organizationId, repo)
    .all<IntegrationRow>();

  let queued = 0;
  for (const row of rows.results) {
    let types: unknown;
    try {
      types = JSON.parse(row.event_types);
    } catch {
      continue;
    }
    if (!Array.isArray(types) || !types.includes(eventType)) continue;

    const subject =
      asRecord(event.issue) ?? asRecord(event.pull_request) ?? asRecord(event.workflow_run) ?? event;
    const title = (str(subject.title) ?? str(subject.name) ?? eventType).slice(0, 300);
    const url = str(subject.html_url) ?? str(repository?.html_url) ?? '';

    const payload: Delivery = {
      id: `${deliveryId}:${row.id}`,
      integrationId: row.id,
      organizationId,
      destination: row.destination,
      ciphertext: row.webhook_ciphertext,
      larkSecretCiphertext: row.lark_secret_ciphertext,
      title,
      url,
    };

    // One batch, one transaction: the delivery row and the outbox row are committed
    // together or not at all. `organization_id` is written on both so the tenant scope
    // survives to the consumer (audit D4).
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT OR IGNORE INTO deliveries(id,integration_id,organization_id,state) VALUES(?,?,?,'pending')",
      ).bind(payload.id, row.id, organizationId),
      c.env.DB.prepare(
        'INSERT OR IGNORE INTO notification_outbox(id,organization_id,payload_json) VALUES(?,?,?)',
      ).bind(payload.id, organizationId, JSON.stringify(payload)),
    ]);
    if (outboxResult(results, 1).meta.changes) queued++;
  }

  // Prompt dispatch. The scheduled reconciler remains the recovery mechanism; neither path
  // is atomic with the claim (see docs/specs/12-delivery-reliability.md F172/F174).
  if (queued > 0) c.executionCtx.waitUntil(dispatchOutbox(c.env));
  return c.json({ accepted: true, persisted: queued }, 202);
});

async function dispatchOutbox(env: Bindings): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT id,payload_json FROM notification_outbox WHERE state='pending' ORDER BY created_at LIMIT 50",
  ).all<{ id: string; payload_json: string }>();

  for (const row of rows.results) {
    try {
      // `send()` is awaited deliberately. Wrapping a queue send in waitUntil makes its
      // errors "implicitly ignored" per Cloudflare docs — silent event loss.
      const payload = JSON.parse(row.payload_json) as Delivery;
      await env.DELIVERY_QUEUE.send(payload);
      await env.DB.prepare(
        "UPDATE notification_outbox SET state='dispatched',dispatched_at=CURRENT_TIMESTAMP WHERE id=?",
      )
        .bind(row.id)
        .run();
    } catch {
      // Leave the row pending; the reconciler retries it.
    }
  }
}

/**
 * Outbound SSRF guard. The platform does not provide egress filtering, so this allowlist
 * is ours to maintain. `redirect: 'error'` below is the second half of the control.
 */
function destinationAllowed(url: URL, destination: 'lark' | 'slack'): boolean {
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  return destination === 'slack'
    ? url.hostname === 'hooks.slack.com' && url.pathname.startsWith('/services/')
    : ['open.larksuite.com', 'open.feishu.cn'].includes(url.hostname) &&
        url.pathname.startsWith('/open-apis/bot/v2/hook/');
}

export default {
  fetch: app.fetch,

  async scheduled(_event: ScheduledEvent, env: Bindings) {
    await dispatchOutbox(env);
  },

  async queue(batch: MessageBatch<Delivery>, env: Bindings) {
    for (const msg of batch.messages) {
      const d = msg.body;
      try {
        const url = await decrypt(d.ciphertext, env.ENCRYPTION_KEY);
        const host = new URL(url);
        if (!destinationAllowed(host, d.destination)) throw new Error('Destination not allowed');

        const payload =
          d.destination === 'slack'
            ? { text: `${d.title}\n${d.url}` }
            : await larkPayload(
                { title: d.title, url: d.url },
                d.larkSecretCiphertext
                  ? await decrypt(d.larkSecretCiphertext, env.ENCRYPTION_KEY)
                  : undefined,
              );

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          redirect: 'error',
        });
        if (!res.ok) throw new Error(`Provider HTTP ${res.status}`);

        if (d.destination === 'lark') {
          // `unknown`, not `any`: the provider response is untrusted and narrowing is
          // larkAccepted's job.
          const reply: unknown = await res.json();
          if (!larkAccepted(reply)) throw new Error('Provider rejected message');
        }

        await env.DB.prepare(
          "UPDATE deliveries SET state='sent',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE id=?",
        )
          .bind(d.id)
          .run();
        msg.ack();
      } catch (e) {
        // NOTE (D11, unresolved): every failure collapses to `retrying` with no taxonomy
        // classification, and no dead-letter path. See docs/specs/12-delivery-reliability.md
        // F179/F180 before treating this as production behaviour.
        await env.DB.prepare(
          "UPDATE deliveries SET state='retrying',attempts=attempts+1,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
        )
          .bind(e instanceof Error ? e.message.slice(0, 100) : 'unknown', d.id)
          .run();
        msg.retry();
      }
    }
  },
};
