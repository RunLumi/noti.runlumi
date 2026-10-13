/**
 * Constant-time string equality for secrets compared as plain text (for example GitLab's
 * `X-Gitlab-Token`). Both sides are hashed first, so the comparison always runs over two
 * 32-byte digests regardless of the input lengths, then every byte is folded without an
 * early exit.
 */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
