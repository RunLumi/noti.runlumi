import { createHash, createSign, generateKeyPairSync } from 'node:crypto';

/**
 * A software WebAuthn authenticator, just enough to answer the passkey sign-in ceremony with a real
 * ES256 signature. It lets a test choose the signature counter, which is the only way to show how the
 * server treats a counter that goes backwards (a cloned authenticator signals itself that way).
 * Nothing here is a real device: it proves the server's checks, not any browser or hardware.
 */
const b64url = (buf: Uint8Array): string => Buffer.from(buf).toString('base64url') as string;

export interface SoftAssertion {
  id: string;
  rawId: string;
  type: 'public-key';
  response: { authenticatorData: string; clientDataJSON: string; signature: string };
  clientExtensionResults: Record<string, never>;
}

export interface SoftPasskey {
  readonly credentialId: string;
  /** What Better Auth stores in `passkey.public_key`: the COSE key, base64 (not base64url). */
  readonly publicKeyB64: string;
  assert(options: { challenge: string; origin: string; rpId: string; counter: number }): SoftAssertion;
}

export function createSoftPasskey(credentialId: string): SoftPasskey {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x ?? '', 'base64url');
  const y = Buffer.from(jwk.y ?? '', 'base64url');
  // COSE_Key (RFC 8152): {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y} as CBOR.
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    x,
    Buffer.from([0x22, 0x58, 0x20]),
    y,
  ]);
  return {
    credentialId,
    publicKeyB64: cose.toString('base64'),
    assert({ challenge, origin, rpId, counter }) {
      const counterBytes = Buffer.alloc(4);
      counterBytes.writeUInt32BE(counter);
      const authData = Buffer.concat([
        createHash('sha256').update(rpId).digest(),
        Buffer.from([0x01]), // user present
        counterBytes,
      ]);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
      const signed = Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]);
      const signature = createSign('sha256').update(signed).sign(privateKey);
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        response: {
          authenticatorData: b64url(authData),
          clientDataJSON: b64url(clientDataJSON),
          signature: b64url(signature),
        },
        clientExtensionResults: {},
      };
    },
  };
}
