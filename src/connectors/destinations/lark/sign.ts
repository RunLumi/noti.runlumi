/**
 * Lark custom-bot signature, verified against the official samples
 * (https://open.larksuite.com/document/client-docs/bot-v3/add-custom-bot):
 *
 *   sign = Base64( HMAC-SHA256( key = timestamp + "\n" + secret, message = "" ) )
 *
 * The key is the concatenation and the message is empty — the reverse of most HMAC schemes.
 * `timestamp` is in seconds and must be within one hour of Lark's clock (error 19021).
 */
export async function larkSignature(secret: string, timestampSeconds: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`${timestampSeconds}\n${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign('HMAC', key, new Uint8Array());
  return btoa(String.fromCharCode(...new Uint8Array(signed)));
}

export interface LarkSignatureFields {
  readonly timestamp: string;
  readonly sign: string;
}

/** The top-level `timestamp`/`sign` string fields sent alongside `msg_type`. */
export async function larkSignatureFields(secret: string, nowMs: number): Promise<LarkSignatureFields> {
  const timestamp = Math.floor(nowMs / 1000);
  return { timestamp: String(timestamp), sign: await larkSignature(secret, timestamp) };
}
