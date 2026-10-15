import type { DestinationCapabilities, RenderFormat } from './types';

/**
 * F105: the one typed registry of destination kinds (ADR 0052). Pure data, no adapter code, so
 * the dashboard can import it without bundling the renderers or the signing code. The adapters
 * are bound to these kinds in `adapters.ts`; the hosts each kind may be sent to live in
 * `provider-registry.ts` (F229), which is a different registry with its own review rule.
 *
 * What reads this file: `capabilitiesFor` (and so every adapter), `validateDestinationConfig`,
 * the integrations API (kind parsing, signing-secret rules, save-time feature checks), the
 * consumer's availability gate, the dashboard picker and capability summary, and the generator
 * of `docs/CAPABILITIES.md` (`npm run docs:capabilities`).
 *
 * Capabilities describe what THIS codebase's adapter for the mode does, not what the provider
 * could do (F93: reporting the provider's ability would be a fake capability). Provider limits
 * carry a pointer into `docs/DESTINATION_API_REFERENCE.md` and a short excerpt that must appear
 * verbatim in that section; `tests/destinations/kind-registry.test.ts` checks both. A limit the
 * reference does not state has `basis: 'ours'` or `'not_stated'` and no source, never a guess.
 */

/** Every destination kind, in the order the dashboard offers them. Adding one here forces a registry entry. */
export const DESTINATION_KINDS = ['lark', 'slack', 'teams', 'discord', 'generic_webhook'] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];

export function isDestinationKind(value: unknown): value is DestinationKind {
  return typeof value === 'string' && (DESTINATION_KINDS as readonly string[]).includes(value);
}

/** A section of `docs/DESTINATION_API_REFERENCE.md` (its heading number) and an excerpt from it. */
export interface ReferenceSource {
  /** Heading number, e.g. `2.2` for `### 2.2 …` or `4` for `## 4. …`. */
  readonly section: string;
  /** Copied verbatim from that section, so a reviewer can find the sentence. */
  readonly excerpt: string;
}

/**
 * - `provider`: the reference states the number.
 * - `derived`: computed from a provider number the reference states (the note says how).
 * - `ours`: a Noti product budget; the provider has no such limit to respect.
 * - `not_stated`: Noti enforces a value the reference does not state. Must be checked.
 */
export type LimitBasis = 'provider' | 'derived' | 'ours' | 'not_stated';

export interface DestinationLimit {
  /** Stable id; also the label key in the generated page. */
  readonly id: string;
  readonly label: string;
  readonly value: number | string;
  readonly unit: 'bytes' | 'characters' | 'items' | 'text';
  /** The capability field that enforces this limit, when one does. Its value must equal `value`. */
  readonly enforcedAs?: 'maxBodyBytes' | 'maxTitleChars' | 'maxTextChars';
  readonly basis: LimitBasis;
  /** Required for `provider` and `derived`; absent for `ours` and `not_stated`. */
  readonly source?: ReferenceSource;
  readonly note?: string;
}

/** Something the reference marks unknown or unverified that a customer choosing this kind should see. */
export interface OpenQuestion {
  readonly text: string;
  readonly source: ReferenceSource;
}

/**
 * Whether the kind can be chosen. `deployment_flag` kinds are built but stay unavailable until
 * their release criteria are met (ADR 0014); the flag gates create, re-enable and send.
 */
export type Availability =
  | { readonly gate: 'none' }
  | { readonly gate: 'deployment_flag'; readonly variable: 'GENERIC_WEBHOOK_ENABLED' };

/**
 * Who supplies the signing secret. `customer_optional`: the person may paste the provider's
 * secret (Lark). `noti_generated`: Noti generates it and shows it once (custom webhook).
 */
export type SigningSecretInput = 'none' | 'customer_optional' | 'noti_generated';

