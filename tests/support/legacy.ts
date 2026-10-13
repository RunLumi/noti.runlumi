import { parseKeyHex } from '../../src/crypto/envelope';

/** Produce a v0 ciphertext exactly as the pre-envelope code stored it: base64(iv‖ct). */
export async function legacySeal(plaintext: string, keyHex: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', parseKeyHex(keyHex), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)),
  );
  const joined = new Uint8Array(iv.length + ct.length);
  joined.set(iv);
  joined.set(ct, iv.length);
  return btoa(String.fromCharCode(...joined));
}
