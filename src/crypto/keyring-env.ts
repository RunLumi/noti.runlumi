import { createKeyring, CryptoError, type Keyring } from './envelope';

type KeyringEnv = { KEK_V1: string; KEK_V2?: string; KMS_ACTIVE_VERSION: string; ENCRYPTION_KEY?: string };

/**
 * Build the key ring from Worker secrets (F34 tier 2). Names are explicit rather than
 * computed so the configuration contract test can see every binding the code reads.
 * An empty value means "not configured", which is how an unused rotation slot looks.
 */
export function keyringFromEnv(env: KeyringEnv): Keyring {
  const keys = new Map<number, string>();
  if (env.KEK_V1) keys.set(1, env.KEK_V1);
  if (env.KEK_V2) keys.set(2, env.KEK_V2);
  const active = Number(env.KMS_ACTIVE_VERSION);
  return createKeyring(active, keys);
}

/**
 * Boot-time check for /health (F04). Returns the *name* of the misconfigured binding,
 * never its value or length.
 */
export function keyringProblem(env: KeyringEnv): string | null {
  try {
    keyringFromEnv(env);
  } catch (e) {
    if (e instanceof CryptoError) return 'KEK_V1/KEK_V2/KMS_ACTIVE_VERSION';
    throw e;
  }
  // The legacy key is optional, but a present one must be well-formed, or the migration
  // job would fail every row.
  if (env.ENCRYPTION_KEY && !/^[0-9a-f]{64}$/i.test(env.ENCRYPTION_KEY)) return 'ENCRYPTION_KEY';
  return null;
}
