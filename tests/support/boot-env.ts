import type { Bindings, DeliveryMessage } from '../../src/env';

/**
 * The bindings every entrypoint now requires (assertConfig, ADR 0022), as a spread-able base for
 * tests that call `worker.fetch`/`queue`/`scheduled`: a queue stub, a key ring and the
 * environment name. Tests add `DB`, `APP_ORIGIN` and whatever else they exercise.
 */
export const BOOT_KEK = '11'.repeat(32);

export const BOOT_ENV = {
  DELIVERY_QUEUE: { send: () => Promise.resolve() } as unknown as Queue<DeliveryMessage>,
  KEK_V1: BOOT_KEK,
  KMS_ACTIVE_VERSION: '1',
  ENVIRONMENT_NAME: 'staging',
  KEK_CHECK_V1: '4464ea2121d3a99ebd188370f1ef6cd0',
  FINGERPRINT_KEY: '44'.repeat(32),
  // APP_ORIGIN and BETTER_AUTH_SECRET are asserted at boot too (ADR 0036); each test adds its own origin.
  BETTER_AUTH_SECRET: 'boot-env-better-auth-secret-0123456789',
} satisfies Partial<Bindings>;
