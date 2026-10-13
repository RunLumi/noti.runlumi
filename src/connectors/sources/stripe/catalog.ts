/**
 * The closed set of Stripe notification types an integration can select (spec 06 F84–F86).
 * Deliberately limited to the money-at-risk events the task and spec name: payment failures,
 * disputes and subscription changes. A verified event of any other type is acknowledged and
 * ignored (Stripe is told 200 so it does not retry for three days).
 *
 * Snapshot payloads only. Thin events (`object: "v2.core.event"`) carry identifiers and need an
 * API read to be useful (F85 enrichment); that is not built, so they are acknowledged and ignored.
 */
export const STRIPE_EVENT_TYPES = [
  'invoice.payment_failed',
  'payment_intent.payment_failed',
  'charge.dispute.created',
  'charge.dispute.closed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
] as const;

export type StripeEventType = (typeof STRIPE_EVENT_TYPES)[number];

const KNOWN: ReadonlySet<string> = new Set(STRIPE_EVENT_TYPES);

export function isStripeEventType(value: unknown): value is StripeEventType {
  return typeof value === 'string' && KNOWN.has(value);
}
