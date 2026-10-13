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

type LarkTemplate = 'green' | 'red' | 'orange' | 'blue';

const STATUS_TEMPLATE: { readonly [S in NotificationStatus]: LarkTemplate } = {
  success: 'green',
  failure: 'red',
  warning: 'orange',
  info: 'blue',
};

function markdown(content: string): JsonObject {
  return { tag: 'markdown', content };
}

function cardConfig(n: CanonicalNotification): JsonObject {
  return { enable_forward: true, summary: { content: fitTitle(n, 'lark_md', PREVIEW_MAX).text } };
}

function linkElement(n: CanonicalNotification): JsonObject {
  const url = safeLinkUrl(n.url);
  return markdown(url ? linkAtom(url, linkLabel(n), 'lark_md') : STRINGS.linkUnavailable);
}

export interface LarkCardParts {
  readonly card: JsonObject;
  readonly truncatedFields: readonly RenderedField[];
}

/**
 * The native JSON 2.0 card. The header title is `plain_text`, so it needs no escaping. The
 * status stays in the title text as well as the colour: colour alone is not accessible.
 */
export function larkCardParts(n: CanonicalNotification, caps: DestinationCapabilities): LarkCardParts {
  const title = fitTitle(n, 'plain', caps.maxTitleChars);
  const meta = fitMeta(n, 'lark_md');
  const summary = fitSummary(n, 'lark_md', caps.maxTextChars);
  const elements: JsonObject[] = [
    ...(meta.text ? [markdown(meta.text)] : []),
    ...(summary.text ? [markdown(summary.text)] : []),
    linkElement(n),
  ];
  const card: JsonObject = {
    schema: '2.0',
    config: cardConfig(n),
    header: {
      title: { tag: 'plain_text', content: title.text },
      template: STATUS_TEMPLATE[n.status ?? 'info'],
    },
    body: { elements },
  };
  const truncatedFields: RenderedField[] = [
    ...(title.truncated ? (['title'] as const) : []),
    ...(meta.truncated ? (['meta'] as const) : []),
    ...(summary.truncated ? (['summary'] as const) : []),
  ];
  return { card, truncatedFields };
}

function cardRung(n: CanonicalNotification, caps: DestinationCapabilities): RungOutput {
  const parts = larkCardParts(n, caps);
  return { payload: { msg_type: 'interactive', card: parts.card }, truncatedFields: parts.truncatedFields };
}

function composed(n: CanonicalNotification, caps: DestinationCapabilities, rich: boolean) {
  return composeText(n, {
    dialect: 'lark_md',
    maxChars: TEXT_MAX,
    maxTitleChars: caps.maxTitleChars,
    linkStyle: rich ? 'markup' : 'bare',
    ...(rich ? { titleWrap: ['**', '**'] as const } : {}),
  });
}

function markdownRung(n: CanonicalNotification, caps: DestinationCapabilities): RungOutput {
  const out = composed(n, caps, true);
  const card: JsonObject = { schema: '2.0', config: cardConfig(n), body: { elements: [markdown(out.text)] } };
  return { payload: { msg_type: 'interactive', card }, truncatedFields: out.truncatedFields };
}

/**
 * UNVERIFIED: the `text` message body shape `{ content: { text } }` is the long-standing
 * custom-bot format, but DESTINATION_API_REFERENCE.md records only `content: {…}`. Text is
 * still neutralised with the `lark_md` rules because text messages also parse `<at>` tags.
 */
function plainRung(n: CanonicalNotification, caps: DestinationCapabilities): RungOutput {
  const out = composed(n, caps, false);
  return { payload: { msg_type: 'text', content: { text: out.text } }, truncatedFields: out.truncatedFields };
}

export function renderLark(
  n: CanonicalNotification,
  caps: DestinationCapabilities,
  options: RenderOptions = {},
): RenderResult {
  const prepared = prepareNotification(n, caps);
  const p = prepared.notification;
  return runLadder({
    kind: 'lark',
    caps,
    redactedFields: prepared.redactedFields,
    reserveBytes: caps.signing === 'lark_hmac_sha256' ? LARK_SIGNATURE_RESERVE_BYTES : 0,
    ...(options.startAt ? { startAt: options.startAt } : {}),
    rungs: {
      card: () => cardRung(p, caps),
      markdown: () => markdownRung(p, caps),
      plain: () => plainRung(p, caps),
    },
  });
}
