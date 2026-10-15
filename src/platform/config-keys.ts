import type { Bindings } from '../env';

/**
 * Every binding name this Worker reads (ADR 0036). A name in `env` that is on none of these lists is
 * almost always a typo in a secret or var (`KEK_V_1`, `FINGERPRINT_KEY ` with a trailing space): the
 * intended binding is then silently missing. `unknownKeys` reports such names, never values.
 *
 * The list is typed against `Bindings`, so a key removed from the type fails to compile here; the other
 * direction (a key added to `src/env.ts` or `wrangler.jsonc` and not here) is a test in
 * `tests/platform/config-keys.test.ts`.
 */
export const KNOWN_BINDINGS = [
  'ASSETS',
  'DB',
  'DELIVERY_QUEUE',
  'AUTH_EMAIL',
  'AUTH_FROM_EMAIL',
  'APP_ORIGIN',
  'BETTER_AUTH_SECRET',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_APP_ID',
  'GITHUB_APP_SLUG',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'ENCRYPTION_KEY',
  'KEK_V1',
  'KEK_V2',
  'KMS_ACTIVE_VERSION',
  'ENVIRONMENT_NAME',
  'KEK_CHECK_V1',
  'KEK_CHECK_V2',
  'FINGERPRINT_KEY',
  'DELIVERY_RETENTION_DAYS',
  'GENERIC_WEBHOOK_ENABLED',
  'MAINTENANCE_MODE',
  'AUDIT_RETENTION_DAYS',
  'ALERT_WEBHOOK_URL',
  'PLATFORM_OPERATOR_USER_IDS',
  'SIGNUP_MODE',
  'SIGNUP_ALLOWLIST',
] as const satisfies readonly (keyof Bindings)[];

const KNOWN: ReadonlySet<string> = new Set(KNOWN_BINDINGS);

/** At most this many names are reported, so a hostile or huge `env` cannot flood a log line. */
const MAX_REPORTED = 20;
const MAX_NAME_CHARS = 64;

/** Names present in `env` that this Worker does not read, sorted and bounded. Names only. */
export function unknownKeys(env: object): string[] {
  return Object.keys(env)
    .filter((k) => !KNOWN.has(k))
    .sort()
    .slice(0, MAX_REPORTED)
    .map((k) => k.slice(0, MAX_NAME_CHARS));
}
