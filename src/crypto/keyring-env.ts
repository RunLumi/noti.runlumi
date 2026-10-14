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
 * Boot-time check of the key ring (F04). Returns the *names* of the misconfigured bindings,
 * never a value or length. The optional legacy key is checked separately (`legacyKeyProblem`
 * in src/platform/config.ts): a malformed one must not stop the Worker serving.
 */
export function keyringProblem(env: KeyringEnv): string | null {
  try {
    keyringFromEnv(env);
  } catch (e) {
    if (e instanceof CryptoError) return 'KEK_V1/KEK_V2/KMS_ACTIVE_VERSION';
    throw e;
  }
  return null;
}
