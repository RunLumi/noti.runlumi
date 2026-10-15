import type { DestinationAdapter, RenderOptions } from './adapter';
import { adapterFor, adapterOfKind } from './adapters';
import type { ValidatedDestinationConfig } from './config';
import { discordAdapter } from './discord/adapter';
import { genericWebhookAdapter } from './generic-webhook/adapter';
import { larkAdapter } from './lark/adapter';
import { sendRequest, type SendOptions } from './send';
import { slackAdapter } from './slack/adapter';
import { teamsAdapter } from './teams/adapter';
import type {
  CanonicalNotification,
  ClassifiedResponse,
  DeliveryMeta,
  DestinationCapabilities,
  DestinationKind,
  OutboundRequest,
  ProviderResponse,
  RenderFailureReason,
  RenderedMessage,
} from './types';

/**
 * Public entry points for the queue consumer. Typical use:
 *
 *   const config = validateDestinationConfig(decryptedRow);   // also at write time
 *   const prepared = await prepareDelivery(config.config, notification, { now });
 *   const result = prepared.ok
 *     ? await sendRequest(prepared.request, (res, at) => classifyDeliveryResponse(kind, res, at))
 *     : …;
 *
 * or `deliver(config, notification)` to do both.
 */

export * from './types';
export { capabilitiesFor } from './capabilities';
export { ADAPTERS, adapterFor, adapterOfKind } from './adapters';
export {
  DESTINATION_REGISTRY,
  registrationOf,
  requestedFeatureIssues,
  type DestinationRegistration,
} from './kind-registry';
export { checkDestinationUrl, larkDomainOf, type UrlRejectionRule, type UrlPolicyResult } from './url-policy';
export {
  validateDestinationConfig,
  validateConfigFor,
  type ConfigValidation,
  type ValidatedDestinationConfig,
  type SlackDestinationConfig,
  type TeamsDestinationConfig,
  type LarkDestinationConfig,
  type DiscordDestinationConfig,
  type GenericWebhookDestinationConfig,
  type TeamsTriggerAuth,
} from './config';
export { classifyTransportError } from './classify';
export { sendRequest, readBodyPrefix, type SendOptions, type Fetcher } from './send';
export type { DestinationAdapter, RenderOptions } from './adapter';
export { slackAdapter, teamsAdapter, larkAdapter, discordAdapter, genericWebhookAdapter };

export interface PrepareOptions extends RenderOptions {
  readonly now: number;
  /** Per-delivery facts for destinations whose wire format carries them (generic webhook). */
  readonly meta?: DeliveryMeta;
}

export type PreparedDelivery =
  | {
      readonly ok: true;
      readonly capabilities: DestinationCapabilities;
      readonly message: RenderedMessage;
      readonly request: OutboundRequest;
    }
  | { readonly ok: false; readonly reason: RenderFailureReason };

async function prepareWith<C extends ValidatedDestinationConfig>(
  adapter: DestinationAdapter<C>,
  config: C,
  n: CanonicalNotification,
  options: PrepareOptions,
): Promise<PreparedDelivery> {
  const capabilities = adapter.capabilities(config);
  const rendered = adapter.render(n, capabilities, options.startAt ? { startAt: options.startAt } : {});
  if (!rendered.ok) return rendered;
  const request = await adapter.buildRequest(rendered.message, config, options.now, options.meta);
  return { ok: true, capabilities, message: rendered.message, request };
}

/** Render and build the signed request for a validated destination. No network I/O. */
export function prepareDelivery(
  config: ValidatedDestinationConfig,
  n: CanonicalNotification,
  options: PrepareOptions,
): Promise<PreparedDelivery> {
  return prepareWith(adapterFor(config), config, n, options);
}

/** Map a provider response onto the closed outcome/reason taxonomy. */
export function classifyDeliveryResponse(
  kind: DestinationKind,
  res: ProviderResponse,
  now: number,
): ClassifiedResponse {
  return adapterOfKind(kind).classifyResponse(res, now);
}

export type DeliveryResult =
  | { readonly rendered: false; readonly classification: ClassifiedResponse }
  | {
      readonly rendered: true;
      readonly message: RenderedMessage;
      readonly classification: ClassifiedResponse;
    };

/** Prepare, send and classify in one call. Render failures are permanent and never sent. */
export async function deliver(
  config: ValidatedDestinationConfig,
  n: CanonicalNotification,
  options: SendOptions & RenderOptions & { readonly meta?: DeliveryMeta } = {},
): Promise<DeliveryResult> {
  const now = options.now ?? Date.now;
  const prepared = await prepareDelivery(config, n, {
    now: now(),
    ...(options.meta ? { meta: options.meta } : {}),
    ...(options.startAt ? { startAt: options.startAt } : {}),
  });
  if (!prepared.ok) {
    const reason = prepared.reason === 'payload_too_large' ? 'payload_too_large' : 'payload_rejected';
    return { rendered: false, classification: { outcome: 'permanent', reason } };
  }
  const classification = await sendRequest(
    prepared.request,
    (res, at) => classifyDeliveryResponse(config.kind, res, at),
    options,
  );
  return { rendered: true, message: prepared.message, classification };
}
