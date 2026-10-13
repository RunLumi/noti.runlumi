import { fromBase64 } from './encoding';

/**
 * Standard Webhooks verification (standard-webhooks/standard-webhooks, spec/standard-webhooks.md,
 * read 2026-10-13):
 *
 *   signed content = `${webhook-id}.${webhook-timestamp}.${raw body}`
 *   webhook-signature = space-delimited list of `v1,<base64 HMAC-SHA256>`
 *
 * Only `v1` (symmetric) is accepted; `v1a` (asymmetric) entries are ignored, never
 * mistaken for a match. The HMAC is computed over RAW bytes and compared with
 * `crypto.subtle.verify`, which is constant-time. Any malformed input is a plain failure.
 */

/** Replay window, both directions (clock skew and late delivery). */
export const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;
/** A header carrying more entries than this is hostile, not a rotation overlap. */
const MAX_SIGNATURES = 10;
const MAX_ID_LENGTH = 128;
const MAX_SIGNATURE_HEADER = 2048;
// No '.', which delimits the signed content (spec F74: a '.' in the id or timestamp is
// rejected before any HMAC).
const ID = /^[A-Za-z0-9_:-]+$/;

export interface SignedHeaders {
  readonly id: string | null;
  readonly timestamp: string | null;
  readonly signature: string | null;
}

export type SignatureFailure = 'malformed' | 'stale' | 'mismatch';

/** A valid id: bounded, no NUL, no characters that could blur the signed-content separators. */
export function isValidWebhookId(id: string | null): id is string {
  return id !== null && id.length > 0 && id.length <= MAX_ID_LENGTH && ID.test(id);
}

/** Whole seconds since the epoch, digits only; anything else is malformed. */
export function parseTimestamp(value: string | null): number | null {
  if (value === null || !/^\d{1,12}$/.test(value)) return null;
  return Number(value);
}

/** Candidate signatures: decoded `v1` entries, at most MAX_SIGNATURES entries in the header. */
export function parseSignatures(header: string | null): Uint8Array<ArrayBuffer>[] | null {
  if (header === null || header.length === 0 || header.length > MAX_SIGNATURE_HEADER) return null;
  const parts = header.split(' ').filter((p) => p.length > 0);
  if (parts.length === 0 || parts.length > MAX_SIGNATURES) return null;
  const out: Uint8Array<ArrayBuffer>[] = [];
  for (const part of parts) {
    const comma = part.indexOf(',');
    if (comma < 0 || part.slice(0, comma) !== 'v1') continue;
    const bytes = fromBase64(part.slice(comma + 1));
    if (bytes && bytes.length === 32) out.push(bytes);
  }
  return out.length > 0 ? out : null;
}

/** Concatenate `id.timestamp.` and the raw body without decoding the body. */
export function signedContent(id: string, timestamp: string, body: Uint8Array): Uint8Array<ArrayBuffer> {
  const prefix = new TextEncoder().encode(`${id}.${timestamp}.`);
  const out = new Uint8Array(new ArrayBuffer(prefix.length + body.length));
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
}

function hmacKey(secret: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** Compute the `v1` signature a sender would produce. Used by tests. */
export async function sign(
  secret: Uint8Array<ArrayBuffer>,
  id: string,
  timestamp: string,
  body: Uint8Array,
): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), signedContent(id, timestamp, body));
  let binary = '';
  for (const b of new Uint8Array(mac)) binary += String.fromCharCode(b);
  return `v1,${btoa(binary)}`;
}

/**
 * Verify the three headers against the raw body. `nowSeconds` is injected for tests. Every
 * candidate signature is checked (no early exit on the first match or mismatch) so timing
 * does not reveal which position matched.
 */
export async function verifyStandardWebhook(
  secret: Uint8Array<ArrayBuffer>,
  headers: SignedHeaders,
  body: Uint8Array,
  nowSeconds: number,
): Promise<{ ok: true } | { ok: false; reason: SignatureFailure }> {
  const timestamp = parseTimestamp(headers.timestamp);
  const signatures = parseSignatures(headers.signature);
  if (!isValidWebhookId(headers.id) || timestamp === null || headers.timestamp === null || !signatures)
    return { ok: false, reason: 'malformed' };

  const key = await hmacKey(secret);
  const content = signedContent(headers.id, headers.timestamp, body);
  let matched = false;
  for (const candidate of signatures) {
    if (await crypto.subtle.verify('HMAC', key, candidate, content)) matched = true;
  }
  if (!matched) return { ok: false, reason: 'mismatch' };
  if (Math.abs(nowSeconds - timestamp) > TIMESTAMP_TOLERANCE_SECONDS) return { ok: false, reason: 'stale' };
  return { ok: true };
}
