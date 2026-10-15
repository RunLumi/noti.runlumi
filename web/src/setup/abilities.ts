import { DESTINATION_KINDS, DESTINATION_REGISTRY } from '../../../src/connectors/destinations/kind-registry';
import type { DestinationCapabilities } from '../../../src/connectors/destinations/types';
import type { DestinationKind } from '../lib/api';

/**
 * What each destination can show, in the words a person needs before choosing one (spec 14
 * F211). They are derived from the registry's capabilities (`src/connectors/destinations/kind-registry.ts`,
 * the verified matrix); `setup.test.ts` still compares every field to it, so the screen cannot
 * drift into promising something an adapter does not do. Describes what Noti's adapter sends,
 * not everything the provider could do (Noti sends no @mentions and no buttons).
 */
export interface DestinationAbilities {
  /** `card`: a formatted message with title and fields; `json`: a structured JSON body. */
  readonly layout: 'card' | 'json';
  /** The message links back to the source (the pull request, the workflow run). */
  readonly links: boolean;
  /** Noti can @mention people. Off everywhere: untrusted text must not ping someone. */
  readonly mentions: boolean;
  /** `delivered`: the destination confirms it got it. `accepted`: it accepts, and says no more. */
  readonly confirmation: 'delivered' | 'accepted';
  /** A plainer text message is used when the card cannot be shown. */
  readonly plainFallback: boolean;
  /** The request is signed so the receiver can verify it came from Noti. */
  readonly signed: boolean;
  /** The destination hides phone numbers and personal emails in messages. */
  readonly redactsContactDetails: boolean;
}

/** The person-facing reading of one mode's capabilities. Pure; no fact is restated here. */
export function abilitiesOf(caps: DestinationCapabilities): DestinationAbilities {
  return {
    layout: caps.mode === 'signed_https' ? 'json' : 'card',
    links: caps.supportsLinks,
    mentions: caps.supportsMentions,
    confirmation: caps.successSemantics,
    plainFallback: caps.formats.includes('plain'),
    signed: caps.signing !== 'none',
    redactsContactDetails: caps.redactsContactDetails,
  };
}

/** Read from the registry (F105, ADR 0052), so the summary and `docs/CAPABILITIES.md` agree. */
export const ABILITIES: Readonly<Record<DestinationKind, DestinationAbilities>> = Object.fromEntries(
  DESTINATION_KINDS.map((kind) => [kind, abilitiesOf(DESTINATION_REGISTRY[kind].capabilities)]),
) as Record<DestinationKind, DestinationAbilities>;
