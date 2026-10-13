/**
 * Stable identities — docs/specs/12-delivery-reliability.md F170, F182, F184, F188.
 *
 * Fixes D10: the old delivery id `${githubDeliveryId}:${integrationId}` was a hand-built
 * string with an attacker-influenced separator. Every id here is SHA-256 over 0x00-separated
 * UTF-8 components, and a component containing 0x00 is rejected, so the encoding is
 * injective (F170, after the Standard Webhooks separator warning).
 *
 * Uses `crypto.subtle`, available in Workers and in Node 22.
 */

export interface DedupKeyInput {
  readonly orgId: string;
  readonly connectionId: string;
  /** CloudEvents `source`, e.g. `github`. */
  readonly source: string;
  /** Provider event/delivery id. Signatures and timestamps are never part of identity. */
  readonly eventId: string;
}

export interface Digest {
  /** The full 256-bit digest — never truncated (F170). Store as BLOB. */
  readonly bytes: Uint8Array;
  /** Lowercase hex of `bytes`, 64 chars. */
  readonly hex: string;
}

const SEPARATOR = 0x00;
const encoder = new TextEncoder();

export class InvalidIdComponentError extends Error {
  override readonly name = 'InvalidIdComponentError';
  constructor(readonly component: string) {
    super(`id component "${component}" must be a non-empty string without NUL bytes`);
  }
}

function assertComponent(name: string, value: string): void {
  if (value.length === 0 || value.includes('\u0000')) throw new InvalidIdComponentError(name);
}

/** `0x00 ‖ c1 ‖ 0x00 ‖ c2 ‖ …` — a leading separator before every component (F170). */
export function encodeComponents(
  components: readonly (readonly [string, string])[],
): Uint8Array<ArrayBuffer> {
  components.forEach(([name, value]) => assertComponent(name, value));
  const parts = components.map(([, value]) => encoder.encode(value));
  const out = new Uint8Array(parts.reduce((n, p) => n + 1 + p.length, 0));
  parts.reduce((offset, part) => {
    out[offset] = SEPARATOR;
    out.set(part, offset + 1);
    return offset + 1 + part.length;
  }, 0);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Digest> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return { bytes, hex: toHex(bytes) };
}

/** F170: `SHA-256(0x00 ‖ orgid ‖ 0x00 ‖ connectionid ‖ 0x00 ‖ source ‖ 0x00 ‖ id)`. */
export async function dedupKey(input: DedupKeyInput): Promise<Digest> {
  return sha256(
    encodeComponents([
      ['orgId', input.orgId],
      ['connectionId', input.connectionId],
      ['source', input.source],
      ['eventId', input.eventId],
    ]),
  );
}

/**
 * F184: a delivery's identity is `(dedup_key, destinationid)`. The domain tag keeps a
 * delivery id from ever equalling a dedup key or replay id built from the same strings.
 */
export async function deliveryId(dedupKeyHex: string, destinationId: string): Promise<Digest> {
  return sha256(
    encodeComponents([
      ['domain', 'noti.delivery.v1'],
      ['dedupKey', dedupKeyHex],
      ['destinationId', destinationId],
    ]),
  );
}

/**
 * F182: a replay is a new delivery row with a `replay_of` pointer. Deterministic in
 * `(original, sequence)`, so a double-clicked replay request maps to the same row.
 */
export async function replayDeliveryId(originalDeliveryId: string, replaySequence: number): Promise<Digest> {
  if (!Number.isInteger(replaySequence) || replaySequence < 1) {
    throw new RangeError(`replaySequence must be a positive integer, got ${replaySequence}`);
  }
  return sha256(
    encodeComponents([
      ['domain', 'noti.replay.v1'],
      ['originalDeliveryId', originalDeliveryId],
      ['replaySequence', String(replaySequence)],
    ]),
  );
}

/** Lark's documented `uuid` maximum (F188). */
export const LARK_UUID_MAX_LENGTH = 50;

/**
 * F188: Lark app idempotency key, derived from the delivery id and reused across retries.
 * 50 hex chars keep 200 bits of the digest, so a collision cannot realistically suppress
 * a real message.
 */
export function larkMessageUuid(deliveryIdHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(deliveryIdHex)) {
    throw new InvalidIdComponentError('deliveryIdHex');
  }
  return deliveryIdHex.slice(0, LARK_UUID_MAX_LENGTH);
}
