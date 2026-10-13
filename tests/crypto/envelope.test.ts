import { describe, it, expect } from 'vitest';
import {
  buildAad,
  createConnectionKeys,
  createKeyring,
  CryptoError,
  decodeEnvelope,
  encodeEnvelope,
  MAX_PLAINTEXT_BYTES,
  open,
  openLegacyV0,
  rewrapConnectionKey,
  seal,
  tenantKeyInfo,
  toBytes,
  unwrapConnectionKey,
  type SealContext,
} from '../../src/crypto/envelope';
import { legacySeal } from '../support/legacy';

const K1 = '11'.repeat(32);
const K2 = '22'.repeat(32);
const ring1 = createKeyring(1, new Map([[1, K1]]));
const ring12 = createKeyring(
  2,
  new Map([
    [1, K1],
    [2, K2],
  ]),
);

const ctx = (over: Partial<SealContext> = {}): SealContext => ({
  orgId: 'org-a',
  connectionId: 'int-1',
  field: 'url',
  purpose: 'destination',
  ...over,
});

async function freshDek(orgId = 'org-a', connectionId = 'int-1') {
  return createConnectionKeys(ring1, { orgId, connectionId, purpose: 'destination' });
}

async function expectCode(promise: Promise<unknown>, code: CryptoError['code']): Promise<void> {
  await expect(promise).rejects.toSatisfy((e: unknown) => e instanceof CryptoError && e.code === code);
}

describe('envelope format (F33)', () => {
  it('round-trips through seal and open', async () => {
    const { dek } = await freshDek();
    const sealed = await seal(dek, 'https://hooks.slack.com/services/T/B/x', ctx());
    expect(await open(dek, sealed, ctx())).toBe('https://hooks.slack.com/services/T/B/x');
  });

  it('matches the specified byte layout', async () => {
    const { dek } = await freshDek();
    const sealed = await seal(dek, 'abc', ctx());
    expect(sealed[0]).toBe(0x01);
    expect(sealed[1]).toBe(0x00);
    expect(Array.from(sealed.subarray(2, 6))).toEqual([0, 0, 0, 0]);
    // 18-byte header + 3 bytes of ciphertext + 16-byte tag.
    expect(sealed.length).toBe(18 + 3 + 16);
  });

  it('encodes kek_version big-endian and decodes it back', () => {
    const iv = new Uint8Array(new ArrayBuffer(12));
    const ciphertext = new Uint8Array(new ArrayBuffer(16));
    const bytes = encodeEnvelope({ formatVersion: 1, kekVersion: 0x01020304, iv, ciphertext });
    expect(Array.from(bytes.subarray(2, 6))).toEqual([1, 2, 3, 4]);
    expect(decodeEnvelope(bytes).kekVersion).toBe(0x01020304);
  });

  it('rejects malformed envelopes without partial plaintext', async () => {
    const { dek } = await freshDek();
    const sealed = await seal(dek, 'secret', ctx());
    const wrongMagic = sealed.slice();
    wrongMagic[0] = 0x02;
    const flags = sealed.slice();
    flags[1] = 0x01;
    await expectCode(open(dek, wrongMagic, ctx()), 'malformed_envelope');
    await expectCode(open(dek, flags, ctx()), 'malformed_envelope');
    await expectCode(open(dek, sealed.slice(0, 20), ctx()), 'malformed_envelope');
  });

  it('uses a fresh IV for every seal', async () => {
    const { dek } = await freshDek();
    const ivs = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const sealed = await seal(dek, 'same plaintext', ctx());
      ivs.add(Array.from(sealed.subarray(6, 18)).join(','));
    }
    expect(ivs.size).toBe(50);
  });

  it('refuses empty and oversized plaintext', async () => {
    const { dek } = await freshDek();
    await expectCode(seal(dek, '', ctx()), 'config_invalid');
    await expectCode(seal(dek, 'x'.repeat(MAX_PLAINTEXT_BYTES + 1), ctx()), 'config_invalid');
    expect(await open(dek, await seal(dek, 'x'.repeat(MAX_PLAINTEXT_BYTES), ctx()), ctx())).toHaveLength(
      MAX_PLAINTEXT_BYTES,
    );
  });

  it('refuses to seal or open the dek field through the field API', async () => {
    const { dek } = await freshDek();
    await expectCode(seal(dek, 'x', ctx({ field: 'dek' })), 'config_invalid');
    await expectCode(open(dek, new Uint8Array(40), ctx({ field: 'dek' })), 'config_invalid');
  });

  it('detects tampered ciphertext', async () => {
    const { dek } = await freshDek();
    const sealed = await seal(dek, 'secret', ctx());
    const last = sealed.length - 1;
    sealed[last] = (sealed[last] ?? 0) ^ 0xff;
    await expectCode(open(dek, sealed, ctx()), 'destination_credentials_invalid');
  });
});

