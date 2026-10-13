/**
 * Compatibility surface for the current queue consumer in `src/index.ts`, which predates the
 * adapter contract. New code should use `larkAdapter` (./adapter) via `../index`.
 */
import { capabilitiesFor } from '../capabilities';
import type { JsonObject, NotificationStatus } from '../types';
import { larkCardParts } from './render';
import { larkSignatureFields } from './sign';

export { larkAccepted } from './classify';
export { larkSignature } from './sign';

export type LarkEvent = {
  title: string;
  url: string;
  repo?: string;
  actor?: string;
  status?: Extract<NotificationStatus, 'success' | 'failure' | 'info'>;
};

/** @deprecated Use `larkAdapter.render`, which applies the degradation ladder and DLP masking. */
export function larkCard(event: LarkEvent): JsonObject {
  return larkCardParts({ ...event, eventType: 'legacy' }, capabilitiesFor('lark')).card;
}

/** @deprecated Use `larkAdapter.render` then `larkAdapter.buildRequest`. */
export async function larkPayload(event: LarkEvent, secret?: string, now = Date.now()): Promise<JsonObject> {
  const payload: JsonObject = { msg_type: 'interactive', card: larkCard(event) };
  return secret ? { ...payload, ...(await larkSignatureFields(secret, now)) } : payload;
}
