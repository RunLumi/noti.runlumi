import { larkAccepted, larkPayload } from '../connectors/destinations/lark/webhook';
import { CryptoError, type Keyring } from '../crypto/envelope';
import { keyringFromEnv } from '../crypto/keyring-env';
import type { Bindings, DeliveryMessage } from '../env';
import { CREDENTIAL_COLUMNS, openCredentials, type CredentialRow } from './credentials';
import { parseDeliveryMessage } from './outbox';

type Destination = 'lark' | 'slack';
type IntegrationRow = CredentialRow & { destination: Destination };

/**
 * Outbound SSRF guard. The platform does not provide egress filtering, so this allowlist
 * is ours to maintain. `redirect: 'error'` below is the second half of the control.
 */
export function destinationAllowed(url: URL, destination: Destination): boolean {
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password || url.port) return false;
  return destination === 'slack'
    ? url.hostname === 'hooks.slack.com' && url.pathname.startsWith('/services/')
    : ['open.larksuite.com', 'open.feishu.cn'].includes(url.hostname) &&
        url.pathname.startsWith('/open-apis/bot/v2/hook/');
}

/** A failure that retrying cannot fix. The delivery is marked failed and acknowledged. */
class PermanentFailure extends Error {}

async function loadIntegration(env: Bindings, d: DeliveryMessage): Promise<IntegrationRow> {
  // Tenant re-check: the row must belong to the organization the ingress resolved.
  const row = await env.DB.prepare(
    `SELECT destination,${CREDENTIAL_COLUMNS} FROM integrations
     WHERE id=? AND organization_id=? AND enabled=1 AND credentials_quarantined_at IS NULL`,
  )
    .bind(d.integrationId, d.organizationId)
    .first<IntegrationRow>();
  if (!row) throw new PermanentFailure('integration_unavailable');
  return row;
}

/**
 * Only defects in the row's own bytes are permanent. A wrong or missing key, or an unknown
 * KEK version, is a deployment fault: retrying after the fix delivers, so the message must
 * not be acknowledged and lost.
 */
function classifyCryptoError(e: CryptoError): Error {
  return e.code === 'destination_credentials_invalid' || e.code === 'malformed_envelope'
    ? new PermanentFailure(e.code)
    : new Error(`provider_config_${e.code}`);
}

async function deliver(env: Bindings, keyring: Keyring, d: DeliveryMessage): Promise<void> {
  const row = await loadIntegration(env, d);
  let credentials;
  try {
    credentials = await openCredentials(row, keyring, env.ENCRYPTION_KEY);
  } catch (e) {
    if (e instanceof CryptoError) throw classifyCryptoError(e);
    throw e;
  }

  let target: URL;
  try {
    target = new URL(credentials.webhookUrl);
  } catch {
    // The URL parser's message echoes its input, which is a secret. Never surface it.
    throw new PermanentFailure('destination_url_invalid');
  }
  if (!destinationAllowed(target, row.destination)) throw new PermanentFailure('destination_not_allowed');

  const payload =
    row.destination === 'slack'
      ? { text: `${d.title}\n${d.url}` }
      : await larkPayload({ title: d.title, url: d.url }, credentials.signingSecret ?? undefined);

  const res = await fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'error',
  });
  if (!res.ok) {
    // Release the connection; the body is never read, so it can never reach a log.
    await res.body?.cancel();
    throw new Error(`provider_http_${res.status}`);
  }

  if (row.destination === 'lark') {
    // `unknown`, not `any`: the provider response is untrusted and narrowing is
    // larkAccepted's job.
    const reply: unknown = await res.json();
    if (!larkAccepted(reply)) throw new Error('provider_rejected');
  }
}

/** Scoped to the tenant and integration the message names, never by id alone. */
async function record(env: Bindings, d: DeliveryMessage, state: string, error: string | null): Promise<void> {
  await env.DB.prepare(
    `UPDATE deliveries SET state=?,attempts=attempts+1,last_error=?,updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND organization_id=? AND integration_id=?`,
  )
    .bind(state, error, d.id, d.organizationId, d.integrationId)
    .run();
}

/**
 * A redelivered queue message for a delivery already sent is acknowledged without a second
 * provider call. This narrows, but cannot close, the at-least-once window: a crash between
 * the provider accepting and this row being written still duplicates.
 */
async function alreadySent(env: Bindings, d: DeliveryMessage): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT state FROM deliveries WHERE id=? AND organization_id=? AND integration_id=?',
  )
    .bind(d.id, d.organizationId, d.integrationId)
    .first<{ state: string }>();
  return row?.state === 'sent';
}

/**
 * Only codes we minted reach `last_error`. Platform errors (fetch, redirect) can echo the
 * destination URL in their message, so they collapse to one opaque code.
 */
export function transientCode(e: unknown): string {
  return e instanceof Error && /^provider_[a-z0-9_]+$/.test(e.message) ? e.message : 'transient_error';
}

export async function consumeDeliveries(batch: MessageBatch<unknown>, env: Bindings): Promise<void> {
  let keyring: Keyring;
  try {
    keyring = keyringFromEnv(env);
  } catch {
    // Misconfigured keys: nothing in this batch can be delivered, and nothing is lost.
    // /health reports which binding is wrong.
    batch.retryAll();
    return;
  }
  for (const msg of batch.messages) {
    const d = parseDeliveryMessage(msg.body);
    if (!d) {
      // Not a message we wrote. Nothing to record against; drop it rather than loop.
      msg.ack();
      continue;
    }
    try {
      if (await alreadySent(env, d)) {
        msg.ack();
        continue;
      }
      await deliver(env, keyring, d);
      await record(env, d, 'sent', null);
      msg.ack();
    } catch (e) {
      if (e instanceof PermanentFailure) {
        await record(env, d, 'failed', e.message);
        msg.ack();
        continue;
      }
      // NOTE (D11): transient failures are not yet classified per provider; slice 4 adds the
      // taxonomy, bounded backoff and dead-letter surfacing (F179/F180). Only codes we
      // minted reach `last_error` — never a URL or a provider body.
      await record(env, d, 'retrying', transientCode(e));
      msg.retry();
    }
  }
}
