import { ApiError, type DestinationKind } from '../lib/api';
import { describeError, type UserError } from '../integrations/errors';
import { DESTINATIONS } from '../integrations/destinations';
import { en, type MessageId } from '../i18n/messages.en';
import { t } from '../i18n';
import type { DeliveryError, DeliveryState } from './api';

export const STATE_LABEL: Readonly<Record<DeliveryState, MessageId>> = {
  pending: 'delivery.state.pending',
  claimed: 'delivery.state.claimed',
  sent: 'delivery.state.sent',
  accepted: 'delivery.state.accepted',
  retrying: 'delivery.state.retrying',
  dead_lettered: 'delivery.state.dead_lettered',
  suppressed: 'delivery.state.suppressed',
};

export const STATE_MEANING: Readonly<Record<DeliveryState, MessageId>> = {
  pending: 'delivery.state.pending.meaning',
  claimed: 'delivery.state.claimed.meaning',
  sent: 'delivery.state.sent.meaning',
  accepted: 'delivery.state.accepted.meaning',
  retrying: 'delivery.state.retrying.meaning',
  dead_lettered: 'delivery.state.dead_lettered.meaning',
  suppressed: 'delivery.state.suppressed.meaning',
};

function isMessageId(key: string): key is MessageId {
  return Object.prototype.hasOwnProperty.call(en, key);
}

/** Display name for a destination kind; a generic phrase when the integration is gone. */
export function destinationName(kind: DestinationKind | null): string {
  return kind ? t(DESTINATIONS[kind].name) : 'the destination';
}

/**
 * The failure sentence for a delivery. The server picks the message id; the words come from
 * our catalogue, so provider text can never reach the screen (F220). `null` when the code
 * has no user copy, in which case the caller shows only the generic line.
 */
export function failureCopy(error: DeliveryError, kind: DestinationKind | null): string | null {
  if (error.messageKey === null || !isMessageId(error.messageKey)) return null;
  return t(error.messageKey, { destination: destinationName(kind) });
}

/** Errors on this screen. A 404 or 409 here is about a delivery, not an integration. */
export function describeDeliveryError(error: unknown): UserError {
  if (error instanceof ApiError) {
    if (error.status === 404)
      return { message: t('deliveries.error.notFound'), reference: t('error.reference', { status: '404' }) };
    if (error.status === 409)
      // Our own text for this route is user-safe and says why (not failed, deletion pending,
      // original no longer available); it never echoes input.
      return { message: error.message, reference: t('error.reference', { status: '409' }) };
  }
  return describeError(error);
}