export interface DestinationRegistration<K extends DestinationKind = DestinationKind> {
  readonly kind: K;
  /** Dashboard message id for the display name (`web/src/i18n`). */
  readonly nameKey: `destination.${K}`;
  /** English display name, for server messages and the generated docs. Matches the `en` catalogue. */
  readonly label: string;
  readonly capabilities: DestinationCapabilities & { readonly kind: K };
  readonly limits: readonly DestinationLimit[];
  readonly openQuestions: readonly OpenQuestion[];
  readonly availability: Availability;
  readonly signingSecret: SigningSecretInput;
  /** What a successful response proves, in words (F100/F120). Provider kinds cite the reference. */
  readonly confirmation: { readonly text: string; readonly source?: ReferenceSource };
}

// --- Capabilities (moved verbatim from capabilities.ts; read 2026-10-13) ----------------------
// Byte limits use decimal kilobytes, which is the conservative reading of "20 KB"/"28 KB". Only
// the modes this codebase can actually send through are listed; an app-bot or Web API mode gets
// its own entry when it ships, because its capabilities differ materially (F92).

const SHARED_WEBHOOK_LIMITS = {
  canUpdate: false,
  canDelete: false,
  canReply: false,
  supportsCallbacks: false,
  canCustomizeIdentity: false,
  supportsServerSideIdempotency: false,
  supportsThreads: false,
  // Default-off mention policy (F94): untrusted text must never reach a human's attention.
  supportsMentions: false,
  requiresCustomerOwnedCredential: true,
  supportsLinks: true,
} as const;

const SLACK: DestinationRegistration<'slack'> = {
  kind: 'slack',
  nameKey: 'destination.slack',
  label: 'Slack',
  capabilities: {
    ...SHARED_WEBHOOK_LIMITS,
    kind: 'slack',
    mode: 'incoming_webhook',
    formats: ['card', 'markdown', 'plain'],
    markdownDialect: 'slack_mrkdwn',
    maxBodyBytes: 40_000,
    maxTitleChars: 150,
    maxTextChars: 3000,
    signing: 'none',
    successSemantics: 'delivered',
    // App webhooks render URL buttons, but we do not emit them: without an interactivity
    // request URL configured, a click has nowhere to go.
    supportsInteractive: false,
    redactsContactDetails: false,
  },
  limits: [
    {
      id: 'body',
      label: 'Request body budget',
      value: 40_000,
      unit: 'bytes',
      enforcedAs: 'maxBodyBytes',
      basis: 'derived',
      source: { section: '1.6', excerpt: 'Slack truncates >**40,000**' },
      note: 'Slack states a 40,000-character truncation point for `text`; Noti budgets 40,000 bytes for the whole body.',
    },
    {
      id: 'section_text',
      label: 'Section text',
      value: 3000,
      unit: 'characters',
      enforcedAs: 'maxTextChars',
      basis: 'provider',
      source: { section: '1.6', excerpt: '1–**3000** chars' },
    },
    {
      id: 'title',
      label: 'Header title',
      value: 150,
      unit: 'characters',
      enforcedAs: 'maxTitleChars',
      basis: 'not_stated',
      note: 'The reference does not state a header-block limit; check docs.slack.dev/reference/block-kit/blocks/header-block.',
    },
    {
      id: 'blocks',
      label: 'Blocks per message',
      value: 50,
      unit: 'items',
      basis: 'provider',
      source: { section: '1.6', excerpt: 'Blocks per message | **50**' },
    },
  ],
  openQuestions: [
    {
      text: 'Slack documents no server-side idempotency for incoming webhooks, so a retried delivery can appear twice.',
      source: { section: '1.2', excerpt: '**Idempotency:** none.' },
    },
  ],
  availability: { gate: 'none' },
  signingSecret: 'none',
  confirmation: {
    text: 'Delivered: HTTP 200 with the body `ok`',
    source: { section: '1.2', excerpt: '**Success body:** literal text `ok`' },
  },
};

