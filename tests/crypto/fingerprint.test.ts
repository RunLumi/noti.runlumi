import { describe, expect, it } from 'vitest';
import { parseKeyHex } from '../../src/crypto/envelope';
import {
  credentialFingerprint,
  isEnvironmentName,
  isFingerprintKey,
  kekCheckValue,
} from '../../src/crypto/fingerprint';

const KEY = '44'.repeat(32);

describe('credentialFingerprint (F39)', () => {
  it('is a tenant-keyed HMAC, pinned against an independent computation', async () => {
    // python3: HKDF-SHA256(ikm=44*32, salt='', info=b'lumi-noti/fp/v1\0org-a', L=32) -> HMAC-SHA256(.., b'abc'),
    // base64.b32encode(..)[:8]
    expect(await credentialFingerprint('abc', 'org-a', KEY)).toBe('7AFZ4YST');
    expect(await credentialFingerprint('abc', 'org-b', KEY)).toBe('2UVKQDL2');
  });

  it('is scoped to the tenant and to the key, and is not a plain hash of the secret', async () => {
    const a = await credentialFingerprint('https://hooks.slack.com/services/T/B/one', 'org-a', KEY);
    expect(a).toMatch(/^[A-Z2-7]{8}$/);
    expect(await credentialFingerprint('https://hooks.slack.com/services/T/B/one', 'org-a', KEY)).toBe(a);
    expect(await credentialFingerprint('https://hooks.slack.com/services/T/B/one', 'org-b', KEY)).not.toBe(a);
    expect(
      await credentialFingerprint('https://hooks.slack.com/services/T/B/one', 'org-a', '55'.repeat(32)),
    ).not.toBe(a);
    expect(await credentialFingerprint('https://hooks.slack.com/services/T/B/two', 'org-a', KEY)).not.toBe(a);
    // The unsalted SHA-256 prefix a reader could compute for a guess is NOT what is stored.
    expect(await credentialFingerprint('abc', 'org-a', KEY)).not.toBe('XJ4BNP4P');
  });

  it('is null without a usable key: it is display only, never a reason to fail', async () => {
    expect(await credentialFingerprint('abc', 'org-a', undefined)).toBeNull();
    expect(await credentialFingerprint('abc', 'org-a', '')).toBeNull();
    expect(await credentialFingerprint('abc', 'org-a', 'short')).toBeNull();
    expect(await credentialFingerprint('abc', '', KEY)).toBeNull();
    expect(isFingerprintKey(KEY)).toBe(true);
    expect(isFingerprintKey('zz'.repeat(32))).toBe(false);
  });
});

describe('kekCheckValue (F34)', () => {
  it('is HKDF-SHA-256(KEK, salt empty, info "lumi-noti/kcv/v2:" + environment), 32 hex characters', async () => {
    // python3: hkdf(bytes.fromhex('11'*32), b'lumi-noti/kcv/v2:production', 16).hex()
    expect(await kekCheckValue(parseKeyHex('11'.repeat(32)), 'production')).toBe(
      'f1621faf533fef4f46147282d75bc6f0',
    );
  });

  it('knows the three environment names and nothing else', () => {
    for (const name of ['production', 'staging', 'development']) expect(isEnvironmentName(name)).toBe(true);
    for (const name of ['prod', 'Production', '', undefined, null, 1])
      expect(isEnvironmentName(name)).toBe(false);
  });
});
