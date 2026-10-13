import { linkAtom, safeLinkUrl } from '../markup';
import {
  STRINGS,
  composeText,
  fitMeta,
  fitSummary,
  fitTitle,
  linkLabel,
  prepareNotification,
  runLadder,
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
 * Lark custom-bot rendering. `msg_type: "interactive"` carries the card in a top-level
 * `card` field (not `content`); `text` uses `content`. They are not interchangeable
 * (https://open.larksuite.com/document/client-docs/bot-v3/add-custom-bot).
 *
 * Cards use JSON 2.0 (https://open.feishu.cn/document/feishu-cards/card-json-v2-structure).
 * `config.summary.content` is always set: without it the chat-list preview is blank (F101).
 */

/** Room for the `timestamp` and `sign` fields added after render when signing is on. */
export const LARK_SIGNATURE_RESERVE_BYTES = 128;
const PREVIEW_MAX = 100;
const TEXT_MAX = 4000;

export type LarkTemplate = 'green' | 'red' | 'orange' | 'blue';

const STATUS_TEMPLATE: { readonly [S in NotificationStatus]: LarkTemplate } = {
  success: 'green',
  failure: 'red',
  warning: 'orange',
  info: 'blue',
};

export type LarkMarkdownElement = {
  readonly tag: 'markdown';
  readonly content: string;
};

/** The JSON 2.0 card shape we emit. A type alias so it stays assignable to `JsonObject`. */
export type LarkCard = {
  readonly schema: '2.0';
  readonly config: {
    readonly enable_forward: true;
    readonly summary: { readonly content: string };
  };
  readonly header?: {
    readonly title: { readonly tag: 'plain_text'; readonly content: string };
    readonly template: LarkTemplate;
  };
  readonly body: { readonly elements: readonly LarkMarkdownElement[] };
};

interface LarkRenderContext {
  readonly caps: DestinationCapabilities;
  readonly withStatus: boolean;
}

function markdown(content: string): LarkMarkdownElement {
  return { tag: 'markdown', content };
}

function cardConfig(n: CanonicalNotification, ctx: LarkRenderContext): LarkCard['config'] {
  const preview = fitTitle(n, 'lark_md', PREVIEW_MAX, { withStatus: ctx.withStatus }).text;
  return { enable_forward: true, summary: { content: preview } };
}

function linkElement(n: CanonicalNotification): LarkMarkdownElement {
  const url = safeLinkUrl(n.url);
  return markdown(url ? linkAtom(url, linkLabel(n), 'lark_md') : STRINGS.linkUnavailable);
}

export interface LarkCardParts {
  readonly card: LarkCard;
  readonly truncatedFields: readonly RenderedField[];
}

/**
 * The native JSON 2.0 card. The header title is `plain_text`, so it needs no escaping. The
 * status stays in the title text as well as the colour: colour alone is not accessible.
 */
export function larkCardParts(n: CanonicalNotification, ctx: LarkRenderContext): LarkCardParts {
  const title = fitTitle(n, 'plain', ctx.caps.maxTitleChars, { withStatus: ctx.withStatus });
  const meta = fitMeta(n, 'lark_md');
  const summary = fitSummary(n, 'lark_md', ctx.caps.maxTextChars);
  const card: LarkCard = {
    schema: '2.0',
    config: cardConfig(n, ctx),
    header: {
      title: { tag: 'plain_text', content: title.text },
      template: STATUS_TEMPLATE[n.status ?? 'info'],
    },
    body: {
      elements: [
        ...(meta.text ? [markdown(meta.text)] : []),
        ...(summary.text ? [markdown(summary.text)] : []),
        linkElement(n),
      ],
    },
  };
  const truncatedFields: RenderedField[] = [
    ...(title.truncated ? (['title'] as const) : []),
    ...(meta.truncated ? (['meta'] as const) : []),
    ...(summary.truncated ? (['summary'] as const) : []),
  ];
  return { card, truncatedFields };
}

function cardRung(n: CanonicalNotification, ctx: LarkRenderContext): RungOutput {
  const parts = larkCardParts(n, ctx);
  return { payload: { msg_type: 'interactive', card: parts.card }, truncatedFields: parts.truncatedFields };
}

function composed(n: CanonicalNotification, ctx: LarkRenderContext, rich: boolean) {
  return composeText(n, {
    dialect: 'lark_md',
    maxChars: TEXT_MAX,
    maxTitleChars: ctx.caps.maxTitleChars,
    linkStyle: rich ? 'markup' : 'bare',
    withStatus: ctx.withStatus,
    ...(rich ? { titleWrap: ['**', '**'] as const } : {}),
  });
}

function markdownRung(n: CanonicalNotification, ctx: LarkRenderContext): RungOutput {
  const out = composed(n, ctx, true);
  const card: LarkCard = {
    schema: '2.0',
    config: cardConfig(n, ctx),
    body: { elements: [markdown(out.text)] },
  };
  return { payload: { msg_type: 'interactive', card }, truncatedFields: out.truncatedFields };
}

/**
 * UNVERIFIED: the `text` message body shape `{ content: { text } }` is the long-standing
 * custom-bot format, but DESTINATION_API_REFERENCE.md records only `content: {…}`. Text is
 * still neutralised with the `lark_md` rules because text messages also parse `<at>` tags.
 */
function plainRung(n: CanonicalNotification, ctx: LarkRenderContext): RungOutput {
  const out = composed(n, ctx, false);
  const payload: JsonObject = { msg_type: 'text', content: { text: out.text } };
  return { payload, truncatedFields: out.truncatedFields };
}

export function renderLark(
  n: CanonicalNotification,
  caps: DestinationCapabilities,
  options: RenderOptions = {},
): RenderResult {
  const prepared = prepareNotification(n, caps);
  const p = prepared.notification;
  const ctx: LarkRenderContext = { caps, withStatus: options.statusInTitle !== false };
  return runLadder({
    kind: 'lark',
    caps,
    redactedFields: prepared.redactedFields,
    reserveBytes: caps.signing === 'lark_hmac_sha256' ? LARK_SIGNATURE_RESERVE_BYTES : 0,
    ...(options.startAt ? { startAt: options.startAt } : {}),
    rungs: {
      card: () => cardRung(p, ctx),
      markdown: () => markdownRung(p, ctx),
      plain: () => plainRung(p, ctx),
    },
  });
}