const TEAMS: DestinationRegistration<'teams'> = {
  kind: 'teams',
  nameKey: 'destination.teams',
  label: 'Microsoft Teams',
  capabilities: {
    ...SHARED_WEBHOOK_LIMITS,
    kind: 'teams',
    mode: 'workflows_webhook',
    // The Workflows trigger only accepts an Adaptive Card envelope, so every rung is a card;
    // the lower rungs are a single TextBlock rather than a structured layout.
    formats: ['card', 'markdown', 'plain'],
    markdownDialect: 'adaptive_card_md',
    maxBodyBytes: 28_000,
    // Our readability limit; the reference states no TextBlock length cap, only the 28 KB total.
    maxTitleChars: 200,
    maxTextChars: 3000,
    signing: 'none',
    // 202 Accepted, no read-back: the flow can still fail after the 202 (F99).
    successSemantics: 'accepted',
    supportsInteractive: false,
    redactsContactDetails: false,
  },
  limits: [
    {
      id: 'body',
      label: 'Message size',
      value: 28_000,
      unit: 'bytes',
      enforcedAs: 'maxBodyBytes',
      basis: 'provider',
      source: { section: '2.2', excerpt: '"**approximately 28 KB**. This limit includes all HTML elements' },
      note: 'Read as decimal kilobytes, the conservative reading.',
    },
    {
      id: 'title',
      label: 'Title',
      value: 200,
      unit: 'characters',
      enforcedAs: 'maxTitleChars',
      basis: 'ours',
      note: 'Noti readability limit. The reference states no title limit.',
    },
    {
      id: 'text',
      label: 'Text block',
      value: 3000,
      unit: 'characters',
      enforcedAs: 'maxTextChars',
      basis: 'ours',
      note: 'Noti readability limit. The reference states no text-block limit.',
    },
    {
      id: 'mentions',
      label: '@mentions per message',
      value: '20 users and 20 tags',
      unit: 'text',
      basis: 'provider',
      source: { section: '2.2', excerpt: 'only up to **20 users and 20 tags**' },
      note: 'Noti sends no mentions.',
    },
  ],
  openQuestions: [
    {
      text: 'A 202 from the Workflows trigger is acceptance, not delivery: the flow can still fail afterwards.',
      source: { section: '2.2', excerpt: 'This is acknowledge-on-receive, *not*' },
    },
    {
      text: 'Power Automate and Logic Apps throttling numbers were not retrieved.',
      source: { section: '2.2', excerpt: 'GAP — Power Automate / Logic Apps request throttling' },
    },
    {
      text: 'Delivery to private channels is unproven: two official Microsoft sources disagree.',
      source: { section: '2.2', excerpt: 'CONFLICT — private channels' },
    },
    {
      text: 'The maximum Adaptive Card version Teams supports is not published.',
      source: { section: '8', excerpt: 'maximum supported Adaptive Card `version` for Teams' },
    },
  ],
  availability: { gate: 'none' },
  signingSecret: 'none',
  confirmation: {
    text: '**Accepted only**: HTTP 202, and the flow can still fail afterwards',
    source: { section: '2.2', excerpt: '**Response:** **HTTP 202 Accepted**, no meaningful body' },
  },
};

