import { GITHUB_EVENT_TYPES } from '../../src/connectors/sources/github/catalog';
import { GITHUB_ADAPTER_VERSION } from '../../src/connectors/sources/github/map';
import { MAX_BODY_BYTES as GITHUB_MAX_BODY_BYTES } from '../../src/connectors/sources/github/route';
import { GENERIC_ADAPTER_VERSION } from '../../src/connectors/sources/generic/event';
import { MAX_BODY_BYTES as GENERIC_MAX_BODY_BYTES } from '../../src/connectors/sources/generic/route';
import { TIMESTAMP_TOLERANCE_SECONDS } from '../../src/connectors/sources/generic/signature';
import { connectorFor } from '../../src/connectors/sources/registry';
import { STRIPE_TOLERANCE_SECONDS } from '../../src/connectors/sources/stripe/verify';
import { PROVIDER_KINDS } from '../../src/connectors/sources/types';
import type { SourceId } from '../../src/events/catalog';

/**
 * The connector contract every source satisfies (spec 05 F71, spec 06 F8x), stated as data so one
 * conformance suite (tests/conformance) can run against ALL of them, including the two that have
 * their own routes (GitHub, generic) and are not in the provider registry (ADR 0012, ADR 0015).
 *
 * What a source must do, regardless of provider:
 *  1. verify before parse: authentication runs over the RAW bytes; nothing is parsed, mapped or
 *     routed from an unauthenticated request;
 *  2. cap the body at `maxBodyBytes` and answer 413 without reading further;
 *  3. enforce the protocol's replay window where it has one (`replayWindowSeconds`), and be
 *     idempotent on the provider's own id where it has none;
 *  4. resolve the tenant from something it authenticated (an endpoint id or a verified
 *     installation), with ONE response for every unknown/foreign/disabled case;
 *  5. map a verified event to a canonical event with a pure, deterministic function that carries
 *     no payload body and no personal data, and stays within the canonical bounds;
 *  6. produce only event types from its closed catalogue (generic: a sender label, never routable).
 *
 * The `verify` and `map` members of the provider connectors (`SourceConnector`, ./types.ts) are
 * the typed form of 1 and 5 for the provider registry; this descriptor is the cross-cutting view.
 */
export interface SourceDescriptor {
  readonly kind: SourceId;
  readonly label: string;
  readonly adapterVersion: string;
  /** Hard cap on an inbound body, in bytes. */
  readonly maxBodyBytes: number;
  /** `endpoint`: the tenant is the source row an unguessable endpoint id selects. `installation`: the verified GitHub installation. */
  readonly tenantResolution: 'endpoint' | 'installation';
  /** Seconds either side of now a signed timestamp is accepted, or null when the protocol has none. */
  readonly replayWindowSeconds: number | null;
  /** Where the provider's own event identity comes from (spec 04 F47). Never a signature or timestamp. */
  readonly idempotencyKey: string;
  /** The closed catalogue, or null for the generic source (a label, not a routing key). */
  readonly eventCatalog: readonly string[] | null;
}

const PROVIDER_DETAILS: Readonly<
  Record<(typeof PROVIDER_KINDS)[number], Pick<SourceDescriptor, 'replayWindowSeconds' | 'idempotencyKey'>>
> = {
  // Signing-token mode follows Standard Webhooks; the secret-token mode has no timestamp.
  gitlab: {
    replayWindowSeconds: TIMESTAMP_TOLERANCE_SECONDS,
    idempotencyKey: 'webhook-id (signed), else Idempotency-Key, else body hash',
  },
  stripe: { replayWindowSeconds: STRIPE_TOLERANCE_SECONDS, idempotencyKey: 'event id in the body' },
};

export const SOURCE_DESCRIPTORS: readonly SourceDescriptor[] = [
  {
    kind: 'github',
    label: 'GitHub',
    adapterVersion: GITHUB_ADAPTER_VERSION,
    maxBodyBytes: GITHUB_MAX_BODY_BYTES,
    tenantResolution: 'installation',
    // GitHub's signature carries no timestamp (docs: X-Hub-Signature-256 only), so replay is
    // absorbed by idempotency on X-GitHub-Delivery, which a manual redelivery keeps.
    replayWindowSeconds: null,
    idempotencyKey: 'X-GitHub-Delivery',
    eventCatalog: GITHUB_EVENT_TYPES,
  },
  {
    kind: 'generic',
    label: 'Generic webhook',
    adapterVersion: GENERIC_ADAPTER_VERSION,
    maxBodyBytes: GENERIC_MAX_BODY_BYTES,
    tenantResolution: 'endpoint',
    replayWindowSeconds: TIMESTAMP_TOLERANCE_SECONDS,
    idempotencyKey: 'webhook-id (signed)',
    eventCatalog: null,
  },
  ...PROVIDER_KINDS.map((kind): SourceDescriptor => {
    const connector = connectorFor(kind);
    return {
      kind,
      label: connector.label,
      adapterVersion: connector.adapterVersion,
      maxBodyBytes: connector.maxBodyBytes,
      tenantResolution: 'endpoint',
      eventCatalog: connector.eventCatalog,
      ...PROVIDER_DETAILS[kind],
    };
  }),
];
