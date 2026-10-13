import { createAuth, type AuthBindings } from './auth/better-auth';
import workspace from './auth/workspace';
import { classifyGithubEvent, verifyGithubSignature } from './connectors/sources/github/events';
import { larkPayload, larkAccepted } from './connectors/destinations/lark/webhook';
import { Hono } from 'hono';

type Bindings = AuthBindings & {
  DELIVERY_QUEUE: Queue<Delivery>;
  GITHUB_WEBHOOK_SECRET: string;
  ENCRYPTION_KEY: string;
};

type Delivery = {
  id: string;
  integrationId: string;
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

  const eventType = classifyGithubEvent(c.req.header('x-github-event') || '', event);

  // NOTE (D3, unresolved): this still routes on `repo`, a field chosen by the sender.
  // Correct routing must key on the verified connection/installation, not a body field.
  // See docs/specs/02-identity-tenancy.md F25-F27 and F01/F04 in 00-current-state.md.
  const rows = await c.env.DB.prepare(
    'SELECT id,destination,webhook_ciphertext,lark_secret_ciphertext,event_types FROM integrations WHERE repo=? AND enabled=1',
  )
    .bind(repo)
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
      destination: row.destination,
      ciphertext: row.webhook_ciphertext,
      larkSecretCiphertext: row.lark_secret_ciphertext,
      title,
      url,
    };

    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT OR IGNORE INTO deliveries(id,integration_id,state) VALUES(?,?,'pending')",
      ).bind(payload.id, row.id),
      c.env.DB.prepare('INSERT OR IGNORE INTO notification_outbox(id,payload_json) VALUES(?,?)').bind(
        payload.id,
        JSON.stringify(payload),
      ),
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