const LARK: DestinationRegistration<'lark'> = {
  kind: 'lark',
  nameKey: 'destination.lark',
  label: 'Lark',
  capabilities: {
    ...SHARED_WEBHOOK_LIMITS,
    kind: 'lark',
    mode: 'custom_bot',
    formats: ['card', 'markdown', 'plain'],
    markdownDialect: 'lark_md',
    maxBodyBytes: 20_000,
    // Carried over from the previous adapter; the reference states no header-title limit.
    maxTitleChars: 200,
    maxTextChars: 3000,
    signing: 'lark_hmac_sha256',
    successSemantics: 'delivered',
    // Custom bots support URL jumps only, never callbacks.
    supportsInteractive: false,
    // Error 230028: DLP rejects plaintext phone numbers and personal emails (F102).
    redactsContactDetails: true,
  },
  limits: [
    {
      id: 'body',
      label: 'Request body',
      value: 20_000,
      unit: 'bytes',
      enforcedAs: 'maxBodyBytes',
      basis: 'provider',
      source: { section: '3.1', excerpt: '请求体的数据大小不能超过 **20 KB**' },
      note: 'Read as decimal kilobytes, the conservative reading.',
    },
    {
      id: 'title',
      label: 'Card title',
      value: 200,
      unit: 'characters',
      enforcedAs: 'maxTitleChars',
      basis: 'ours',
      note: 'Noti readability limit. The reference states no title limit.',
    },
    {
      id: 'text',
      label: 'Card text',
      value: 3000,
      unit: 'characters',
      enforcedAs: 'maxTextChars',
      basis: 'ours',
      note: 'Noti readability limit. The reference states no text limit.',
    },
    {
      id: 'rate',
      label: 'Rate limit per custom bot',
      value: '100 per minute, 5 per second',
      unit: 'text',
      basis: 'provider',
      source: { section: '3.1', excerpt: '100 次/分钟，5 次/秒' },
    },
  ],
  openQuestions: [
    {
      text: 'The complete Lark error-code table could not be loaded; unknown codes are expected.',
      source: { section: '3.5', excerpt: 'Unresolved: the full Lark error-code table' },
    },
  ],
  availability: { gate: 'none' },
  signingSecret: 'customer_optional',
  confirmation: {
    text: 'Delivered: `code: 0` in the response body',
    source: { section: '3.1', excerpt: 'Parse `code === 0`' },
  },
};

/**
 * Discord incoming webhook (reference section 4, spec 09 F107/F109). Discord documents no byte
 * cap, so `maxBodyBytes` is derived: (2000 + 6000) characters at up to 4 UTF-8 bytes each, plus
 * JSON overhead. Discord can update, delete and reply to a message it returned an id for, and
 * can take a per-message username and avatar; we do not persist message ids (F156) or expose
 * identity settings, so those are `false` until they are built.
 */
const DISCORD: DestinationRegistration<'discord'> = {
  kind: 'discord',
  nameKey: 'destination.discord',
  label: 'Discord',
  capabilities: {
    ...SHARED_WEBHOOK_LIMITS,
    kind: 'discord',
    mode: 'incoming_webhook',
    formats: ['card', 'markdown', 'plain'],
    markdownDialect: 'discord_md',
    maxBodyBytes: 40_000,
    maxTitleChars: 256,
    maxTextChars: 4096,
    signing: 'none',
    // Always sent with `wait=true`, so a 200 carries the created message: delivered, not accepted.
    successSemantics: 'delivered',
    supportsInteractive: false,
    redactsContactDetails: false,
  },
  limits: [
    {
      id: 'body',
      label: 'Request body budget',
      value: 40_000,
      unit: 'bytes',
      enforcedAs: 'maxBodyBytes',
      basis: 'derived',
      source: { section: '4', excerpt: '**Combined total across all embeds** | **6000**' },
      note: 'Discord states character limits, not a byte cap: 2000 content plus 6000 embed characters at up to 4 bytes each, plus JSON overhead.',
    },
    {
      id: 'title',
      label: 'Embed title',
      value: 256,
      unit: 'characters',
      enforcedAs: 'maxTitleChars',
      basis: 'provider',
      source: { section: '4', excerpt: '| `title` | 256 |' },
    },
    {
      id: 'description',
      label: 'Embed description',
      value: 4096,
      unit: 'characters',
      enforcedAs: 'maxTextChars',
      basis: 'provider',
      source: { section: '4', excerpt: '| `description` | 4096 |' },
    },
    {
      id: 'content',
      label: 'Message content',
      value: 2000,
      unit: 'characters',
      basis: 'provider',
      source: { section: '4', excerpt: '**Message content limit: 2000 characters.**' },
    },
    {
      id: 'global_rate',
      label: 'Global rate limit',
      value: '50 requests per second',
      unit: 'text',
      basis: 'provider',
      source: { section: '4', excerpt: '**Global: 50 requests/second**' },
      note: 'Discord says not to hard-code rate limits; Noti reads the response headers.',
    },
  ],
  openQuestions: [
    {
      text: 'The per-route numeric limit for Execute Webhook is not documented in a form that could be read.',
      source: { section: '4', excerpt: 'UNVERIFIED — per-route numeric limit for `Execute Webhook`' },
    },
  ],
  availability: { gate: 'none' },
  signingSecret: 'none',
  confirmation: {
    text: 'Delivered: the created message is returned, because Noti always sends `wait=true`',
    source: { section: '4', excerpt: '**Always send `wait=true`**' },
  },
};

