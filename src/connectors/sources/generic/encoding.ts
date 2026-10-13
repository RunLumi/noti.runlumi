/**
 * Pure encoding and generation helpers for generic-source secrets. No D1, no Worker types:
 * the dashboard's tests import this module, so it must stay importable from the web project.
 */
export const SECRET_PREFIX = 'whsec_';
const SECRET_BYTES = 32;

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Strict standard-alphabet base64 decode; null on any malformed input. */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  try {
    const binary = atob(text);
    const out = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** A fresh signing secret from the platform CSPRNG: 32 random bytes, whsec_ + base64. */
export function generateSigningSecret(): string {
  return SECRET_PREFIX + toBase64(crypto.getRandomValues(new Uint8Array(new ArrayBuffer(SECRET_BYTES))));
}

/** The public, non-secret ingest identifier: 18 random bytes as 24 base64url characters. */
export function generateEndpointId(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(new ArrayBuffer(18))))
    .replaceAll('+', '-')
    .replaceAll('/', '_');
}

/** True for a well-formed `whsec_` secret: strict base64 of at least 32 bytes (Standard Webhooks). */
export function isSigningSecret(secret: string): boolean {
  if (!secret.startsWith(SECRET_PREFIX) || secret.length > 256) return false;
  const bytes = fromBase64(secret.slice(SECRET_PREFIX.length));
  return bytes !== null && bytes.length >= SECRET_BYTES;
}
