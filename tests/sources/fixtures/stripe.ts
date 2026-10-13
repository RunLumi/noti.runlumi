/**
 * Stripe snapshot events: the documented Event envelope (docs.stripe.com/api/events/object)
 * around the documented Invoice, Dispute, Subscription and PaymentIntent examples (read
 * 2026-10-13). Nested arrays are shortened. The values that the docs show as `null` and that
 * the mapper reads (`amount_due`, `status`, `hosted_invoice_url`, ...) are filled in the way the
 * field descriptions define them. These are NOT captured from a real Stripe account.
 */
function envelope(
  id: string,
  type: string,
  object: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    object: 'event',
    api_version: '2019-02-19',
    created: 1686089970,
    data: { object, ...extra },
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
  };
}

export const INVOICE_PAYMENT_FAILED = envelope('evt_1NG8Du2eZvKYlo2CUI79vXWy', 'invoice.payment_failed', {
  id: 'in_1MtHbELkdIwHu7ixl4OzzPMv',
  object: 'invoice',
  amount_due: 2000,
  amount_paid: 0,
  attempt_count: 1,
  attempted: true,
  billing_reason: 'subscription_cycle',
  collection_method: 'charge_automatically',
  currency: 'usd',
  customer: 'cus_NeZwdNtLEOXuvB',
  // Personal data present in the real payload: must never appear in a notification.
  customer_email: 'jennyrosen@example.com',
  customer_name: 'Jenny Rosen',
  customer_phone: '+15555550100',
  hosted_invoice_url: 'https://invoice.stripe.com/i/acct_1MtHb/test_YWNjdF8x',
  livemode: false,
  next_payment_attempt: 1686690770,
  number: 'ACME-0042',
  status: 'open',
});

export const PAYMENT_INTENT_FAILED = envelope(
  'evt_3MtwBwLkdIwHu7ix28a3tqPa',
  'payment_intent.payment_failed',
  {
    id: 'pi_3MtwBwLkdIwHu7ix28a3tqPa',
    object: 'payment_intent',
    amount: 2000,
    currency: 'usd',
    customer: null,
    receipt_email: 'jennyrosen@example.com',
    livemode: false,
    status: 'requires_payment_method',
  },
);

export const DISPUTE_CREATED = envelope('evt_1MtJUT2eZvKYlo2CNaw2Hv01', 'charge.dispute.created', {
  id: 'du_1MtJUT2eZvKYlo2CNaw2HvEv',
  object: 'dispute',
  amount: 1000,
  charge: 'ch_1AZtxr2eZvKYlo2CJDX8whov',
  created: 1680651737,
  currency: 'usd',
  evidence: { customer_email_address: null, customer_name: null },
  evidence_details: { due_by: 1682294399, has_evidence: false, past_due: false, submission_count: 0 },
  is_charge_refundable: true,
  livemode: false,
  reason: 'general',
  status: 'warning_needs_response',
});

export const DISPUTE_LOST = envelope('evt_1MtJUT2eZvKYlo2CNaw2Hv02', 'charge.dispute.closed', {
  ...DISPUTE_CREATED.data.object,
  status: 'lost',
});

const subscription = {
  id: 'sub_1MowQVLkdIwHu7ixeRlqHVzs',
  object: 'subscription',
  cancel_at_period_end: false,
  collection_method: 'charge_automatically',
  created: 1679609767,
  currency: 'usd',
  customer: 'cus_Na6dX7aXxi11N4',
  latest_invoice: 'in_1MowQWLkdIwHu7ixuzkSPfKd',
  livemode: false,
  metadata: {},
  status: 'active',
};

export const SUBSCRIPTION_CREATED = envelope(
  'evt_1MowQVLkdIwHu7ixsub0001',
  'customer.subscription.created',
  subscription,
);

export const SUBSCRIPTION_PAST_DUE = envelope(
  'evt_1MowQVLkdIwHu7ixsub0002',
  'customer.subscription.updated',
  { ...subscription, status: 'past_due' },
  { previous_attributes: { status: 'active' } },
);

export const SUBSCRIPTION_METADATA_ONLY = envelope(
  'evt_1MowQVLkdIwHu7ixsub0003',
  'customer.subscription.updated',
  { ...subscription, metadata: { plan: 'pro' } },
  { previous_attributes: { metadata: {} } },
);

export const SUBSCRIPTION_CANCEL_AT_END = envelope(
  'evt_1MowQVLkdIwHu7ixsub0004',
  'customer.subscription.updated',
  { ...subscription, cancel_at_period_end: true },
  { previous_attributes: { cancel_at_period_end: false } },
);

export const SUBSCRIPTION_DELETED = envelope('evt_1MowQVLkdIwHu7ixsub0005', 'customer.subscription.deleted', {
  ...subscription,
  status: 'canceled',
});

/** The documented Event example, a type Noti does not notify about. */
export const SETUP_INTENT_CREATED = envelope('evt_1NG8Du2eZvKYlo2CUI79vXWz', 'setup_intent.created', {
  id: 'seti_1NG8Du2eZvKYlo2C9XMqbR0x',
  object: 'setup_intent',
  customer: null,
  livemode: false,
  status: 'requires_confirmation',
});

export const THIN_EVENT = {
  id: 'evt_test_61Ab',
  object: 'v2.core.event',
  type: 'v1.billing.meter.error_report_triggered',
  related_object: { id: 'mtr_test_61Ab', type: 'billing.meter', url: '/v1/billing/meters/mtr_test_61Ab' },
};
