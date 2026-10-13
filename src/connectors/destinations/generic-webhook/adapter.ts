import { JSON_HEADERS, type DestinationAdapter } from '../adapter';
import { capabilitiesFor } from '../capabilities';
import { validateConfigFor, type GenericWebhookDestinationConfig } from '../config';
import { SECRET_PREFIX, fromBase64 } from '../../sources/generic/encoding';
import { isValidWebhookId, sign } from '../../sources/generic/signature';
import type { DeliveryMeta, OutboundRequest } from '../types';
import { classifyGenericWebhookResponse } from './classify';
import { renderGenericWebhook } from './render';

/**
 * Standard Webhooks, producer side (spec 09 F116; standard-webhooks/standard-webhooks
 * spec/standard-webhooks.md). The verifier in `connectors/sources/generic/signature.ts` is
 * the other half of this recipe, and `sign` is shared, so what we send is what we verify.
 *
 *   webhook-id         the delivery id: STABLE across our own retries, for the receiver's dedup
 *   webhook-timestamp  unix seconds of THIS attempt (a retry is signed afresh)
 *   webhook-signature  `v1,` + base64 HMAC-SHA256 over `${id}.${timestamp}.${body}`
 *
 * A request is never sent unsigned: a missing or malformed secret or delivery id throws, and
 * the consumer records an `internal_error` for the attempt instead of sending anything.
 * Customers cannot add headers (a customer-supplied header is a header-injection vector).
 */

export const USER_AGENT = 'Lumi-Noti-Webhooks/1';
// The catalog's event types look like `workflow_run.failure`; anything else is not forwarded.
const EVENT_TYPE_HEADER = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function secretKey(secret: string): Uint8Array<ArrayBuffer> {
  const key = secret.startsWith(SECRET_PREFIX) ? fromBase64(secret.slice(SECRET_PREFIX.length)) : null;
  if (!key || key.length < 32) throw new Error('signing_secret_invalid');
  return key;
}

function requireMeta(meta: DeliveryMeta | undefined): DeliveryMeta {
  if (!meta || !isValidWebhookId(meta.deliveryId)) throw new Error('delivery_id_invalid');
  return meta;
}

export const genericWebhookAdapter: DestinationAdapter<GenericWebhookDestinationConfig> = {
  kind: 'generic_webhook',
  adapterVersion: '1',
  capabilities: () => capabilitiesFor('generic_webhook'),
  validateConfig: (raw) => validateConfigFor('generic_webhook', raw),
  render: renderGenericWebhook,
  buildRequest: async (message, config, now, meta): Promise<OutboundRequest> => {
    const key = secretKey(config.signingSecret);
    const { deliveryId, organizationId } = requireMeta(meta);
    const body = JSON.stringify({
      version: message.payload.version,
      type: message.payload.type,
      id: deliveryId,
      time: new Date(now).toISOString(),
      workspaceId: organizationId,
      notification: message.payload.notification,
    });
    const timestamp = String(Math.floor(now / 1000));
    const signature = await sign(key, deliveryId, timestamp, new TextEncoder().encode(body));
    const eventType = (message.payload.notification as { eventType?: unknown }).eventType;
    return {
      kind: 'generic_webhook',
      url: config.webhookUrl,
      method: 'POST',
      headers: {
        ...JSON_HEADERS,
        'user-agent': USER_AGENT,
        'webhook-id': deliveryId,
        'webhook-timestamp': timestamp,
        'webhook-signature': signature,
        'x-noti-delivery-id': deliveryId,
        ...(typeof eventType === 'string' && EVENT_TYPE_HEADER.test(eventType)
          ? { 'x-noti-event-type': eventType }
          : {}),
      },
      body,
    };
  },
  classifyResponse: classifyGenericWebhookResponse,
};
