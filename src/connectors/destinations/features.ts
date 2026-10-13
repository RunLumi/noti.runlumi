import type { DestinationKind } from './types';

/**
 * Destination kinds that are built but not available to customers until their release
 * criteria are met (ADR 0014). The flag is a deployment var, not a per-delivery toggle: it
 * gates creating, re-enabling and sending, so a stored row cannot reach the network while the
 * feature is off.
 */
export interface FeatureEnv {
  readonly GENERIC_WEBHOOK_ENABLED?: string;
}

/** Only the exact string `true` enables the custom webhook; anything else, including unset, is off. */
export function genericWebhookEnabled(env: FeatureEnv): boolean {
  return env.GENERIC_WEBHOOK_ENABLED === 'true';
}

export function destinationAvailable(kind: DestinationKind, env: FeatureEnv): boolean {
  return kind === 'generic_webhook' ? genericWebhookEnabled(env) : true;
}
