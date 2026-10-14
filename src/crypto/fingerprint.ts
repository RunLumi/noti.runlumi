/**
 * Non-secret fingerprints (docs/specs/03-secrets-and-crypto.md F39, F34).
 *
 * Two different things, both one-way and both safe to show:
 *
 *  - {@link credentialFingerprint}: 8 characters of base32(HMAC-SHA-256(tenant key, secret)), where the
 *    tenant key is HKDF(FINGERPRINT_KEY, info = label + org id). Stored at seal time so a customer can
 *    match the credential across screens without Noti ever showing it again (F39). It is KEYED and
 *    TENANT-SCOPED on purpose: an unsalted hash of a webhook URL lets anyone who can read the column
 *    confirm a guess, and the same secret in two workspaces would show the same value. FINGERPRINT_KEY is
 *    a dedicated secret rather than a KEK derivative, so a KEK rotation does not change any fingerprint.
 *    Without the key no fingerprint is computed (null): it is display only.
 *  - {@link kekCheckValue}: HKDF-Expand over the KEK with a distinct label that includes the
 *    environment name. A public per-environment variable holds the expected value; a Worker booted with
 *    another environment's KEK computes a different one and refuses to serve credential operations
 *    (F34 `kek_environment_mismatch`). The output does not reveal the key, and the KEK is never used
 *    directly as a MAC key.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const FINGERPRINT_CHARS = 8;
export const KEK_CHECK_LABEL = 'lumi-noti/kcv/v2:';
export const FINGERPRINT_LABEL = 'lumi-noti/fp/v1\u0000';
/** 32 hex characters (128 bits) of the HMAC: long enough to be unambiguous, short enough to read. */
export const KEK_CHECK_HEX_CHARS = 32;

export type EnvironmentName = 'production' | 'staging' | 'development';
export const ENVIRONMENT_NAMES: readonly EnvironmentName[] = ['production', 'staging', 'development'];

export function isEnvironmentName(value: unknown): value is EnvironmentName {
  return typeof value === 'string' && (ENVIRONMENT_NAMES as readonly string[]).includes(value);
}

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32.charAt((value << (5 - bits)) & 31);
  return out;
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const HEX_64 = /^[0-9a-f]{64}$/i;

/** True for a usable FINGERPRINT_KEY (64 hex characters). */
export function isFingerprintKey(value: unknown): value is string {
  return typeof value === 'string' && HEX_64.test(value);
}

function hexBytes(hexString: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(32));
  for (let i = 0; i < 32; i++) out[i] = parseInt(hexString.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * `base32(HMAC-SHA-256(HKDF(FINGERPRINT_KEY, label ‖ orgId), secret))[0:8]`, or null when no usable
 * key is configured. Tenant-scoped: the same secret in two workspaces differs.
 */
export async function credentialFingerprint(
  secret: string,
  orgId: string,
  fingerprintKey: string | undefined,
): Promise<string | null> {
  if (!isFingerprintKey(fingerprintKey) || orgId === '') return null;
  const base = await crypto.subtle.importKey('raw', hexBytes(fingerprintKey), 'HKDF', false, ['deriveKey']);
  const tenantKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(new ArrayBuffer(0)),
      info: new TextEncoder().encode(FINGERPRINT_LABEL + orgId),
    },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', tenantKey, new TextEncoder().encode(secret)));
  return base32(mac).slice(0, FINGERPRINT_CHARS);
}

/**
 * The key check value of a KEK for one environment: the first {@link KEK_CHECK_HEX_CHARS} hex
 * characters of HKDF-SHA-256(ikm = KEK, salt = empty, info = "lumi-noti/kcv/v2:" + environment).
 * Operators compute it with `scripts/kek-destroy-check.mjs check-value` (docs/RUNBOOK.md) and store
 * it in `KEK_CHECK_V<n>`.
 */
export async function kekCheckValue(
  kek: Uint8Array<ArrayBuffer>,
  environment: EnvironmentName,
): Promise<string> {
  const base = await crypto.subtle.importKey('raw', kek, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(new ArrayBuffer(0)),
      info: new TextEncoder().encode(KEK_CHECK_LABEL + environment),
    },
    base,
    KEK_CHECK_HEX_CHARS * 4,
  );
  return hex(new Uint8Array(bits));
}