/**
 * Customer-owned HTTPS endpoint receiving the canonical JSON event, signed with Standard
 * Webhooks (spec 09 F116). No provider limits exist, so the byte cap is ours.
 */
const GENERIC_WEBHOOK: DestinationRegistration<'generic_webhook'> = {
  kind: 'generic_webhook',
  nameKey: 'destination.generic_webhook',
  label: 'Custom webhook',
  capabilities: {
    ...SHARED_WEBHOOK_LIMITS,
    kind: 'generic_webhook',
    mode: 'signed_https',
    // One JSON envelope: there is no richer or plainer rung to degrade to.
    formats: ['card'],
    markdownDialect: 'plain',
    maxBodyBytes: 64_000,
    maxTitleChars: 500,
    maxTextChars: 4096,
    signing: 'standard_webhooks_v1',
    // A 2xx is the only evidence we have (F117); the classifier reports 202 as accepted.
    successSemantics: 'delivered',
    supportsInteractive: false,
    redactsContactDetails: false,
  },
  limits: [
    {
      id: 'body',
      label: 'Request body budget',
      value: 64_000,
      unit: 'bytes',
      enforcedAs: 'maxBodyBytes',
      basis: 'ours',
      note: 'Noti budget: the customer owns the endpoint, so there is no provider limit.',
    },
    {
      id: 'title',
      label: 'Title',
      value: 500,
      unit: 'characters',
      enforcedAs: 'maxTitleChars',
      basis: 'ours',
    },
    {
      id: 'text',
      label: 'Summary',
      value: 4096,
      unit: 'characters',
      enforcedAs: 'maxTextChars',
      basis: 'ours',
    },
  ],
  openQuestions: [],
  availability: { gate: 'deployment_flag', variable: 'GENERIC_WEBHOOK_ENABLED' },
  signingSecret: 'noti_generated',
  confirmation: {
    text: 'A 2xx from the customer endpoint; a 202 is shown as accepted, not delivered',
  },
};

export const DESTINATION_REGISTRY: { readonly [K in DestinationKind]: DestinationRegistration<K> } = {
  lark: LARK,
  slack: SLACK,
  teams: TEAMS,
  discord: DISCORD,
  generic_webhook: GENERIC_WEBHOOK,
};

export function registrationOf<K extends DestinationKind>(kind: K): DestinationRegistration<K> {
  return DESTINATION_REGISTRY[kind];
}

/** Display names in offer order, e.g. for an error message listing the choices. */
export function destinationLabels(): readonly string[] {
  return DESTINATION_KINDS.map((kind) => DESTINATION_REGISTRY[kind].label);
}

/**
 * Destinations and modes that are deliberately not offered, with the reason (F120: a row in the
 * matrix reads as an offer, so these are listed apart from it).
 */
export const NOT_OFFERED: readonly {
  readonly name: string;
  readonly reason: string;
  readonly source: ReferenceSource;
}[] = [
  {
    name: 'Telegram',
    reason:
      'A bot token belongs to one bot owner, so there is no way for a customer to grant a multi-tenant service scoped access (spec 09 F110).',
    source: { section: '5', excerpt: 'Telegram has **no OAuth and no multi-tenant app concept**' },
  },
  {
    name: 'Microsoft Teams Office 365 Connectors',
    reason: 'Retired by Microsoft. Teams is offered through Workflows only.',
    source: {
      section: '2.1',
      excerpt: '**Microsoft 365 / Office 365 Connectors were permanently disabled on 18–22 May 2026.**',
    },
  },
  {
    name: 'Email',
    reason: 'Not built. The sending quota and the third-party provider specifics are open questions.',
    source: { section: '8', excerpt: 'Cloudflare Email Sending daily quota number' },
  },
  {
    name: 'Slack Web API, Teams bot and Lark app modes',
    reason:
      'Not built. Their capabilities differ materially from the webhook modes above (message update, threads, and for the Lark app server-side deduplication), so each gets its own registry entry when it ships.',
    source: { section: '7', excerpt: '| Server-side dedup | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ `uuid` |' },
  },
];

