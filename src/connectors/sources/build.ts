import { canonicalFromDisplay, type CanonicalEvent } from '../../events/canonical';
import type { GenericEvent } from './generic/event';
import { toCanonicalEvent } from './generic/event';
import type { GithubEventType } from './github/catalog';
import { mapGithubEvent } from './github/map';
import { connectorFor } from './registry';
import type { Display, ProviderKind } from './types';

/**
 * The ONE place a verified, mapped event becomes a canonical event. Every ingress route calls it
 * and so does the test harness (tests/conformance/normalize.ts), so a golden covers exactly what
 * the route builds: id, source, type, severity and facts included.
 *
 * `id` is the provider's id, already bounded (`boundedEventId`, src/events/id.ts). Pure: no clock,
 * no I/O, no randomness.
 */
export type BuildInput =
  | {
      readonly provider: 'github';
      readonly kind: string;
      readonly event: Record<string, unknown>;
      readonly eventType: GithubEventType;
      readonly id: string;
    }
  | { readonly provider: 'generic'; readonly event: GenericEvent; readonly id: string }
  | { readonly provider: ProviderKind; readonly display: Display; readonly id: string };

export function buildCanonical(input: BuildInput): CanonicalEvent {
  switch (input.provider) {
    case 'github':
      return mapGithubEvent({
        kind: input.kind,
        event: input.event,
        eventType: input.eventType,
        deliveryId: input.id,
      });
    case 'generic':
      return toCanonicalEvent(input.event, input.id);
    default: {
      const connector = connectorFor(input.provider);
      return canonicalFromDisplay({
        provider: input.provider,
        adapterVersion: connector.adapterVersion,
        id: input.id,
        source: connector.canonicalSource(input.display),
        display: input.display,
      });
    }
  }
}
