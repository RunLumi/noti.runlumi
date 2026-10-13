import { safeLinkUrl } from '../markup';
import {
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
 * Teams Workflows ("When a Teams webhook request is received") rendering.
 *
 * The trigger takes a `type: "message"` envelope whose `attachments[]` carry an Adaptive
 * Card with `contentUrl: null` (https://learn.microsoft.com/en-us/connectors/teams/).
 * MessageCard is never emitted: Microsoft states interactive features are unsupported for it
 * on Workflows, and Office 365 Connectors were retired in May 2026 (F104).
 *
 * Every rung is an Adaptive Card because the envelope requires one; the lower rungs collapse
 * the layout into a single TextBlock.
 */

export const ADAPTIVE_CARD_CONTENT_TYPE = 'application/vnd.microsoft.card.adaptive';
// UNVERIFIED: Teams does not publish its maximum supported Adaptive Card version. 1.2 is the
// version every Microsoft Workflows sample uses; raise it only after a real-tenant test.
export const ADAPTIVE_CARD_VERSION = '1.2';
const ADAPTIVE_CARD_SCHEMA = 'http://adaptivecards.io/schemas/adaptive-card.json';
const TEXT_MAX = 4000;

const STATUS_COLOR: { readonly [S in NotificationStatus]: string } = {
  success: 'Good',
  failure: 'Attention',
  warning: 'Warning',
  info: 'Default',
};

function envelope(body: readonly JsonObject[], actions: readonly JsonObject[]): JsonObject {
  const content: JsonObject = {
    $schema: ADAPTIVE_CARD_SCHEMA,
    type: 'AdaptiveCard',
    version: ADAPTIVE_CARD_VERSION,
    body,
    ...(actions.length > 0 ? { actions } : {}),
  };
  return {
    type: 'message',
    attachments: [{ contentType: ADAPTIVE_CARD_CONTENT_TYPE, contentUrl: null, content }],
  };
}

function textBlock(text: string, extra: JsonObject = {}): JsonObject {
  return { type: 'TextBlock', text, wrap: true, ...extra };
}

function openUrlActions(n: CanonicalNotification): readonly JsonObject[] {
  const url = safeLinkUrl(n.url);
  // Action titles are plain text: `linkLabel` has already removed control characters.
  return url ? [{ type: 'Action.OpenUrl', title: linkLabel(n), url }] : [];
}

function cardRung(n: CanonicalNotification, caps: DestinationCapabilities): RungOutput {
  const title = fitTitle(n, 'adaptive_card_md', caps.maxTitleChars);
  const meta = fitMeta(n, 'adaptive_card_md');
  const summary = fitSummary(n, 'adaptive_card_md', caps.maxTextChars);
  const body: JsonObject[] = [
    textBlock(title.text, { weight: 'Bolder', size: 'Medium', color: STATUS_COLOR[n.status ?? 'info'] }),
    ...(meta.text ? [textBlock(meta.text, { isSubtle: true, spacing: 'None' })] : []),
    ...(summary.text ? [textBlock(summary.text)] : []),
  ];
  const truncated: RenderedField[] = [
    ...(title.truncated ? (['title'] as const) : []),
    ...(meta.truncated ? (['meta'] as const) : []),
    ...(summary.truncated ? (['summary'] as const) : []),
  ];
  return { payload: envelope(body, openUrlActions(n)), truncatedFields: truncated };
}

function textRung(n: CanonicalNotification, caps: DestinationCapabilities, rich: boolean): RungOutput {
  const out = composeText(n, {
    dialect: 'adaptive_card_md',
    maxChars: TEXT_MAX,
    maxTitleChars: caps.maxTitleChars,
    linkStyle: rich ? 'markup' : 'bare',
    ...(rich ? { titleWrap: ['**', '**'] as const } : {}),
  });
  return { payload: envelope([textBlock(out.text)], []), truncatedFields: out.truncatedFields };
}

export function renderTeams(
  n: CanonicalNotification,
  caps: DestinationCapabilities,
  options: RenderOptions = {},
): RenderResult {
  const prepared = prepareNotification(n, caps);
  const p = prepared.notification;
  return runLadder({
    kind: 'teams',
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
