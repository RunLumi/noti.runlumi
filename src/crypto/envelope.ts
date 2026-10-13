/**
 * Envelope encryption for stored credentials (docs/specs/03-secrets-and-crypto.md F33–F37).
 *
 *   KEK (Worker secret, never in D1)
 *     └─ HKDF(salt = key_salt, info = purpose ‖ org ‖ "lumi-noti/tk/v1") ─▶ tenant key  [F35]
 *           └─ AES-GCM(+AAD field=dek) wraps ─▶ per-connection DEK (dek_wrapped)
 *                 └─ AES-GCM(+AAD field=url|signing_secret) ─▶ field envelopes         [F36]
 *
 * `seal` and `open` are the only entry points that encrypt or decrypt a field. The
 * connection-key helpers below are the only code that touches the KEK.
 */

/** Byte array backed by a real ArrayBuffer, as `crypto.subtle` requires since TS 5.7. */
export type Bytes = Uint8Array<ArrayBuffer>;

export type CryptoErrorCode =
  'malformed_envelope' | 'destination_credentials_invalid' | 'unknown_kek_version' | 'config_invalid';

/** Carries a taxonomy code only. Never a key, plaintext, AAD or ciphertext. */
export class CryptoError extends Error {
  constructor(readonly code: CryptoErrorCode) {
    super(code);
    this.name = 'CryptoError';
  }
}

export type SealField = 'url' | 'signing_secret' | 'dek';
export type SealPurpose = 'destination' | 'source.signing';

export interface SealContext {
  /** Server-resolved organization id. Never client supplied. */
  readonly orgId: string;
  /** Our row id for the connection (`integrations.id`). */
  readonly connectionId: string;
  readonly field: SealField;
  readonly purpose: SealPurpose;
}

export interface Envelope {
  readonly formatVersion: 1;
  /**
   * For a wrapped DEK: the KEK version that wrapped it (authoritative for unwrapping).
   * For a field sealed under a DEK: always 0. The DEK, not the KEK, is the field key, so a
   * KEK rotation rewraps the DEK without touching field envelopes (F37).
   */
  readonly kekVersion: number;
  readonly iv: Bytes;
  readonly ciphertext: Bytes;
}

const FORMAT_VERSION = 0x01;
const HEADER_BYTES = 18;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** A webhook URL or signing secret is ~100 bytes. Anything near this is a bug (F33). */
export const MAX_PLAINTEXT_BYTES = 8 * 1024;
/** Field envelopes are sealed under a DEK, not a KEK. See `Envelope.kekVersion`. */
export const FIELD_KEK_VERSION = 0;

const AAD_PREFIX = 'lumi-noti/aad/v1';
const TK_INFO_SUFFIX = 'lumi-noti/tk/v1';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function utf8(value: string): Bytes {
  const encoded = encoder.encode(value);
  const out = new Uint8Array(new ArrayBuffer(encoded.length));
  out.set(encoded);
  return out;
}

function randomBytes(length: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(new ArrayBuffer(length)));
}

/** Join parts with 0x00 separators. Rejects a part that itself contains NUL (F36). */
function joinZeroSeparated(parts: readonly string[]): Bytes {
  for (const part of parts) {
    if (part.length === 0 || part.includes('\u0000')) throw new CryptoError('config_invalid');
  }
  return utf8(parts.join('\u0000'));
}

/** The single AAD construction site (F36). Every component is an identifier we minted. */
export function buildAad(ctx: SealContext): Bytes {
  return joinZeroSeparated([AAD_PREFIX, ctx.orgId, ctx.connectionId, ctx.field, ctx.purpose]);
}

/** HKDF `info` for the tenant key. Purpose separates keys derived from one (KEK, salt). */
export function tenantKeyInfo(orgId: string, purpose: SealPurpose): Bytes {
  return joinZeroSeparated([purpose, orgId, TK_INFO_SUFFIX]);
}

export function encodeEnvelope(envelope: Envelope): Bytes {
  if (envelope.iv.length !== IV_BYTES) throw new CryptoError('malformed_envelope');
  if (!Number.isInteger(envelope.kekVersion) || envelope.kekVersion < 0 || envelope.kekVersion > 0xffffffff)
    throw new CryptoError('malformed_envelope');
  const out = new Uint8Array(new ArrayBuffer(HEADER_BYTES + envelope.ciphertext.length));
  const view = new DataView(out.buffer);
  view.setUint8(0, FORMAT_VERSION);
  view.setUint8(1, 0);
  view.setUint32(2, envelope.kekVersion, false);
  out.set(envelope.iv, 6);
  out.set(envelope.ciphertext, HEADER_BYTES);
  return out;
}

