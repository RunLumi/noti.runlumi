import type { ConfigValidation, ValidatedDestinationConfig } from './config';
import type {
  CanonicalNotification,
  ClassifiedResponse,
  DeliveryMeta,
  DestinationCapabilities,
  OutboundRequest,
  ProviderResponse,
  RenderFormat,
  RenderResult,
  RenderedMessage,
} from './types';

export interface RenderOptions {
  /** Start lower on the degradation ladder, e.g. when the customer chose plain text. */
  readonly startAt?: RenderFormat;
  /**
   * Prefix titles with the status label. Defaults to true. Only the legacy Lark helpers set
   * it to false, to keep the titles the current consumer already sends.
   */
  readonly statusInTitle?: boolean;
}

/**
 * The contract every destination implements (F91). All members are pure: `buildRequest` is
 * async only because WebCrypto signing is. Network I/O lives in `send.ts`.
 */
export interface DestinationAdapter<C extends ValidatedDestinationConfig> {
  readonly kind: C['kind'];
  readonly adapterVersion: string;
  /** Computed per configured destination, not per kind (F92). */
  capabilities(config: C): DestinationCapabilities;
  /** Write-time validation (F96); rejects input whose `kind` is not this adapter's. */
  validateConfig(raw: unknown): ConfigValidation;
  /** Pure and deterministic: no clock, no I/O, no memory of previous messages. */
  render(n: CanonicalNotification, caps: DestinationCapabilities, options?: RenderOptions): RenderResult;
  buildRequest(
    message: RenderedMessage,
    config: C,
    now: number,
    meta?: DeliveryMeta,
  ): Promise<OutboundRequest>;
  /** Total: every response maps to exactly one outcome and reason. */
  classifyResponse(res: ProviderResponse, now: number): ClassifiedResponse;
}

export const JSON_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json; charset=utf-8',
};
