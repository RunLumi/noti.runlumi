/**
 * Compatibility surface for the current queue consumer (`src/pipeline/consumer.ts`), which
 * predates the adapter contract. Both helpers route through the same preparation path as
 * `larkAdapter` (input bounding, DLP masking, byte budget) and keep their original
 * signatures and titles (no status prefix). New code should use `larkAdapter` via `../index`.
 */
import { capabilitiesFor } from '../capabilities';
import { prepareNotification } from '../render';
import type { CanonicalNotification, JsonObject, NotificationStatus } from '../types';
import { larkCardParts, renderLark, type LarkCard } from './render';
import { larkSignatureFields } from './sign';

export { larkAccepted } from './classify';
export { larkSignature } from './sign';
export type { LarkCard } from './render';

export type LarkEvent = {
  title: string;
  url: string;
  repo?: string;
  actor?: string;
  status?: Extract<NotificationStatus, 'success' | 'failure' | 'info'>;
};

const LEGACY_EVENT_TYPE = 'legacy';

function toCanonical(event: LarkEvent): CanonicalNotification {
  return { ...event, eventType: LEGACY_EVENT_TYPE };
}

/** @deprecated Use `larkAdapter.render`, which also applies the degradation ladder. */
export function larkCard(event: LarkEvent): LarkCard {
  const caps = capabilitiesFor('lark');
  const prepared = prepareNotification(toCanonical(event), caps);
  return larkCardParts(prepared.notification, { caps, withStatus: false }).card;
}

/**
 * @deprecated Use `larkAdapter.render` then `larkAdapter.buildRequest`.
 * Throws `Error('payload_too_large')` when no rung fits Lark's 20 KB cap, which bounded input
 * makes unreachable in practice.
 */
export async function larkPayload(event: LarkEvent, secret?: string, now = Date.now()): Promise<JsonObject> {
  const rendered = renderLark(toCanonical(event), capabilitiesFor('lark'), { statusInTitle: false });
  if (!rendered.ok) throw new Error(rendered.reason);
  const payload = rendered.message.payload;
  return secret ? { ...payload, ...(await larkSignatureFields(secret, now)) } : payload;
}
