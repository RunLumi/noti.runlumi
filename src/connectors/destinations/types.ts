/**
 * Shared types for the destination adapter contract (docs/specs/07-destination-capabilities.md,
 * F91–F104). Everything here is data: no I/O, no clock, no hidden state.
 */

export const DESTINATION_KINDS = ['lark', 'slack', 'teams'] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];

export type NotificationStatus = 'success' | 'failure' | 'warning' | 'info';

/**
 * The canonical, destination-independent notification. Every string field is untrusted
 * provider input (a PR title, a branch name, a commit message) and is escaped or
 * neutralised per destination before it is placed in a payload (F94).
 */
export interface CanonicalNotification {
  readonly title: string;
  readonly eventType: string;
  readonly url?: string;
  readonly repo?: string;
  readonly actor?: string;
  readonly status?: NotificationStatus;
  readonly summary?: string;
  /** Visible label for the source link. Defaults to a neutral "Open in source". */
  readonly linkLabel?: string;
}

/** The rungs of the degradation ladder, richest first (F93). */
export type RenderFormat = 'card' | 'markdown' | 'plain';

/** Markup dialect used for free text inside a destination payload. */
export type MarkupDialect = 'slack_mrkdwn' | 'lark_md' | 'adaptive_card_md' | 'plain';

/**
 * What a provider's 2xx actually proves (F99/F100). Teams Workflows returns 202 with no
 * read-back, so it can only ever be `accepted`, never `delivered`.
 */
export type SuccessSemantics = 'delivered' | 'accepted';

export type SigningScheme = 'none' | 'lark_hmac_sha256';

export interface DestinationCapabilities {
  readonly kind: DestinationKind;
  readonly mode: string;
  /** Ladder rungs this destination can render, richest first. */
  readonly formats: readonly RenderFormat[];
  readonly markdownDialect: MarkupDialect;
  readonly maxBodyBytes: number;
  readonly maxTitleChars: number;
  readonly maxTextChars: number;
  readonly supportsLinks: boolean;
  readonly signing: SigningScheme;
  readonly successSemantics: SuccessSemantics;
  readonly canUpdate: boolean;
  readonly canDelete: boolean;
  readonly canReply: boolean;
  readonly supportsInteractive: boolean;
  readonly supportsCallbacks: boolean;
  readonly canCustomizeIdentity: boolean;
  readonly supportsServerSideIdempotency: boolean;
  readonly supportsThreads: boolean;
  readonly supportsMentions: boolean;
  readonly requiresCustomerOwnedCredential: boolean;
  /** Free-text fields are masked for contact details before render (Lark DLP, F102). */
  readonly redactsContactDetails: boolean;
}

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type RenderedField = 'title' | 'meta' | 'summary' | 'link' | 'text';

export interface RenderedMessage {
  readonly kind: DestinationKind;
  readonly format: RenderFormat;
  readonly payload: JsonObject;
  readonly bytes: number;
  /** Rungs that were tried first and did not fit, in order. Empty when the first rung fit. */
  readonly degradedFrom: readonly RenderFormat[];
  readonly truncatedFields: readonly RenderedField[];
  readonly redactedFields: readonly RenderedField[];
}

export type RenderFailureReason = 'payload_too_large' | 'render_failed';

export type RenderResult =
  | { readonly ok: true; readonly message: RenderedMessage }
  | { readonly ok: false; readonly reason: RenderFailureReason };

/** A fully prepared HTTP request. The URL is a bearer secret: never log it. */
export interface OutboundRequest {
  readonly kind: DestinationKind;
  readonly url: string;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** The subset of a fetch `Response` that classifiers need. `Headers` satisfies it. */
export interface HeaderReader {
  get(name: string): string | null;
}

export interface ProviderResponse {
  readonly status: number;
  readonly headers: HeaderReader;
  /** At most a short prefix of the body; classifiers never echo it. */
  readonly bodyText: string;
}

export type DeliveryOutcome = 'delivered' | 'accepted' | 'retryable' | 'permanent';

/**
 * Closed reason taxonomy. Names overlap F13 (docs/specs/01-platform-runtime.md) where the
 * meaning is identical; the remainder are destination-specific refinements.
 */
export const DELIVERY_REASONS = [
  'ok',
  'destination_rate_limited',
  'destination_unavailable',
  'destination_timeout',
  'network_error',
  'destination_revoked',
  'destination_redirected',
  'destination_unauthorized',
  'destination_policy_blocked',
  'content_policy_blocked',
  'signature_rejected',
  'payload_rejected',
  'payload_too_large',
  'destination_url_rejected',
  'unmapped_response',
  'internal_error',
] as const;
export type DeliveryReason = (typeof DELIVERY_REASONS)[number];

export interface ClassifiedResponse {
  readonly outcome: DeliveryOutcome;
  readonly reason: DeliveryReason;
  /** From `Retry-After` (or a provider equivalent); overrides computed backoff (F99). */
  readonly retryAfterMs?: number;
  /** A short provider code taken only from our own known-code tables, never from free text. */
  readonly providerCode?: string;
  /** Set when no mapping matched, so the caller can raise a metric (F13). */
  readonly unmapped?: true;
}