describe('AAD binding (F36)', () => {
  it('builds the canonical zero-separated bytes', () => {
    const text = new TextDecoder().decode(buildAad(ctx()));
    expect(text).toBe('lumi-noti/aad/v1\u0000org-a\u0000int-1\u0000url\u0000destination');
  });

  it('rejects components that are empty or contain NUL, so none can collide', () => {
    expect(() => buildAad(ctx({ orgId: '' }))).toThrow(CryptoError);
    expect(() => buildAad(ctx({ connectionId: 'a\u0000b' }))).toThrow(CryptoError);
  });

  it('binds a ciphertext to its row: swapping rows fails the tag check', async () => {
    const { dek } = await freshDek();
    const sealed = await seal(dek, 'https://example.invalid/a', ctx({ connectionId: 'int-1' }));
    await expectCode(open(dek, sealed, ctx({ connectionId: 'int-2' })), 'destination_credentials_invalid');
    await expectCode(open(dek, sealed, ctx({ orgId: 'org-b' })), 'destination_credentials_invalid');
  });

  it('makes url and signing_secret ciphertexts non-interchangeable', async () => {
    const { dek } = await freshDek();
    const sealed = await seal(dek, 'value', ctx({ field: 'url' }));
    await expectCode(open(dek, sealed, ctx({ field: 'signing_secret' })), 'destination_credentials_invalid');
  });
});

describe('tenant keys and wrapping (F35)', () => {
  it('includes the purpose and org id in HKDF info', () => {
    expect(new TextDecoder().decode(tenantKeyInfo('org-a', 'destination'))).toBe(
      'destination\u0000org-a\u0000lumi-noti/tk/v1',
    );
  });

  it('unwraps the DEK it wrapped, and the key cannot be exported', async () => {
    const { material, dek } = await freshDek();
    expect(dek.extractable).toBe(false);
    const unwrapped = await unwrapConnectionKey(ring1, material);
    expect(unwrapped.extractable).toBe(false);
    const sealed = await seal(dek, 'hello', ctx());
    expect(await open(unwrapped, sealed, ctx())).toBe('hello');
  });

  it('refuses to unwrap a DEK moved to another organization or connection', async () => {
    const { material } = await freshDek();
    await expectCode(
      unwrapConnectionKey(ring1, { ...material, orgId: 'org-b' }),
      'destination_credentials_invalid',
    );
    await expectCode(
      unwrapConnectionKey(ring1, { ...material, connectionId: 'int-2' }),
      'destination_credentials_invalid',
    );
  });

  it('treats a wrong salt length as malformed', async () => {
    const { material } = await freshDek();
    await expectCode(
      unwrapConnectionKey(ring1, { ...material, keySalt: new Uint8Array(8) }),
      'malformed_envelope',
    );
  });

  it('flags a row whose kek_version disagrees with its envelope', async () => {
    const { material } = await freshDek();
    await expectCode(unwrapConnectionKey(ring12, { ...material, kekVersion: 2 }), 'malformed_envelope');
  });
});

describe('key versions and rotation (F37)', () => {
  it('validates the key ring', () => {
    expect(() => createKeyring(1, new Map())).toThrow(CryptoError);
    expect(() => createKeyring(0, new Map([[0, K1]]))).toThrow(CryptoError);
    expect(() => createKeyring(1, new Map([[1, 'zz']]))).toThrow(CryptoError);
  });

  it('opens only with the version the envelope names, never another', async () => {
    const { material } = await freshDek();
    const onlyV2 = createKeyring(2, new Map([[2, K2]]));
    await expectCode(unwrapConnectionKey(onlyV2, material), 'unknown_kek_version');
  });

  it('rewraps the DEK under the active KEK without touching field envelopes', async () => {
    const { material, dek } = await freshDek();
    const field = await seal(dek, 'https://example.invalid/hook', ctx());
    const rewrapped = await rewrapConnectionKey(ring12, material);
    expect(rewrapped.kekVersion).toBe(2);
    expect(rewrapped.dekWrapped).not.toEqual(material.dekWrapped);
    const onlyV2 = createKeyring(2, new Map([[2, K2]]));
    const dek2 = await unwrapConnectionKey(onlyV2, rewrapped);
    expect(await open(dek2, field, ctx())).toBe('https://example.invalid/hook');
  });
});

describe('legacy v0 reader', () => {
  it('opens the pre-envelope format', async () => {
    const legacy = await legacySeal('https://open.larksuite.com/open-apis/bot/v2/hook/x', K1);
    expect(await openLegacyV0(legacy, K1)).toBe('https://open.larksuite.com/open-apis/bot/v2/hook/x');
  });

  it('fails closed on the wrong key, bad base64 or truncation', async () => {
    const legacy = await legacySeal('value', K1);
    await expectCode(openLegacyV0(legacy, K2), 'destination_credentials_invalid');
    await expectCode(openLegacyV0('%%%', K1), 'malformed_envelope');
    await expectCode(openLegacyV0(btoa('short'), K1), 'malformed_envelope');
    await expectCode(openLegacyV0(legacy, 'nothex'), 'config_invalid');
  });
});

describe('toBytes', () => {
  it('normalises every D1 BLOB shape', () => {
    expect(toBytes(null)).toBeNull();
    expect(toBytes(undefined)).toBeNull();
    expect(Array.from(toBytes([1, 2, 3]) ?? [])).toEqual([1, 2, 3]);
    expect(Array.from(toBytes(new Uint8Array([4, 5])) ?? [])).toEqual([4, 5]);
    expect(Array.from(toBytes(new Uint8Array([6]).buffer) ?? [])).toEqual([6]);
  });

  it('rejects anything that is not bytes', () => {
    expect(() => toBytes('abc')).toThrow(CryptoError);
    expect(() => toBytes([256])).toThrow(CryptoError);
    expect(() => toBytes([1.5])).toThrow(CryptoError);
  });
});
