import type { DestinationCapabilities, DestinationKind } from './types';

/**
 * The verified capability matrix (docs/DESTINATION_API_REFERENCE.md §7, read 2026-10-13).
 * Only the modes this codebase can actually send through are listed; an app-bot or Web API
 * mode gets its own entry when it ships, because its capabilities differ materially (F92).
 *
 * Byte limits use decimal kilobytes, which is the conservative reading of "20 KB"/"28 KB".
 */

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

const SLACK_INCOMING_WEBHOOK: DestinationCapabilities = {
  ...SHARED_WEBHOOK_LIMITS,
  kind: 'slack',
  mode: 'incoming_webhook',
  formats: ['card', 'markdown', 'plain'],
  markdownDialect: 'slack_mrkdwn',
  // Slack truncates `text` beyond 40,000 chars; the matrix records ~40 KB.
  maxBodyBytes: 40_000,
  // Header block limit. UNVERIFIED: 150 is Slack's header-block limit but it is not in
  // DESTINATION_API_REFERENCE.md; check docs.slack.dev/reference/block-kit/blocks/header-block.
  maxTitleChars: 150,
  // `section.text` is 1–3000 chars (Block Kit section reference).
  maxTextChars: 3000,
  signing: 'none',
  successSemantics: 'delivered',
  // App webhooks render URL buttons, but we do not emit them: without an interactivity
  // request URL configured, a click has nowhere to go.
  supportsInteractive: false,
  redactsContactDetails: false,
};

const TEAMS_WORKFLOWS_WEBHOOK: DestinationCapabilities = {
  ...SHARED_WEBHOOK_LIMITS,
  kind: 'teams',
  mode: 'workflows_webhook',
  // The Workflows trigger only accepts an Adaptive Card envelope, so every rung is a card;
  // the lower rungs are a single TextBlock rather than a structured layout.
  formats: ['card', 'markdown', 'plain'],
  markdownDialect: 'adaptive_card_md',
  // "approximately 28 KB … includes all HTML elements" — learn.microsoft.com/connectors/teams
  maxBodyBytes: 28_000,
  // Our readability limit; Teams documents no TextBlock length cap, only the 28 KB total.
  maxTitleChars: 200,
  maxTextChars: 3000,
  signing: 'none',
  // 202 Accepted, no read-back: the flow can still fail after the 202 (F99).
  successSemantics: 'accepted',
  supportsInteractive: false,
  redactsContactDetails: false,
};

const LARK_CUSTOM_BOT: DestinationCapabilities = {
  ...SHARED_WEBHOOK_LIMITS,
  kind: 'lark',
  mode: 'custom_bot',
  formats: ['card', 'markdown', 'plain'],
  markdownDialect: 'lark_md',
  // "请求体的数据大小不能超过 20 KB" — Lark custom-bot guide.
  maxBodyBytes: 20_000,
  // Carried over from the previous adapter; Lark does not document a header-title limit.
  maxTitleChars: 200,
  maxTextChars: 3000,
  signing: 'lark_hmac_sha256',
  successSemantics: 'delivered',
  // Custom bots support URL jumps only, never callbacks.
  supportsInteractive: false,
  // Error 230028: DLP rejects plaintext phone numbers and personal emails (F102).
  redactsContactDetails: true,
};

/**
 * Discord incoming webhook (reference section 4, spec 09 F107/F109). Limits are in characters
 * (content 2000, embed total 6000); Discord documents no byte cap, so `maxBodyBytes` is
 * derived: (2000 + 6000) characters at up to 4 UTF-8 bytes each, plus JSON overhead.
 *
 * Capabilities describe what THIS adapter does, not what the provider could do. Discord can
 * update, delete and reply to a message it returned an id for, and can take a per-message
 * username and avatar; we do not persist message ids (F156) or expose identity settings, so
 * those are `false` until they are built. Reporting the provider's ability would be a fake
 * capability (F93).
 */
const DISCORD_WEBHOOK: DestinationCapabilities = {
  ...SHARED_WEBHOOK_LIMITS,
  kind: 'discord',
  mode: 'incoming_webhook',
  formats: ['card', 'markdown', 'plain'],
  markdownDialect: 'discord_md',
  maxBodyBytes: 40_000,
  // Embed title limit.
  maxTitleChars: 256,
  // Embed description limit.
  maxTextChars: 4096,
  signing: 'none',
  // Always sent with `wait=true`, so a 200 carries the created message: delivered, not accepted.
  successSemantics: 'delivered',
  supportsInteractive: false,
  redactsContactDetails: false,
};

/**
 * Customer-owned HTTPS endpoint receiving the canonical JSON event, signed with Standard
 * Webhooks (spec 09 F116). No provider limits exist, so the byte cap is ours.
 */
const GENERIC_WEBHOOK: DestinationCapabilities = {
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
};

const BY_KIND: { readonly [K in DestinationKind]: DestinationCapabilities } = {
  slack: SLACK_INCOMING_WEBHOOK,
  teams: TEAMS_WORKFLOWS_WEBHOOK,
  lark: LARK_CUSTOM_BOT,
  discord: DISCORD_WEBHOOK,
  generic_webhook: GENERIC_WEBHOOK,
};

/** Capabilities of the only currently-supported mode of each destination kind. */
export function capabilitiesFor(kind: DestinationKind): DestinationCapabilities {
  return BY_KIND[kind];
}
