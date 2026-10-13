import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  InvalidIdComponentError,
  LARK_UUID_MAX_LENGTH,
  dedupKey,
  deliveryId,
  encodeComponents,
  larkMessageUuid,
  replayDeliveryId,
  toHex,
} from '../../src/delivery/ids';

const BASE = { orgId: 'org_1', connectionId: 'conn_1', source: 'github', eventId: 'guid-1' } as const;

describe('dedupKey (F170)', () => {
  it('matches the canonical 0x00-separated SHA-256 form exactly', async () => {
    const expected = createHash('sha256').update('\0org_1\0conn_1\0github\0guid-1', 'utf8').digest('hex');
    const key = await dedupKey(BASE);
    expect(key.hex).toBe(expected);
    expect(key.bytes).toHaveLength(32); // full 256 bits, never truncated
    expect(toHex(key.bytes)).toBe(key.hex);
  });

  it('identical_delivery_produces_the_same_key', async () => {
    expect((await dedupKey(BASE)).hex).toBe((await dedupKey({ ...BASE })).hex);
  });

  it('dedup_key_is_injective_across_component_boundaries', async () => {
    const a = await dedupKey({ orgId: 'ab', connectionId: 'c', source: 'github', eventId: 'x' });
    const b = await dedupKey({ orgId: 'a', connectionId: 'bc', source: 'github', eventId: 'x' });
    const c = await dedupKey({ orgId: 'a.b', connectionId: 'c', source: 'github', eventId: 'x' });
    expect(new Set([a.hex, b.hex, c.hex]).size).toBe(3);
  });

  it('same_event_in_two_workspaces_produces_two_keys', async () => {
    const one = await dedupKey(BASE);
    const two = await dedupKey({ ...BASE, orgId: 'org_2' });
    const otherConnection = await dedupKey({ ...BASE, connectionId: 'conn_2' });
    expect(new Set([one.hex, two.hex, otherConnection.hex]).size).toBe(3);
  });

  it('rejects a separator inside a component (attacker-controlled ids)', async () => {
    await expect(dedupKey({ ...BASE, eventId: 'a\u0000b' })).rejects.toBeInstanceOf(InvalidIdComponentError);
    expect(() => encodeComponents([['source', '']])).toThrow(/"source"/);
  });

  it('encodes UTF-8 with a leading separator per component', () => {
    expect(
      Array.from(
        encodeComponents([
          ['a', 'é'],
          ['b', 'x'],
        ]),
      ),
    ).toEqual([0, 0xc3, 0xa9, 0, 0x78]);
  });
});

describe('deliveryId (F184, fixes D10)', () => {
  it('is (dedup_key, destination) — two destinations never collide', async () => {
    const key = await dedupKey(BASE);
    const a = await deliveryId(key.hex, 'dest_a');
    const b = await deliveryId(key.hex, 'dest_b');
    expect(a.hex).not.toBe(b.hex);
    expect((await deliveryId(key.hex, 'dest_a')).hex).toBe(a.hex);
  });

  it('is domain-separated from the dedup key and from replay ids', async () => {
    const key = await dedupKey(BASE);
    const id = await deliveryId(key.hex, 'dest_a');
    const replay = await replayDeliveryId(id.hex, 1);
    expect(new Set([key.hex, id.hex, replay.hex]).size).toBe(3);
  });

  it('is not the legacy hand-built string', async () => {
    const id = await deliveryId('guid-1', 'integration-1');
    expect(id.hex).toMatch(/^[0-9a-f]{64}$/);
    expect(id.hex).not.toContain(':');
  });
});

describe('replayDeliveryId (F182)', () => {
  it('is deterministic per sequence and distinct across sequences', async () => {
    const first = await replayDeliveryId('d'.repeat(64), 1);
    expect((await replayDeliveryId('d'.repeat(64), 1)).hex).toBe(first.hex);
    expect((await replayDeliveryId('d'.repeat(64), 2)).hex).not.toBe(first.hex);
  });

  it.each([0, -1, 1.5])('rejects sequence %s', async (n) => {
    await expect(replayDeliveryId('d', n)).rejects.toThrow(RangeError);
  });
});

describe('larkMessageUuid (F188)', () => {
  it('lark_uuid_is_derived_from_delivery_id_and_under_50_chars', async () => {
    const id = await deliveryId('k', 'dest');
    const uuid = larkMessageUuid(id.hex);
    expect(uuid.length).toBeLessThanOrEqual(LARK_UUID_MAX_LENGTH);
    expect(id.hex.startsWith(uuid)).toBe(true);
  });

  it('lark_uuid_is_stable_across_retries', async () => {
    const id = await deliveryId('k', 'dest');
    expect(larkMessageUuid(id.hex)).toBe(larkMessageUuid(id.hex));
  });

  it('rejects anything that is not a full delivery digest', () => {
    expect(() => larkMessageUuid('abc')).toThrow(InvalidIdComponentError);
    expect(() => larkMessageUuid('G'.repeat(64))).toThrow(InvalidIdComponentError);
  });
});
