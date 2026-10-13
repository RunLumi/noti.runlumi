/**
 * The provider-source connector contract (spec 06, ADR 0015). The route is generic; every
 * provider-specific fact lives behind this interface:
 *
 *  - how a request is authenticated (`verify`, over the RAW bytes, before any parsing),
 *  - how a verified event becomes the canonical display fields (`map`, a pure function),
 *  - the closed catalogue of event types an integration can select,
 *  - what a person must paste to connect it (`parseSecret`).
 *
 * The generic Standard Webhooks source keeps its own route (ADR 0012) and is not part of this
 * registry; Sentry is deliberately absent (ADR 0015, spec 06 F89).
 */
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
  /** The opened secret, exactly as pasted. Never logged. */
  readonly secret: string;
  readonly authMode: AuthMode | null;
  readonly headers: Headers;
  readonly raw: Uint8Array;
  readonly nowSeconds: number;
}

export type VerifyResult =
  { readonly ok: true; readonly eventId: string | null } | { readonly ok: false; readonly reason: string };

/** The canonical display fields of a notification; a subset of `DeliveryMessage` (src/env.ts). */
export interface Display {
  readonly title: string;
  readonly url: string;
  readonly repo?: string;
  readonly actor?: string;
  readonly status?: 'success' | 'failure' | 'warning' | 'info';
  readonly eventType?: string;
  readonly summary?: string;
}

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

export interface SourceConnector {
  readonly kind: ProviderKind;
  /** Display name, used in logs and guidance only. */
  readonly label: string;
  readonly maxBodyBytes: number;
  /**
   * What to do when the per-source flood limit is hit. `retry` answers 429 with Retry-After (the
   * provider re-sends); `absorb` answers 2xx and drops the event, because the provider counts any
   * 4xx as a failed delivery and disables the webhook after repeated failures (GitLab).
   */
  readonly onFlood: 'retry' | 'absorb';
  /** The closed set of event types this provider can produce, selectable on an integration. */
  readonly eventCatalog: readonly string[];
  parseSecret(body: Record<string, unknown>, mode: 'create' | 'rotate'): SecretInput;
  verify(input: VerifyInput): Promise<VerifyResult>;
  map(input: MapInput): MapResult;
  /** A secret that verifies nothing, for the best-effort timing parity of dead endpoints. */
  readonly decoy: { readonly secret: string; readonly authMode: AuthMode | null };
}
