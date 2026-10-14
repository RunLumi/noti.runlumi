import type { DestinationKind } from '../lib/api';

/**
 * What each destination can show, in the words a person needs before choosing one (spec 14
 * F211). These are static client facts that mirror `src/connectors/destinations/capabilities.ts`
 * (the verified matrix); `abilities.test.ts` compares every field to it, so the screen cannot
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

export const ABILITIES: Readonly<Record<DestinationKind, DestinationAbilities>> = {
  slack: {
    layout: 'card',
    links: true,
    mentions: false,
    confirmation: 'delivered',
    plainFallback: true,
    signed: false,
    redactsContactDetails: false,
  },
  teams: {
    layout: 'card',
    links: true,
    mentions: false,
    confirmation: 'accepted',
    plainFallback: true,
    signed: false,
    redactsContactDetails: false,
  },
  lark: {
    layout: 'card',
    links: true,
    mentions: false,
    confirmation: 'delivered',
    plainFallback: true,
    signed: true,
    redactsContactDetails: true,
  },
  discord: {
    layout: 'card',
    links: true,
    mentions: false,
    confirmation: 'delivered',
    plainFallback: true,
    signed: false,
    redactsContactDetails: false,
  },
  generic_webhook: {
    layout: 'json',
    links: true,
    mentions: false,
    confirmation: 'delivered',
    plainFallback: false,
    signed: true,
    redactsContactDetails: false,
  },
};
