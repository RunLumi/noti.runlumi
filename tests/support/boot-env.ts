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
  // The outbound mail binding and its sender (wrangler.jsonc `send_email`, `AUTH_FROM_EMAIL`): auth tier (ADR 0047).
  AUTH_EMAIL: { send: () => Promise.resolve({ messageId: 'boot-env' }) } as unknown as Bindings['AUTH_EMAIL'],
  AUTH_FROM_EMAIL: 'noreply@noti.test',
  // Set, so a staging-named test env is a complete one; `open` so tests can create accounts (ADR 0047).
  SIGNUP_MODE: 'open',
} satisfies Partial<Bindings>;
