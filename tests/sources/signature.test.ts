import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  TIMESTAMP_TOLERANCE_SECONDS,
  isValidWebhookId,
  parseSignatures,
  parseTimestamp,
  sign,
  signedContent,
  verifyStandardWebhook,
} from '../../src/connectors/sources/generic/signature';

/**
 * Signature vectors. The Standard Webhooks spec (spec/standard-webhooks.md, read 2026-10-13)
 * publishes an example message id, timestamp, payload and signatures, but NOT the secret that
 * produced them, so that example cannot be reproduced and is NOT used as a pass/fail vector.
 * These vectors are generated at runtime and cross-checked against Node's independent
 * `node:crypto` HMAC implementation, which exercises the same construction
 * (HMAC-SHA256 over `id.timestamp.body`, base64) through a different code path.
 */
const fresh = () => new Uint8Array(randomBytes(32));
const KEY = fresh();
const ID = 'msg_2KWPBgLlAfxdpx2AI54pPJ85f4W'; // the spec's example id
const TS = '1674087231'; // the spec's example timestamp
const NOW = 1674087231;
const BODY = new TextEncoder().encode('{"type":"contact.created","timestamp":"2022-11-03T20:26:10.344522Z"}');

function reference(id: string, ts: string, body: Uint8Array, key: Uint8Array = KEY): string {
  return `v1,${createHmac('sha256', key).update(`${id}.${ts}.`).update(body).digest('base64')}`;
}

const headers = (signature: string, id = ID, timestamp = TS) => ({ id, timestamp, signature });

describe('signature construction', () => {
  it('matches an independent HMAC-SHA256 implementation byte for byte', async () => {
    expect(await sign(KEY, ID, TS, BODY)).toBe(reference(ID, TS, BODY));
  });

  it('signs `id.timestamp.body` over raw bytes, including non-UTF-8 bytes', async () => {
    const raw = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
    expect(new TextDecoder().decode(signedContent('a', '1', raw).subarray(0, 4))).toBe('a.1.');
    expect(await sign(KEY, 'a', '1', raw)).toBe(reference('a', '1', raw));
    const result = await verifyStandardWebhook(KEY, headers(reference('a', '1', raw), 'a', '1'), raw, 1);
    expect(result.ok).toBe(true);
  });
});

describe('verifyStandardWebhook', () => {
  it('accepts a correct signature', async () => {
    expect(await verifyStandardWebhook(KEY, headers(reference(ID, TS, BODY)), BODY, NOW)).toEqual({
      ok: true,
    });
  });

  it('accepts when any one of several space-separated signatures matches', async () => {
    const good = reference(ID, TS, BODY);
    const other = reference(ID, TS, BODY, fresh());
    for (const header of [`${other} ${good}`, `${good} ${other}`, `${other}  ${good}`])
      expect((await verifyStandardWebhook(KEY, headers(header), BODY, NOW)).ok).toBe(true);
  });

  it('ignores v1a entries and unknown versions rather than treating them as a match', async () => {
    const mac = reference(ID, TS, BODY).slice(3);
    for (const header of [`v1a,${mac}`, `v2,${mac}`, `${mac}`, `V1,${mac}`])
      expect(await verifyStandardWebhook(KEY, headers(header), BODY, NOW)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    const mixed = `v1a,${mac} ${reference(ID, TS, BODY)}`;
    expect((await verifyStandardWebhook(KEY, headers(mixed), BODY, NOW)).ok).toBe(true);
  });

  it('rejects a tampered body, id, timestamp or secret', async () => {
    const sig = reference(ID, TS, BODY);
    const tampered = new TextEncoder().encode(
      '{"type":"contact.created","timestamp":"2022-11-03T20:26:10.344523Z"}',
    );
    expect(await verifyStandardWebhook(KEY, headers(sig), tampered, NOW)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect((await verifyStandardWebhook(KEY, headers(sig, 'msg_other'), BODY, NOW)).ok).toBe(false);
    expect((await verifyStandardWebhook(KEY, headers(sig, ID, '1674087232'), BODY, NOW)).ok).toBe(false);
    expect((await verifyStandardWebhook(fresh(), headers(sig), BODY, NOW)).ok).toBe(false);
  });

  it('does not let the id/timestamp/body boundary be shifted', async () => {
    const body = new TextEncoder().encode('x');
    const sig = reference('a', '12', body);
    expect((await verifyStandardWebhook(KEY, headers(sig, 'a.1', '2'), body, 2)).ok).toBe(false);
  });

  it('enforces the replay window in both directions, inclusive at the edge', async () => {
    const sig = reference(ID, TS, BODY);
    const check = (now: number) => verifyStandardWebhook(KEY, headers(sig), BODY, now);
    expect((await check(NOW + TIMESTAMP_TOLERANCE_SECONDS)).ok).toBe(true);
    expect((await check(NOW - TIMESTAMP_TOLERANCE_SECONDS)).ok).toBe(true);
    expect(await check(NOW + TIMESTAMP_TOLERANCE_SECONDS + 1)).toEqual({ ok: false, reason: 'stale' });
    expect(await check(NOW - TIMESTAMP_TOLERANCE_SECONDS - 1)).toEqual({ ok: false, reason: 'stale' });
  });

  it('a wrong signature on a stale timestamp reports mismatch, not stale', async () => {
    const result = await verifyStandardWebhook(KEY, headers(`v1,${'A'.repeat(43)}=`), BODY, NOW + 99999);
    expect(result).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('treats missing or malformed headers as malformed', async () => {
    const sig = reference(ID, TS, BODY);
    const bad = [
      { id: null, timestamp: TS, signature: sig },
      { id: ID, timestamp: null, signature: sig },
      { id: ID, timestamp: TS, signature: null },
      { id: '', timestamp: TS, signature: sig },
      { id: ID, timestamp: '16740872.31', signature: sig },
      { id: ID, timestamp: '-1', signature: sig },
      { id: ID, timestamp: '0x10', signature: sig },
      { id: 'has space', timestamp: TS, signature: sig },
      { id: 'x'.repeat(129), timestamp: TS, signature: sig },
      { id: ID, timestamp: TS, signature: '' },
      { id: ID, timestamp: TS, signature: 'v1,not-base64!!' },
      { id: ID, timestamp: TS, signature: 'v1,AAAA' },
    ];
    for (const h of bad)
      expect(await verifyStandardWebhook(KEY, h, BODY, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('bounds the number of signatures it will check', () => {
    const one = reference(ID, TS, BODY);
    expect(parseSignatures(Array(10).fill(one).join(' '))).toHaveLength(10);
    expect(parseSignatures(Array(11).fill(one).join(' '))).toBeNull();
  });
});

describe('header parsers', () => {
  it('validates ids and timestamps strictly', () => {
    expect(isValidWebhookId(ID)).toBe(true);
    expect(isValidWebhookId('evt:1-3_4')).toBe(true);
    expect(isValidWebhookId('evt.1')).toBe(false);
    expect(isValidWebhookId('a\u0000b')).toBe(false);
    expect(isValidWebhookId('a b')).toBe(false);
    expect(parseTimestamp('1674087231')).toBe(1674087231);
    expect(parseTimestamp('1e9')).toBeNull();
    expect(parseTimestamp('1674087231000000')).toBeNull();
  });
});
