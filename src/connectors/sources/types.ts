/**
 * The source connector contract (spec 05 F71, spec 06, ADR 0015, ADR 0057). ONE typed interface,
 * `SourceConnector`, covers every source that has a connector; every provider-specific fact lives
 * behind it and the routes only sequence the steps:
 *
 *  - `verify`: authentication over the RAW bytes and headers, before anything is parsed. It is the
 *    only member that reads the credential, and it returns the identity the verified transport
 *    carries, when it has one;
 *  - classification and mapping: a verified body becomes the canonical display fields or a
 *    canonical event, through pure functions;
 *  - the dedup identity (`idempotencyKey`; the route hashes it, tenant-bound, into the key);
 *  - the acknowledgement policy (`ack`);
 *  - the static facts the conformance suite checks (`SourceContract`).
 *
 * Two variants, discriminated by `tenantResolution`, because the tenant comes from two different
 * authenticated things and pretending otherwise would push the difference back into a route:
 *
 *  - `endpoint` (GitLab, Stripe): a per-source credential sealed on the source row that the public
 *    endpoint id selects. The row is the tenant, known before verification.
 *  - `installation` (GitHub): ONE App-wide credential from the deployment, which every installation
 *    of the App shares, so the signature identifies no tenant. The tenant is the installation in
 *    the VERIFIED body, looked up scoped to our App id, after verification. Pings and installation
 *    lifecycle events are classified explicitly: they acknowledge or change state, never route.
 *
 * This module holds the contract and the endpoint variant and has no Worker-only types, because the
 * dashboard imports the provider registry (credential checks). The installation variant and the
 * `SourceConnector` union need D1 and live in `./connector.ts`.
 *
 * The generic Standard Webhooks source declares a `SourceContract` (generic/contract.ts) and keeps
 * its own route (ADR 0012); Sentry is deliberately absent (ADR 0015, spec 06 F89).
 */
import type { DisplayFields } from '../../events/canonical';
import type { SourceId } from '../../events/catalog';

export const PROVIDER_KINDS = ['gitlab', 'stripe'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export type AuthMode = 'signing_token' | 'secret_token';

export interface FieldError {
  readonly field: string;
  readonly message: string;
}

/** What a person pasted when creating or rotating a source, validated and normalised. */
export type SecretInput =
  | {
      readonly ok: true;
      readonly secret: string;
      readonly authMode: AuthMode | null;
      readonly livemode: boolean | null;
    }
  | { readonly ok: false; readonly errors: readonly FieldError[] };

export interface VerifyInput {
  /** The opened secret, exactly as pasted (or the App secret). Never logged. */
  readonly secret: string;
  readonly authMode: AuthMode | null;
  readonly headers: Headers;
  readonly raw: Uint8Array;
  readonly nowSeconds: number;
}

export type VerifyResult =
  { readonly ok: true; readonly eventId: string | null } | { readonly ok: false; readonly reason: string };

/**
 * The canonical display fields of a notification; a subset of `DeliveryMessage` (src/env.ts),
 * derived from a canonical event (src/events/canonical.ts) on the delivery path.
 */
export type Display = DisplayFields;

export interface MapInput {
  readonly headers: Headers;
  /** Parsed only after verification succeeded. */
  readonly body: unknown;
  readonly source: { readonly livemode: boolean | null };
}

export type MapResult =
  /** Route it. `eventId` is the provider's own id when the body carries it (Stripe `evt_`). */
  | { readonly outcome: 'deliver'; readonly display: Display; readonly eventId?: string }
  /** A verified event Noti does not notify about. Acknowledged (2xx) so the provider is not told it failed. */
  | { readonly outcome: 'ignore'; readonly reason: string }
  /** A verified request that is not a usable event of this provider. */
  | { readonly outcome: 'reject'; readonly status: 400 | 401; readonly reason: string };

/**
 * How a source answers where sources differ (spec 05 F50, F64; ADR 0015 decision 2). The rest is
 * uniform and therefore not declared per connector: `202` only after the durable write, `200` for
 * an exact duplicate, `401` for anything unauthenticated.
 */
export interface AckPolicy {
  /**
   * The per-source (or per-installation) flood limit, which runs only after authentication.
   * `reject` answers 429 with Retry-After. `absorb` answers 2xx and drops the event, because the
   * provider counts any 4xx as a failed delivery and disables the webhook after repeated failures
   * (GitLab, spec 06 F82).
   */
  readonly onFlood: 'reject' | 'absorb';
  /**
   * Whether the provider re-sends a non-2xx on its own. `false` (GitHub: manual redelivery only)
   * means a refusal after authentication is lost unless someone redelivers it; `null` means the
   * sender decides (the generic source).
   */
  readonly providerRetries: boolean | null;
  /** Status of a verified event outside what Noti notifies about; null when the source has no such outcome. */
  readonly ignored: 200 | 202 | null;
}

/** The static facts every source declares, read by the conformance suite (tests/conformance). */
export interface SourceContract<K extends SourceId = SourceId> {
  readonly kind: K;
  /** Display name, used in logs and guidance only. */
  readonly label: string;
  /** Semver of the mapping; recorded on every canonical event (spec 04 F54). */
  readonly adapterVersion: string;
  /** Hard cap on an inbound body, in bytes: 413 above it, without reading further. */
  readonly maxBodyBytes: number;
  /** The closed set of event types this source can produce, or null (generic: a label, never routable). */
  readonly eventCatalog: readonly string[] | null;
  /**
   * Where the tenant comes from. `endpoint`: the source row an unguessable endpoint id selects.
   * `installation`: the verified GitHub App installation in the signed body.
   */
  readonly tenantResolution: 'endpoint' | 'installation';
  /** Where the verifying credential lives: sealed on the source row, or one per deployment (the App). */
  readonly credentialScope: 'source' | 'app';
  /**
   * Seconds either side of now a signed timestamp is accepted, or null when the protocol signs none
   * (replay is then absorbed by idempotency). GitLab: the signing-token mode's window; its weaker
   * secret-token mode has none (ADR 0015 decision 3).
   */
  readonly replayWindowSeconds: number | null;
  /** Where the provider's own event identity comes from (spec 04 F47). Never a signature or timestamp. */
  readonly idempotencyKey: string;
  readonly ack: AckPolicy;
}

/** What every connector implements, whatever its tenant model. */
export interface ConnectorCore<K extends SourceId> extends SourceContract<K> {
  readonly eventCatalog: readonly string[];
  /**
   * Authenticate over the RAW bytes and headers, before any parsing. The only member that reads the
   * credential (spec 05 F71). `eventId` is the identity the verified transport carries, or null.
   */
  verify(input: VerifyInput): Promise<VerifyResult>;
}

/** A source whose tenant and credential are the source row a public endpoint id selects (ADR 0015). */
export interface EndpointSourceConnector extends ConnectorCore<ProviderKind> {
  readonly tenantResolution: 'endpoint';
  readonly credentialScope: 'source';
  /** The CloudEvents `source` of a mapped event: an identifier, never a secret or a tenant. */
  canonicalSource(display: Display): string;
  parseSecret(body: Record<string, unknown>, mode: 'create' | 'rotate'): SecretInput;
  /** Classify and map a verified body in one pure step (the catalogue decision reads body fields). */
  map(input: MapInput): MapResult;
  /** A secret that verifies nothing, for the best-effort timing parity of dead endpoints. */
  readonly decoy: { readonly secret: string; readonly authMode: AuthMode | null };
}
