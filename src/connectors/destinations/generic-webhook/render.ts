import { fitText, safeLinkUrl } from '../markup';
import { prepareNotification, runLadder, type RungOutput } from '../render';
import type { RenderOptions } from '../adapter';
import type {
  CanonicalNotification,
  DestinationCapabilities,
  JsonObject,
  RenderResult,
  RenderedField,
} from '../types';

/**
 * The canonical JSON event a customer's endpoint receives (spec 09 F116). It is our own
 * stable vocabulary, never a provider payload, so a receiver sees the same fields whichever
 * source produced the event.
 *
 * ```
 * { "version": 1, "type": "noti.notification",
 *   "id": "<delivery id>", "time": "<ISO 8601, this attempt>", "workspaceId": "<opaque id>",
 *   "notification": { title, eventType, url?, repo?, actor?, status?, summary? } }
 * ```
 *
 * `id`, `time` and `workspaceId` are added by `buildRequest` (they are per-delivery facts the
 * pure renderer does not have); `ENVELOPE_RESERVE_BYTES` keeps them inside the byte budget.
 * Text is bounded and stripped of control characters and bidi overrides but NOT escaped: it is
 * data for a program, and escaping it for a chat dialect would corrupt it.
 */

export const PAYLOAD_VERSION = 1;
export const PAYLOAD_TYPE = 'noti.notification';
/** Room for `id`, `time` and `workspaceId`: 128 + 24 + 128 characters plus keys and quotes. */
export const ENVELOPE_RESERVE_BYTES = 512;

function put(out: Record<string, string>, key: string, text: string | undefined, max: number): boolean {
  if (text === undefined) return false;
  const fitted = fitText(text, 'plain', max);
  out[key] = fitted.text;
  return fitted.truncated;
}

function notificationRung(n: CanonicalNotification, caps: DestinationCapabilities): RungOutput {
  const fields: Record<string, string> = {};
  const truncated: RenderedField[] = [];
  if (put(fields, 'title', n.title, caps.maxTitleChars)) truncated.push('title');
  put(fields, 'eventType', n.eventType, 128);
  const url = safeLinkUrl(n.url);
  if (url) fields.url = url;
  if (put(fields, 'repo', n.repo, 200) || put(fields, 'actor', n.actor, 200)) truncated.push('meta');
  if (n.status) fields.status = n.status;
  if (put(fields, 'summary', n.summary, caps.maxTextChars)) truncated.push('summary');
  const payload: JsonObject = {
    version: PAYLOAD_VERSION,
    type: PAYLOAD_TYPE,
    notification: fields,
  };
  return { payload, truncatedFields: truncated };
}

export function renderGenericWebhook(
  n: CanonicalNotification,
  caps: DestinationCapabilities,
  options: RenderOptions = {},
): RenderResult {
  const prepared = prepareNotification(n, caps);
  return runLadder({
    kind: 'generic_webhook',
    caps,
    redactedFields: prepared.redactedFields,
    reserveBytes: ENVELOPE_RESERVE_BYTES,
    ...(options.startAt ? { startAt: options.startAt } : {}),
    rungs: { card: () => notificationRung(prepared.notification, caps) },
  });
}
