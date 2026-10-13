import { linkAtom, safeLinkUrl } from '../markup';
import {
  composeText,
  fitMeta,
  fitSummary,
  fitTitle,
  linkLabel,
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
  RenderResult,
  RenderedField,
} from '../types';

/**
 * Slack incoming-webhook rendering: Block Kit with a top-level `text` fallback.
 *
 * Top-level `text` is always populated because "screen readers will default to the
 * top-level text field of your post, and will not read the content of any interior blocks"
 * (https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks). It is also
 * the notification preview. App webhooks cannot override channel, username or icon, so no
 * such field is ever emitted (F103).
 *
 * Untrusted text goes into `plain_text` objects wherever Block Kit allows it, so mrkdwn is
 * only ever used for text we compose ourselves (the link and the fallback).
 */

/** Slack recommends keeping `text` to 4,000 characters (chat.postMessage reference). */
export const SLACK_TEXT_MAX = 4000;

function fallbackText(n: CanonicalNotification, caps: DestinationCapabilities, bold: boolean) {
  return composeText(n, {
    dialect: 'slack_mrkdwn',
    maxChars: SLACK_TEXT_MAX,
    maxTitleChars: caps.maxTitleChars,
    linkStyle: bold ? 'markup' : 'bare',
    ...(bold ? { titleWrap: ['*', '*'] as const } : {}),
  });
}

function plainTextObject(text: string): JsonObject {
  return { type: 'plain_text', text };
}

function linkBlock(n: CanonicalNotification): JsonObject | undefined {
  const url = safeLinkUrl(n.url);
  if (!url) return undefined;
  return { type: 'section', text: { type: 'mrkdwn', text: linkAtom(url, linkLabel(n), 'slack_mrkdwn') } };
}

function cardRung(n: CanonicalNotification, caps: DestinationCapabilities): RungOutput {
  const title = fitTitle(n, 'plain', caps.maxTitleChars);
  const meta = fitMeta(n, 'plain');
  const summary = fitSummary(n, 'plain', caps.maxTextChars);
  const fallback = fallbackText(n, caps, true);
  const link = linkBlock(n);
  const blocks: JsonObject[] = [
    { type: 'header', text: plainTextObject(title.text) },
    ...(meta.text ? [{ type: 'context', elements: [plainTextObject(meta.text)] }] : []),
    ...(summary.text ? [{ type: 'section', text: plainTextObject(summary.text) }] : []),
    ...(link ? [link] : []),
  ];
  const truncated: RenderedField[] = [
    ...(title.truncated ? (['title'] as const) : []),
    ...(meta.truncated ? (['meta'] as const) : []),
    ...(summary.truncated ? (['summary'] as const) : []),
    ...fallback.truncatedFields,
  ];
  return { payload: { text: fallback.text, blocks }, truncatedFields: uniqueFields(truncated) };
}

function textRung(n: CanonicalNotification, caps: DestinationCapabilities, bold: boolean): RungOutput {
  const out = fallbackText(n, caps, bold);
  return { payload: { text: out.text }, truncatedFields: out.truncatedFields };
}

export function renderSlack(
  n: CanonicalNotification,
  caps: DestinationCapabilities,
  options: RenderOptions = {},
): RenderResult {
  const prepared = prepareNotification(n, caps);
  const p = prepared.notification;
  return runLadder({
    kind: 'slack',
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
