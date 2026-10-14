/** SHA-256 hex of a string. */
export async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Are two secrets equal? Both sides are hashed first, so the comparison time depends on neither
 * secret's content or length. Used to refuse re-entering a revoked credential unchanged.
 */
export async function sameSecret(a: string, b: string): Promise<boolean> {
  return (await sha256Hex(a)) === (await sha256Hex(b));
}