/** Strict parse: any deviation is `malformed_envelope`, never a partial read (F33). */
export function decodeEnvelope(bytes: Uint8Array): Envelope {
  if (bytes.length < HEADER_BYTES + TAG_BYTES) throw new CryptoError('malformed_envelope');
  if (bytes[0] !== FORMAT_VERSION || bytes[1] !== 0) throw new CryptoError('malformed_envelope');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    formatVersion: 1,
    kekVersion: view.getUint32(2, false),
    iv: copy(bytes.subarray(6, HEADER_BYTES)),
    ciphertext: copy(bytes.subarray(HEADER_BYTES)),
  };
}

function copy(view: Uint8Array): Bytes {
  const out = new Uint8Array(new ArrayBuffer(view.length));
  out.set(view);
  return out;
}

async function gcmEncrypt(key: CryptoKey, plaintext: Bytes, aad: Bytes): Promise<{ iv: Bytes; ct: Bytes }> {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plaintext);
  return { iv, ct: new Uint8Array(ct) };
}

async function gcmDecrypt(key: CryptoKey, envelope: Envelope, aad: Bytes): Promise<Bytes> {
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: envelope.iv, additionalData: aad },
      key,
      envelope.ciphertext,
    );
    return new Uint8Array(pt);
  } catch {
    // Wrong key and wrong AAD are indistinguishable at the primitive; both are permanent.
    throw new CryptoError('destination_credentials_invalid');
  }
}

/** Seal one credential field under a connection DEK. */
export async function seal(dek: CryptoKey, plaintext: string, ctx: SealContext): Promise<Bytes> {
  if (ctx.field === 'dek') throw new CryptoError('config_invalid');
  const bytes = utf8(plaintext);
  if (bytes.length === 0 || bytes.length > MAX_PLAINTEXT_BYTES) throw new CryptoError('config_invalid');
  const { iv, ct } = await gcmEncrypt(dek, bytes, buildAad(ctx));
  return encodeEnvelope({ formatVersion: 1, kekVersion: FIELD_KEK_VERSION, iv, ciphertext: ct });
}

/** Open one credential field. Throws `CryptoError`; never returns partial plaintext. */
export async function open(dek: CryptoKey, envelopeBytes: Uint8Array, ctx: SealContext): Promise<string> {
  if (ctx.field === 'dek') throw new CryptoError('config_invalid');
  const envelope = decodeEnvelope(envelopeBytes);
  if (envelope.kekVersion !== FIELD_KEK_VERSION) throw new CryptoError('malformed_envelope');
  const plaintext = await gcmDecrypt(dek, envelope, buildAad(ctx));
  try {
    return decoder.decode(plaintext);
  } catch {
    throw new CryptoError('malformed_envelope');
  }
}

// ---------------------------------------------------------------------------
// Key ring: the KEKs this Worker holds, by version (F34, F37).
// ---------------------------------------------------------------------------

export interface Keyring {
  readonly activeVersion: number;
  /** Raw KEK bytes for exactly the requested version, or `unknown_kek_version`. */
  kek(version: number): Bytes;
}