// --- Save-time feature validation (F93) -------------------------------------------------------

/**
 * Features a person could ask a destination for. Each maps to the capability that would have to
 * be true for Noti to provide it. Today every one is `false` for every built mode, so every
 * request is refused at save time rather than silently degraded at delivery (F93).
 */
export const DESTINATION_FEATURES = {
  update_in_place: { capability: 'canUpdate', label: 'updating a message in place' },
  delete_message: { capability: 'canDelete', label: 'deleting a sent message' },
  thread_replies: { capability: 'canReply', label: 'replying in a thread' },
  interactive_buttons: { capability: 'supportsInteractive', label: 'interactive buttons' },
  mentions: { capability: 'supportsMentions', label: '@mentions' },
  custom_identity: { capability: 'canCustomizeIdentity', label: 'a custom sender name or icon' },
} as const satisfies Readonly<
  Record<string, { readonly capability: keyof DestinationCapabilities; readonly label: string }>
>;
export type DestinationFeature = keyof typeof DESTINATION_FEATURES;

export const RENDER_FORMATS: readonly RenderFormat[] = ['card', 'markdown', 'plain'];

export interface FeatureIssue {
  readonly field: 'format' | 'features';
  readonly message: string;
}

/**
 * Checks a requested message format and feature list against what the kind supports. Pure.
 * `format` absent means the default (the richest rung). A requested format the kind renders but
 * that is not its default is refused as "not available yet": no column stores a format choice
 * (it would need a migration), so accepting it would be a silent downgrade of the request.
 */
export function requestedFeatureIssues(
  kind: DestinationKind,
  requested: { readonly format?: unknown; readonly features?: unknown },
): FeatureIssue[] {
  const { label, capabilities } = DESTINATION_REGISTRY[kind];
  const issues: FeatureIssue[] = [];
  if (requested.format !== undefined) {
    const format = requested.format;
    if (typeof format !== 'string' || !(RENDER_FORMATS as readonly string[]).includes(format)) {
      issues.push({ field: 'format', message: 'Use card, markdown or plain.' });
    } else if (!(capabilities.formats as readonly string[]).includes(format)) {
      issues.push({
        field: 'format',
        message: `${label} does not support the ${format} format. It supports: ${capabilities.formats.join(', ')}.`,
      });
    } else if (format !== capabilities.formats[0]) {
      issues.push({
        field: 'format',
        message: `Choosing the ${format} format is not available yet. Noti sends ${capabilities.formats[0]} and falls back to a plainer format only when the message does not fit.`,
      });
    }
  }
  if (requested.features !== undefined) {
    const list = requested.features;
    if (!Array.isArray(list) || list.length > Object.keys(DESTINATION_FEATURES).length) {
      issues.push({ field: 'features', message: 'Send a list of feature names.' });
      return issues;
    }
    for (const name of new Set<unknown>(list)) {
      if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(DESTINATION_FEATURES, name)) {
        issues.push({ field: 'features', message: 'Contains a feature Noti does not know.' });
        continue;
      }
      const feature = DESTINATION_FEATURES[name as DestinationFeature];
      issues.push({
        field: 'features',
        message:
          capabilities[feature.capability] === true
            ? `${label} supports ${feature.label}, but choosing it is not available yet.`
            : `${label} in Noti does not support ${feature.label}.`,
      });
    }
  }
  return issues;
}
