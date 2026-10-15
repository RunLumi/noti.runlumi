import type { SourceContract } from '../types';
import { GENERIC_ADAPTER_VERSION } from './event';
import { TIMESTAMP_TOLERANCE_SECONDS } from './signature';

/**
 * The static contract of the generic Standard Webhooks source (ADR 0012), checked by the shared
 * conformance suite like every connector's. The generic route is not yet driven by a connector
 * object (ADR 0057): it has no catalogue, no pasted credential and its own reuse detection, so its
 * steps stay in `route.ts`. These values must equal what that route enforces; the conformance
 * suite runs the route against them.
 */
export const GENERIC_MAX_BODY_BYTES = 256 * 1024;

export const genericContract: SourceContract<'generic'> = {
  kind: 'generic',
  label: 'Generic webhook',
  adapterVersion: GENERIC_ADAPTER_VERSION,
  maxBodyBytes: GENERIC_MAX_BODY_BYTES,
  eventCatalog: null,
  tenantResolution: 'endpoint',
  credentialScope: 'source',
  replayWindowSeconds: TIMESTAMP_TOLERANCE_SECONDS,
  idempotencyKey: 'webhook-id (signed)',
  // No "ignored" outcome: every verified, valid envelope is delivered.
  ack: { onFlood: 'reject', providerRetries: null, ignored: null },
};
