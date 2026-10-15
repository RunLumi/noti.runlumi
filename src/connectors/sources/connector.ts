/**
 * The `SourceConnector` union and its installation variant (spec 05 F71, ADR 0057). The contract,
 * the shared core and the endpoint variant are in `./types.ts`, which stays free of Worker-only
 * types for the dashboard; this module is Worker-only (D1).
 *
 * The installation variant exists because GitHub's tenant model does not fit an endpoint: the
 * webhook secret is App-wide, so a valid signature proves only that SOME installation of our App
 * sent the request. The tenant is the installation block inside the verified bytes, looked up
 * scoped to our App id, and pings and installation lifecycle events are first-class
 * classifications rather than branches a route has to know about.
 */
import type { Bindings } from '../../env';
import type { CanonicalEvent } from '../../events/canonical';
import type { GithubEventType } from './github/catalog';
import type { LifecycleOutcome } from './github/lifecycle';
import type { TenantResolution } from './github/tenant';
import type { ConnectorCore, EndpointSourceConnector } from './types';

/**
 * What a verified, parsed App delivery is, decided from its headers and body before any tenant
 * lookup. Pure. `invalid` is a delivery that cannot be classified or routed: no event header, or a
 * routable event without a repository or a delivery id.
 */
export type InstallationClassification =
  | { readonly kind: 'invalid' }
  /** The App's configuration ping: carries no installation, routes nothing, acknowledged. */
  | { readonly kind: 'ping' }
  /** Installation lifecycle (F68): changes installation state, never routes a notification. */
  | { readonly kind: 'lifecycle'; readonly name: string }
  | {
      readonly kind: 'event';
      /** The `X-GitHub-Event` header value. */
      readonly name: string;
      /** The catalogue type, or null outside the closed catalogue (acknowledged, routes nothing). */
      readonly eventType: GithubEventType | null;
      /** `repository.full_name`: narrows within the tenant, never authorization. */
      readonly repo: string;
      /** `repository.id`, checked against a restricted installation's scope (F67). */
      readonly repositoryId: unknown;
      /**
       * `X-GitHub-Delivery`, the dedup identity. It is outside the signature, so it is only ever
       * used bound to the verified installation and organization.
       */
      readonly deliveryId: string;
    };

/** A source whose credential is App-wide and whose tenant is the verified installation (GitHub). */
export interface InstallationSourceConnector extends ConnectorCore<'github'> {
  readonly tenantResolution: 'installation';
  readonly credentialScope: 'app';
  /** The App credential and id from the deployment; null when the webhook secret is not configured (503). */
  appCredential(
    env: Pick<Bindings, 'GITHUB_WEBHOOK_SECRET' | 'GITHUB_APP_ID'>,
  ): { readonly secret: string; readonly appId: string } | null;
  classify(headers: Headers, body: Record<string, unknown>): InstallationClassification;
  /** Apply an installation lifecycle event: audited, routes nothing, throws on a storage fault. */
  applyLifecycle(
    db: D1Database,
    appId: string,
    name: string,
    body: Record<string, unknown>,
  ): Promise<LifecycleOutcome>;
  /**
   * The App-scoped tenant lookup: the installation block of the VERIFIED body, looked up with our
   * App id. Every outcome other than `ok` is a refusal; there is no fallback.
   */
  resolveTenant(db: D1Database, appId: string, body: Record<string, unknown>): Promise<TenantResolution>;
  /** Repository scope of a restricted installation (F67), checked after the tenant resolved. */
  repositoryInScope(
    db: D1Database,
    appId: string,
    installationId: string,
    repositoryId: unknown,
  ): Promise<boolean>;
  /** Map a verified, classified event to the canonical event. Pure. */
  map(input: {
    readonly name: string;
    readonly body: Record<string, unknown>;
    readonly eventType: GithubEventType;
    readonly id: string;
  }): CanonicalEvent;
}

/** The one connector interface (spec 05 F71); narrow it on `tenantResolution`. */
export type SourceConnector = EndpointSourceConnector | InstallationSourceConnector;
