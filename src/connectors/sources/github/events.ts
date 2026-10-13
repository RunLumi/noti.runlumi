export type GithubEvent = Record<string, unknown>;

/** SHA-256 digest length in bytes. */
const DIGEST_BYTES = 32;

const HEX_64 = /^[a-f0-9]{64}$/;

export function classifyGithubEvent(kind: string, event: GithubEvent): string {
  const action = typeof event.action === 'string' ? event.action : '';
  if (
    kind === 'pull_request' &&
    action === 'closed' &&
    (event.pull_request as { merged?: boolean } | undefined)?.merged === true
  )
    return 'pull_request.merged';
  if (kind === 'workflow_run' && action === 'completed') {
    const conclusion = (event.workflow_run as { conclusion?: unknown } | undefined)?.conclusion;
    if (typeof conclusion === 'string') return 'workflow_run.' + conclusion;
  }
  return kind + (action ? '.' + action : '');
}

/**
 * `ArrayBuffer` is explicit because `crypto.subtle.verify` requires a `BufferSource`
 * (ArrayBuffer-backed). TypeScript 5.7+ parameterises typed arrays, and a bare
 * `new Uint8Array(n)` widens to `ArrayBufferLike`, which is not assignable.
 */
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Verify a GitHub `X-Hub-Signature-256` header against the raw request body.
 *
 * Raw body, before any JSON parsing — re-serialising the payload invalidates the signature.
 *
 * The shape guard (`^sha256=[a-f0-9]{64}$`) runs *before* verification. It is what makes
 * the comparison sound: it fixes both the algorithm and the digest length, so a length
 * mismatch can never be used as a timing or parsing oracle. Dropping it would be a security
 * regression even though the regex "looks like" just input validation.
 *
 * Constant-time comparison is delegated to WebCrypto's MAC verification rather than
 * hand-rolled, per docs/specs/05-source-github.md F58.
 */
export async function verifyGithubSignature(
  body: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  if (!secret || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  try {
    return await crypto.subtle.verify(
      'HMAC',
      key,
      hexToBytes(signature.slice(7)),
      new TextEncoder().encode(body),
    );
  } catch {
    // A malformed key or buffer must be a verification failure, never a thrown error that
    // escapes into the request handler.
    return false;
  }
}

export { DIGEST_BYTES, HEX_64 };
