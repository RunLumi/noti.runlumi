import type { EndpointSourceConnector, FieldError, SecretInput } from '../types';
import { STRIPE_EVENT_TYPES } from './catalog';
import { mapStripe } from './map';
import { STRIPE_TOLERANCE_SECONDS, verifyStripe } from './verify';

/**
 * Stripe source (spec 06 F84–F86, ADR 0015), snapshot payloads. Stripe generates the endpoint
 * signing secret (`whsec_...`, shown in Workbench), so it is pasted here and sealed on write.
 * Test and live endpoints have different secrets and are different sources (`livemode`).
 */

/** Stripe events are a few KiB; an invoice with many lines is the large case. */
const MAX_BODY_BYTES = 512 * 1024;

// UNVERIFIED character set of the secret beyond the documented `whsec_` prefix: accept the
// base64/hex/underscore/hyphen alphabets and bound the length.
const SIGNING_SECRET = /^whsec_[A-Za-z0-9_+/=-]{16,200}$/;

function parseSecret(body: Record<string, unknown>, mode: 'create' | 'rotate'): SecretInput {
  const errors: FieldError[] = [];
  const secret = body.secret;
  if (typeof secret !== 'string' || !SIGNING_SECRET.test(secret))
    errors.push({
      field: 'secret',
      message: 'A Stripe signing secret starts with whsec_. Copy it from the endpoint in Stripe Workbench.',
    });
  let livemode: boolean | null = null;
  if (mode === 'create') {
    if (typeof body.livemode !== 'boolean')
      errors.push({ field: 'livemode', message: 'Say whether this endpoint receives live or test events.' });
    else livemode = body.livemode;
  } else if ('livemode' in body) {
    errors.push({ field: 'livemode', message: 'Test or live cannot be changed. Create another source.' });
  }
  if ('authMode' in body) errors.push({ field: 'authMode', message: 'Not used for Stripe.' });
  if (errors.length > 0 || typeof secret !== 'string') return { ok: false, errors };
  return { ok: true, secret, authMode: null, livemode };
}

export const stripeConnector: EndpointSourceConnector = {
  kind: 'stripe',
  label: 'Stripe',
  adapterVersion: '1.0.0',
  // Connect/account ids are never read, so the source is the product, not a tenant.
  canonicalSource: () => 'urn:lumi:noti:stripe',
  maxBodyBytes: MAX_BODY_BYTES,
  tenantResolution: 'endpoint',
  credentialScope: 'source',
  replayWindowSeconds: STRIPE_TOLERANCE_SECONDS,
  idempotencyKey: 'event id in the body',
  ack: {
    // Stripe retries a 429 with backoff for up to three days, so asking it to retry loses nothing.
    onFlood: 'reject',
    providerRetries: true,
    ignored: 200,
  },
  eventCatalog: STRIPE_EVENT_TYPES,
  parseSecret,
  verify: verifyStripe,
  map: mapStripe,
  decoy: { secret: `whsec_${'z'.repeat(32)}`, authMode: null },
};
