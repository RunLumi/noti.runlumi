import { DESTINATION_REGISTRY, type DestinationKind } from './kind-registry';

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

/** Reads the kind's registered availability (F105): ungated kinds are always available. */
export function destinationAvailable(kind: DestinationKind, env: FeatureEnv): boolean {
  const availability = DESTINATION_REGISTRY[kind].availability;
  return availability.gate === 'none' || env[availability.variable] === 'true';
}
