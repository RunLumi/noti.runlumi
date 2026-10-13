import type { VerifyInput, VerifyResult } from '../types';

/**
 * Stripe webhook verification. Source: docs.stripe.com/webhooks, "Verify webhook signatures
 * manually" (read 2026-10-13); spec 06 F84.
 *
 *   Stripe-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>[,v1=...][,v0=<test decoy>]
 *   signed_payload  = `${t}.${raw body}`
 *   key             = the endpoint's `whsec_...` signing secret, used AS A STRING (UTF-8 bytes).
 *
 * IMPORTANT, and the opposite of Standard Webhooks: both use the `whsec_` prefix, but Standard
 * Webhooks base64-DECODES the remainder to get the key and Stripe does NOT. Do not "share a
 * helper" between the two verifiers; `tests/sources/stripe.test.ts` runs one payload through
 * both and expects opposite outcomes so that refactor fails loudly.
 *
 * Only `v1` is accepted ("To prevent downgrade attacks, ignore all schemes that aren't v1");
 * Stripe sends a fake `v0` on test events. Several `v1` entries are normal while a secret is
 * being rolled (one signature per active secret), and all are checked. Comparison is
 * `crypto.subtle.verify` (constant time) over the raw bytes. The timestamp is inside the signed
 * payload, so it cannot be changed without invalidating the signature; the 5 minute tolerance
 * is Stripe's library default, and zero is not configurable.
 */
export const STRIPE_TOLERANCE_SECONDS = 5 * 60;
const MAX_HEADER = 1024;
const MAX_V1 = 10;
const TIMESTAMP = /^\d{1,12}$/;
const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export interface ParsedStripeSignature {
  readonly timestamp: string;
  readonly signatures: readonly string[];
}

export function parseStripeSignature(header: string | null): ParsedStripeSignature | null {
  if (header === null || header.length === 0 || header.length > MAX_HEADER) return null;
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const element of header.split(',')) {
    const eq = element.indexOf('=');
    if (eq < 0) continue;
    const prefix = element.slice(0, eq).trim();
    const value = element.slice(eq + 1).trim();
    if (prefix === 't' && timestamp === null) timestamp = value;
    else if (prefix === 'v1' && HEX_SHA256.test(value) && signatures.length < MAX_V1) signatures.push(value);
    // Every other scheme (v0, v2, ...) is ignored, never matched.
  }
  if (timestamp === null || !TIMESTAMP.test(timestamp) || signatures.length === 0) return null;
  return { timestamp, signatures };
}

export async function verifyStripe(input: VerifyInput): Promise<VerifyResult> {
  const parsed = parseStripeSignature(input.headers.get('stripe-signature'));
  if (!parsed) return { ok: false, reason: 'malformed' };
  const prefix = new TextEncoder().encode(`${parsed.timestamp}.`);
  const payload = new Uint8Array(new ArrayBuffer(prefix.length + input.raw.length));
  payload.set(prefix, 0);
  payload.set(input.raw, prefix.length);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(input.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  let matched = false;
  for (const candidate of parsed.signatures) {
    if (await crypto.subtle.verify('HMAC', key, fromHex(candidate), payload)) matched = true;
  }
  if (!matched) return { ok: false, reason: 'mismatch' };
  if (Math.abs(input.nowSeconds - Number(parsed.timestamp)) > STRIPE_TOLERANCE_SECONDS)
    return { ok: false, reason: 'stale' };
  // Neither the signature nor the timestamp is identity (they change on every retry): the
  // event id comes from the body, in `map`.
  return { ok: true, eventId: null };
}