export function parseKeyHex(hex: string): Bytes {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new CryptoError('config_invalid');
  const out = new Uint8Array(new ArrayBuffer(KEY_BYTES));
  for (let i = 0; i < KEY_BYTES; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Build a key ring from versioned hex secrets. `open` resolves only the version an
 * envelope names; there is no fallback to another version (F37).
 */
export function createKeyring(activeVersion: number, keys: ReadonlyMap<number, string>): Keyring {
  if (!Number.isInteger(activeVersion) || activeVersion < 1) throw new CryptoError('config_invalid');
  const parsed = new Map<number, Bytes>();
  for (const [version, hex] of keys) parsed.set(version, parseKeyHex(hex));
  if (!parsed.has(activeVersion)) throw new CryptoError('config_invalid');
  return {
    activeVersion,
    kek(version: number): Bytes {
      const key = parsed.get(version);
      if (!key) throw new CryptoError('unknown_kek_version');
      return key;
    },
  };
}

async function deriveTenantKey(
  kek: Bytes,
  salt: Bytes,
  orgId: string,
  purpose: SealPurpose,
): Promise<CryptoKey> {
  if (salt.length !== SALT_BYTES) throw new CryptoError('malformed_envelope');
  const base = await crypto.subtle.importKey('raw', kek, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: tenantKeyInfo(orgId, purpose) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function importDek(raw: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export interface ConnectionKeyMaterial {
  readonly orgId: string;
  readonly connectionId: string;
  readonly purpose: SealPurpose;
  /** 16 random bytes, stored in the clear next to the ciphertext. */
  readonly keySalt: Bytes;
  /** The DEK, wrapped under the tenant key. Its envelope names the KEK version. */
  readonly dekWrapped: Bytes;
  readonly kekVersion: number;
}

function dekContext(m: Pick<ConnectionKeyMaterial, 'orgId' | 'connectionId' | 'purpose'>): SealContext {
  return { orgId: m.orgId, connectionId: m.connectionId, field: 'dek', purpose: m.purpose };
}

async function wrapDek(
  keyring: Keyring,
  version: number,
  rawDek: Bytes,
  keySalt: Bytes,
  ids: Pick<ConnectionKeyMaterial, 'orgId' | 'connectionId' | 'purpose'>,
): Promise<Bytes> {
  const tk = await deriveTenantKey(keyring.kek(version), keySalt, ids.orgId, ids.purpose);
  const { iv, ct } = await gcmEncrypt(tk, rawDek, buildAad(dekContext(ids)));
  return encodeEnvelope({ formatVersion: 1, kekVersion: version, iv, ciphertext: ct });
}

/** Fresh key material for a new connection, wrapped under the active KEK. */
export async function createConnectionKeys(
  keyring: Keyring,
  ids: { orgId: string; connectionId: string; purpose: SealPurpose },
): Promise<{ material: ConnectionKeyMaterial; dek: CryptoKey }> {
  const rawDek = randomBytes(KEY_BYTES);
  const keySalt = randomBytes(SALT_BYTES);
  const version = keyring.activeVersion;
  const dekWrapped = await wrapDek(keyring, version, rawDek, keySalt, ids);
  const dek = await importDek(rawDek);
  rawDek.fill(0);
  return { material: { ...ids, keySalt, dekWrapped, kekVersion: version }, dek };
}

async function unwrapRawDek(keyring: Keyring, material: ConnectionKeyMaterial): Promise<Bytes> {
  const envelope = decodeEnvelope(material.dekWrapped);
  // The envelope's version is authoritative; a disagreeing row column is an alert, not a choice.
  if (envelope.kekVersion !== material.kekVersion) throw new CryptoError('malformed_envelope');
  const tk = await deriveTenantKey(
    keyring.kek(envelope.kekVersion),
    material.keySalt,
    material.orgId,
    material.purpose,
  );
  const raw = await gcmDecrypt(tk, envelope, buildAad(dekContext(material)));
  if (raw.length !== KEY_BYTES) throw new CryptoError('malformed_envelope');
  return raw;
}

/** Unwrap a connection's DEK as a non-extractable key. */
export async function unwrapConnectionKey(
  keyring: Keyring,
  material: ConnectionKeyMaterial,
): Promise<CryptoKey> {
  const raw = await unwrapRawDek(keyring, material);
  const key = await importDek(raw);
  raw.fill(0);
  return key;
}

/**
 * Rewrap a DEK under the active KEK (F37). Field envelopes are untouched, which is the
 * point of the DEK layer: rotation moves 64-byte wrapped keys, not every credential.
 */
export async function rewrapConnectionKey(
  keyring: Keyring,
  material: ConnectionKeyMaterial,
): Promise<ConnectionKeyMaterial> {
  const raw = await unwrapRawDek(keyring, material);
  const version = keyring.activeVersion;
  const dekWrapped = await wrapDek(keyring, version, raw, material.keySalt, material);
  raw.fill(0);
  return { ...material, dekWrapped, kekVersion: version };
}

// ---------------------------------------------------------------------------
// v0 legacy format (pre-F33): base64 TEXT of iv‖ciphertext, one key, no AAD.
// Kept readable until the migration job reports zero v0 rows (F37). Do not use for writes.
// ---------------------------------------------------------------------------

export async function openLegacyV0(ciphertextBase64: string, keyHex: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', parseKeyHex(keyHex), 'AES-GCM', false, ['decrypt']);
  let bytes: Bytes;
  try {
    const binary = atob(ciphertextBase64);
    bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    throw new CryptoError('malformed_envelope');
  }
  if (bytes.length < IV_BYTES + TAG_BYTES) throw new CryptoError('malformed_envelope');
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES) },
      key,
      bytes.slice(IV_BYTES),
    );
    return decoder.decode(pt);
  } catch {
    throw new CryptoError('destination_credentials_invalid');
  }
}

/** D1 returns BLOB columns as `number[]`; normalise every shape we may see to bytes. */
export function toBytes(value: unknown): Bytes | null {
  if (value === null || value === undefined) return null;
  if (value instanceof ArrayBuffer) return copy(new Uint8Array(value));
  if (value instanceof Uint8Array) return copy(value);
  if (Array.isArray(value) && value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const out = new Uint8Array(new ArrayBuffer(value.length));
    out.set(value as number[]);
    return out;
  }
  throw new CryptoError('malformed_envelope');
}
