import { asRecord } from '../../../lib/json';
import { child, clean, joinSummary, safeHttpsUrl } from '../text';
import type { Display, MapInput, MapResult } from '../types';
import { isStripeEventType, type StripeEventType } from './catalog';

/**
 * Stripe snapshot event to canonical display fields. Field names are those of the documented
 * Event, Invoice, Dispute, Subscription and PaymentIntent objects (docs.stripe.com/api/events/
 * object, /disputes/object, /invoices/object, /subscriptions/object, /payment_intents/object,
 * read 2026-10-13); the test fixtures are those examples.
 *
 * PRIVACY: a notification carries object ids, amount, currency, a status and a reason code.
 * Never a customer name, email, phone, address, description, metadata or card detail, even
 * though `invoice.customer_email` and `customer_name` are present in the payload.
 *
 * UNVERIFIED: `data.previous_attributes` keys for `customer.subscription.updated` beyond the
 * documented "names of the updated attributes and their values prior to the event"; and that
 * Stripe puts `account` on Connect events (Connect events are ignored either way).
 */

type Mapped = Display & { readonly eventType: StripeEventType };

const ID = /^[A-Za-z0-9_]{3,100}$/;
const ENUM = /^[a-z0-9_]{1,40}$/;
const CURRENCY = /^[A-Za-z]{3}$/;

const ident = (v: unknown): string => (typeof v === 'string' && ID.test(v) ? v : '');
const enumValue = (v: unknown): string => (typeof v === 'string' && ENUM.test(v) ? v : '');
const day = (seconds: unknown): string =>
  typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 && seconds < 4e9
    ? new Date(seconds * 1000).toISOString().slice(0, 10)
    : '';

/** Stripe documents ISK and UGX as two-decimal in the API although ISO 4217 says zero. */
const TWO_DECIMAL_EXCEPTIONS: ReadonlySet<string> = new Set(['ISK', 'UGX']);

/**
 * `amount` is in the currency's minor unit. The number of decimals comes from the platform's
 * ISO 4217 data (so JPY is 0 and KWD is 3), except for the two currencies Stripe documents as
 * two-decimal. An unknown currency falls back to the raw minor-unit number, never a guess.
 */
export function formatAmount(amount: unknown, currency: unknown): string {
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || typeof currency !== 'string') return '';
  if (!CURRENCY.test(currency)) return '';
  const code = currency.toUpperCase();
  let digits: number;
  try {
    digits = TWO_DECIMAL_EXCEPTIONS.has(code)
      ? 2
      : (new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions()
          .maximumFractionDigits ?? 2);
  } catch {
    return `${amount} ${code} (minor units)`;
  }
  return `${(amount / 10 ** digits).toFixed(digits)} ${code}`;
}

function invoicePaymentFailed(obj: Record<string, unknown>): Mapped {
  const attempt = typeof obj.attempt_count === 'number' && obj.attempt_count > 0 ? obj.attempt_count : 0;
  const retry = day(obj.next_payment_attempt);
  return {
    eventType: 'invoice.payment_failed',
    title: 'Invoice payment failed',
    url: safeHttpsUrl(obj.hosted_invoice_url, ['stripe.com']),
    status: 'failure',
    summary: joinSummary([
      formatAmount(obj.amount_due, obj.currency),
      clean(obj.number, 40) || ident(obj.id),
      attempt > 0 && `attempt ${attempt}`,
      retry && `next retry ${retry}`,
      ident(obj.customer),
    ]),
  };
}

function paymentIntentFailed(obj: Record<string, unknown>): Mapped {
  return {
    eventType: 'payment_intent.payment_failed',
    title: 'Payment failed',
    url: '',
    status: 'failure',
    summary: joinSummary([formatAmount(obj.amount, obj.currency), ident(obj.id), ident(obj.customer)]),
  };
}

function disputeCreated(obj: Record<string, unknown>): Mapped {
  const due = day(child(obj, 'evidence_details')?.due_by);
  return {
    eventType: 'charge.dispute.created',
    title: 'Dispute opened',
    url: '',
    status: 'failure',
    summary: joinSummary([
      formatAmount(obj.amount, obj.currency),
      enumValue(obj.reason) && `reason ${enumValue(obj.reason)}`,
      due && `respond by ${due}`,
      ident(obj.id),
    ]),
  };
}

function disputeClosed(obj: Record<string, unknown>): Mapped {
  const status = enumValue(obj.status);
  return {
    eventType: 'charge.dispute.closed',
    title: status ? `Dispute ${status.replaceAll('_', ' ')}` : 'Dispute closed',
    url: '',
    status: status === 'won' ? 'success' : status === 'lost' ? 'failure' : 'info',
    summary: joinSummary([formatAmount(obj.amount, obj.currency), ident(obj.id)]),
  };
}

