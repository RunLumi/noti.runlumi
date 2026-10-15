import { gitlabConnector } from './gitlab';
import { stripeConnector } from './stripe';
import { PROVIDER_KINDS, type EndpointSourceConnector, type ProviderKind } from './types';

/**
 * The endpoint provider connectors, by `sources.kind`. Registering a connector here is what makes
 * its route, API kind, event catalogue and setup guidance exist; there is no other switch. The
 * GitHub (installation) connector and the generic contract are listed with these in
 * `./contracts.ts`, which this module does not import so the dashboard never pulls in Worker code.
 *
 * Sentry is intentionally NOT registered (spec 06 F89, ADR 0015): its webhook signature is
 * documented as an HMAC over a re-serialised body with a non-constant-time comparison and no
 * replay window, which Noti will not implement without a captured real delivery proving the
 * raw-bytes behaviour. `tests/sources/registry.test.ts` fails if a connector named `sentry`
 * appears without that evidence being recorded.
 */
const CONNECTORS: Readonly<Record<ProviderKind, EndpointSourceConnector>> = {
  gitlab: gitlabConnector,
  stripe: stripeConnector,
};

export function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === 'string' && (PROVIDER_KINDS as readonly string[]).includes(value);
}

export function connectorFor(kind: ProviderKind): EndpointSourceConnector {
  return CONNECTORS[kind];
}

/** The event types an integration of a source of this kind may select; null for the generic kind. */
export function eventCatalogFor(kind: string): readonly string[] | null {
  return isProviderKind(kind) ? CONNECTORS[kind].eventCatalog : null;
}
