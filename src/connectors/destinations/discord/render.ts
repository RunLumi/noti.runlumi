import { safeLinkUrl } from '../markup';
import {
  composeText,
  fitMeta,
  fitSummary,
  fitTitle,
  prepareNotification,
  runLadder,
  uniqueFields,
  type RungOutput,
} from '../render';
import type { RenderOptions } from '../adapter';
import type {
  CanonicalNotification,
  DestinationCapabilities,
  JsonObject,
  NotificationStatus,
  RenderResult,
  RenderedField,
} from '../types';

/**
 * Discord incoming-webhook rendering (spec 09 F109).
 *
 * Hard limits (reference section 4): content 2000, embed title 256, description 4096, footer
 * 2048, all embeds combined 6000. Exceeding one is a `400`, which would be a permanent
 * failure, so every field is fitted before it is placed.
 *
 *  - Exactly ONE embed per message, always: Discord deduplicates embeds by URL ("only the
 *    first is shown"), so two events from one repository would otherwise collapse into one.
 *  - `allowed_mentions` is `{ "parse": [] }` on EVERY payload, every rung, without exception.
 *    A branch named `@everyone` or a PR body containing `<@&123>` therefore cannot ping a
 *    person; the text is also neutralised (see `markup.ts`) so it reads as inert.
 *  - `content` carries a short plain preview with the embed, as the chat-list and screen-reader
 *    text. `username` and `avatar_url` are never emitted.
 */

export const DISCORD_CONTENT_MAX = 2000;
/** The sum Discord checks across title, description, fields, footer and author of all embeds. */
export const DISCORD_EMBED_TOTAL_MAX = 6000;
const PREVIEW_MAX = 300;

/** The mention policy. A constant, so no code path can build a payload without it. */
const NO_MENTIONS: JsonObject = { parse: [] };

/** Embed side-bar colours, as decimal RGB. Status is also in the title text, never colour alone. */
const STATUS_COLOR: { readonly [S in NotificationStatus]: number } = {
  success: 0x2e9e5b,
  failure: 0xd64545,
  warning: 0xe0a030,
  info: 0x5865a8,
};

function cardRung(n: CanonicalNotification, caps: DestinationCapabilities): RungOutput {
  const title = fitTitle(n, 'discord_text', caps.maxTitleChars);
  const preview = fitTitle(n, 'discord_md', PREVIEW_MAX);
  const meta = fitMeta(n, 'discord_text');
  const summary = fitSummary(n, 'discord_md', caps.maxTextChars);
  const url = safeLinkUrl(n.url);
  const embed: JsonObject = {
    title: title.text,
    ...(url ? { url } : {}),
    ...(summary.text ? { description: summary.text } : {}),
    color: STATUS_COLOR[n.status ?? 'info'],
    ...(meta.text ? { footer: { text: meta.text } } : {}),
  };
  const truncated: RenderedField[] = [
    ...(title.truncated || preview.truncated ? (['title'] as const) : []),
    ...(meta.truncated ? (['meta'] as const) : []),
    ...(summary.truncated ? (['summary'] as const) : []),
  ];
  return {
    payload: { content: preview.text, embeds: [embed], allowed_mentions: NO_MENTIONS },
    truncatedFields: uniqueFields(truncated),
  };
}

function textRung(n: CanonicalNotification, caps: DestinationCapabilities, rich: boolean): RungOutput {
  const out = composeText(n, {
    dialect: 'discord_md',
    maxChars: DISCORD_CONTENT_MAX,
    maxTitleChars: caps.maxTitleChars,
    linkStyle: rich ? 'markup' : 'bare',
    ...(rich ? { titleWrap: ['**', '**'] as const } : {}),
  });
  return {
    payload: { content: out.text, allowed_mentions: NO_MENTIONS },
    truncatedFields: out.truncatedFields,
  };
}

export function renderDiscord(
  n: CanonicalNotification,
  caps: DestinationCapabilities,
  options: RenderOptions = {},
): RenderResult {
  const prepared = prepareNotification(n, caps);
  const p = prepared.notification;
  return runLadder({
    kind: 'discord',
    caps,
    redactedFields: prepared.redactedFields,
    ...(options.startAt ? { startAt: options.startAt } : {}),
    rungs: {
      card: () => cardRung(p, caps),
      markdown: () => textRung(p, caps, true),
      plain: () => textRung(p, caps, false),
    },
  });
}