const BAD_SUBSCRIPTION = new Set(['past_due', 'unpaid', 'incomplete_expired']);

function subscriptionStatusKind(status: string): Display['status'] {
  if (BAD_SUBSCRIPTION.has(status)) return 'failure';
  return status === 'canceled' ? 'warning' : 'info';
}

function subscriptionBase(obj: Record<string, unknown>, extra: (string | false)[] = []): string {
  const status = enumValue(obj.status);
  return joinSummary([status && `status ${status}`, ...extra, ident(obj.id), ident(obj.customer)]);
}

function subscriptionCreated(obj: Record<string, unknown>): Mapped {
  return {
    eventType: 'customer.subscription.created',
    title: 'Subscription created',
    url: '',
    status: 'info',
    summary: subscriptionBase(obj),
  };
}

function subscriptionDeleted(obj: Record<string, unknown>): Mapped {
  return {
    eventType: 'customer.subscription.deleted',
    title: 'Subscription canceled',
    url: '',
    status: 'warning',
    summary: subscriptionBase(obj),
  };
}

/** Only a change of status or of cancel-at-period-end is worth a message; metadata edits are not. */
function subscriptionUpdated(
  obj: Record<string, unknown>,
  previous: Record<string, unknown> | null,
): Mapped | null {
  if (!previous) return null;
  const status = enumValue(obj.status);
  const before = enumValue(previous.status);
  const statusChanged = 'status' in previous && before !== status && status !== '';
  const cancelChanged = 'cancel_at_period_end' in previous && typeof obj.cancel_at_period_end === 'boolean';
  if (!statusChanged && !cancelChanged) return null;
  if (statusChanged) {
    return {
      eventType: 'customer.subscription.updated',
      title: `Subscription ${before ? `${before.replaceAll('_', ' ')} → ` : 'now '}${status.replaceAll('_', ' ')}`,
      url: '',
      ...statusField(subscriptionStatusKind(status)),
      summary: subscriptionBase(obj),
    };
  }
  const cancelling = obj.cancel_at_period_end === true;
  return {
    eventType: 'customer.subscription.updated',
    title: cancelling ? 'Subscription set to cancel at period end' : 'Subscription cancellation withdrawn',
    url: '',
    status: cancelling ? 'warning' : 'info',
    summary: subscriptionBase(obj),
  };
}

export function mapStripe(input: MapInput): MapResult {
  const body = asRecord(input.body);
  if (!body) return { outcome: 'reject', status: 400, reason: 'invalid_body' };
  if (body.object === 'v2.core.event') return { outcome: 'ignore', reason: 'thin_event_not_supported' };
  const eventId = ident(body.id);
  if (
    body.object !== 'event' ||
    !eventId ||
    typeof body.type !== 'string' ||
    typeof body.livemode !== 'boolean'
  )
    return { outcome: 'reject', status: 400, reason: 'invalid_event' };
  // Test and live are separate sources. An event for the other mode is authentic but must never
  // reach this source's chats; it is dropped with a 2xx so Stripe does not retry it for days.
  if (input.source.livemode !== null && input.source.livemode !== body.livemode)
    return { outcome: 'ignore', reason: 'livemode_mismatch' };
  if (typeof body.account === 'string') return { outcome: 'ignore', reason: 'connect_event_not_supported' };
  if (!isStripeEventType(body.type)) return { outcome: 'ignore', reason: 'event_not_supported' };
  const data = child(body, 'data');
  const obj = child(data, 'object');
  if (!obj) return { outcome: 'reject', status: 400, reason: 'invalid_event' };

  let mapped: Mapped | null;
  switch (body.type) {
    case 'invoice.payment_failed':
      mapped = invoicePaymentFailed(obj);
      break;
    case 'payment_intent.payment_failed':
      mapped = paymentIntentFailed(obj);
      break;
    case 'charge.dispute.created':
      mapped = disputeCreated(obj);
      break;
    case 'charge.dispute.closed':
      mapped = disputeClosed(obj);
      break;
    case 'customer.subscription.created':
      mapped = subscriptionCreated(obj);
      break;
    case 'customer.subscription.deleted':
      mapped = subscriptionDeleted(obj);
      break;
    case 'customer.subscription.updated':
      mapped = subscriptionUpdated(obj, child(data, 'previous_attributes'));
      break;
  }
  return mapped
    ? { outcome: 'deliver', display: mapped, eventId }
    : { outcome: 'ignore', reason: 'update_not_notable' };
}

/** `exactOptionalPropertyTypes`: an absent status is omitted, never written as `undefined`. */
function statusField(status: Display['status']): { status?: NonNullable<Display['status']> } {
  return status === undefined ? {} : { status };
}
