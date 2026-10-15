import { keyringProblem } from '../crypto/keyring-env';
import { parseKeyHex } from '../crypto/envelope';
import { isEnvironmentName, isFingerprintKey, kekCheckValue } from '../crypto/fingerprint';
import type { Bindings } from '../env';
import { resolveWebhookTarget } from '../observability/alerts/sinks';
import { unknownKeys } from './config-keys';
import { log } from './log';

/**
 * Boot-time configuration validation (F04, F10, F34), run at every entrypoint.
 *
 * Everything returned is a binding NAME and nothing else: never a value, a length or a prefix. The
 * names are safe to put in a log line and in `/health`.
 *
 * Bindings fall into tiers, and what a fault stops depends on the tier (ADR 0022):
 *
 *  | Tier        | Bindings                                                           | A fault stops |
 *  | ----------- | ------------------------------------------------------------------ | ------------- |
 *  | storage     | `DB`                                                               | every request except the probes; the queue consumer and `scheduled` |
 *  | credentials | `KEK_V1/2`, `KMS_ACTIVE_VERSION`, `ENVIRONMENT_NAME`, `KEK_CHECK_V<n>`, and a KEK that does not match its check value | writes under `/api/integrations` and `/api/sources` (they seal credentials), the queue consumer and `scheduled`. NOT webhook ingress, auth or any read |
 *  | queue       | `DELIVERY_QUEUE`                                                   | the queue consumer and `scheduled` (dispatch). Ingress already persists to the outbox without it |
 *  | auth        | `APP_ORIGIN` (an absolute origin, https outside local development), `BETTER_AUTH_SECRET` (at least 32 characters, not a placeholder) | every `/api` and `/github` request except the probes (503). NOT webhook ingress, the queue consumer or `scheduled`: none of them needs a session |
 *  | warnings    | `ENCRYPTION_KEY` (optional legacy key), `FINGERPRINT_KEY` (optional), `ALERT_WEBHOOK_URL` (optional, set but not a Slack, Discord, Lark or Teams webhook URL), a second KEK without a check value, the GitHub App bindings (`GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`) while a placeholder or malformed, the outbound mail binding `AUTH_EMAIL` when absent and `AUTH_FROM_EMAIL` when absent or a placeholder | nothing at this layer; the GitHub routes already fail closed on their own. Names reach only the log and the platform operator's readiness view, never an anonymous caller. (`AUTH_EMAIL` absence does make `createAuth` throw, so auth routes fail without it; that is an auth-tier fault NOT yet asserted here) |
 */

type ConfigEnv = Partial<
  Pick<
    Bindings,
    | 'DB'
    | 'DELIVERY_QUEUE'
    | 'KEK_V1'
    | 'KEK_V2'
    | 'KMS_ACTIVE_VERSION'
    | 'ENCRYPTION_KEY'
    | 'FINGERPRINT_KEY'
    | 'ALERT_WEBHOOK_URL'
    | 'AUTH_EMAIL'
    | 'AUTH_FROM_EMAIL'
    | 'ENVIRONMENT_NAME'
    | 'KEK_CHECK_V1'
    | 'KEK_CHECK_V2'
    | 'APP_ORIGIN'
    | 'BETTER_AUTH_SECRET'
    | 'GITHUB_WEBHOOK_SECRET'
    | 'GITHUB_APP_ID'
    | 'GITHUB_APP_SLUG'
    | 'GITHUB_CLIENT_ID'
    | 'GITHUB_CLIENT_SECRET'
  >
>;

const CHECK_VALUE = /^[0-9a-f]{32}$/;
const HEX_64 = /^[0-9a-f]{64}$/i;

const hasFunction = (value: unknown, name: string): boolean =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Record<string, unknown>)[name] === 'function';

/** `[version, KEK hex, check value]` for every KEK this deployment holds. */
function kekSlots(env: ConfigEnv): [version: 1 | 2, kek: string, check: string][] {
  const slots: [1 | 2, string, string][] = [];
  if (env.KEK_V1) slots.push([1, env.KEK_V1, env.KEK_CHECK_V1 ?? '']);
  if (env.KEK_V2) slots.push([2, env.KEK_V2, env.KEK_CHECK_V2 ?? '']);
  return slots;
}

/** `localhost`, `127.0.0.1`, `[::1]` or `*.localhost`: a developer's own machine. */
export function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

export interface ConfigAssessment {
  readonly storage: string[];
  readonly credentials: string[];
  readonly queue: string[];
  /** Sign-in and the dashboard API cannot work: `APP_ORIGIN` or `BETTER_AUTH_SECRET`. */
  readonly auth: string[];
  readonly warnings: string[];
}

/** An unset value, a deploy placeholder (`REPLACE_WITH_...`) or an all-zero stand-in. */
const PLACEHOLDER = /^(|replace[-_ ].*|replace-me|changeme|0+)$/i;
const isPlaceholder = (value: string | undefined): boolean =>
  value === undefined || PLACEHOLDER.test(value.trim());

/**
 * An absolute origin and nothing else (no path, query, fragment or credentials), https unless it is a
 * developer's own machine. Better Auth's base URL, the trusted origin and the CSRF check all use it.
 */
export function isUsableOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    const bare =
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      url.username === '' &&
      url.password === '';
    const secure = url.protocol === 'https:' || (url.protocol === 'http:' && isLocalOrigin(origin));
    return bare && secure && origin.replace(/\/$/, '') === url.origin;
  } catch {
    return false;
  }
}

const BETTER_AUTH_SECRET_MIN_CHARS = 32;

/**
 * Looks like something copied from an example, not generated: a placeholder word at the start (the value in
 * `.dev.vars.example` is `replace-with-at-least-32-characters-of-entropy`) or anywhere as a whole word.
 */
const EXAMPLE_SECRET =
  /^(replace|change|example|sample|your|todo|dummy|default|placeholder)|changeme|entropy|placeholder/i;

/** Fewer than 10 distinct characters, or one character making up over a third of it: a pattern, not a key. */
function lowEntropy(value: string): boolean {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  return counts.size < 10 || Math.max(...counts.values()) > value.length / 3;
}

/** A session secret that must not be accepted outside a developer's own machine. */
export function isWeakAuthSecret(secret: string | undefined): boolean {
  if (!secret || secret.length < BETTER_AUTH_SECRET_MIN_CHARS) return true;
  return isPlaceholder(secret) || EXAMPLE_SECRET.test(secret) || lowEntropy(secret);
}

function authFaults(env: ConfigEnv): string[] {
  const faults: string[] = [];
  if (!isUsableOrigin(env.APP_ORIGIN)) faults.push('APP_ORIGIN');
  const secret = env.BETTER_AUTH_SECRET;
  // A developer's own machine may use a simple value; anywhere else an example or repetitive one is refused.
  const local = env.ENVIRONMENT_NAME === 'development' && isLocalOrigin(env.APP_ORIGIN);
  const unusable = local ? !secret || secret.length < BETTER_AUTH_SECRET_MIN_CHARS : isWeakAuthSecret(secret);
  if (unusable) faults.push('BETTER_AUTH_SECRET');
  return faults;
}

/**
 * Outbound mail (Cloudflare Email Sending, `send_email` `AUTH_EMAIL`, src/auth/email.ts), as warnings. There is no
 * inbound `email` handler in this Worker: no email source is built (ADR 0014), so there is no entrypoint to check.
 * Without the binding, verification and reset mail cannot be sent; a binding that is present is NOT proof that
 * the sending domain is verified or that mail arrives (docs/EMAIL_LIMITS.md, F17).
 */
function mailFaults(env: ConfigEnv): string[] {
  const faults: string[] = [];
  if (!hasFunction(env.AUTH_EMAIL, 'send')) faults.push('AUTH_EMAIL');
  if (isPlaceholder(env.AUTH_FROM_EMAIL) || !/^[^@\s]+@[^@\s]+$/.test(env.AUTH_FROM_EMAIL ?? ''))
    faults.push('AUTH_FROM_EMAIL');
  return faults;
}

/**
 * The GitHub App bindings, as warnings: while any is a placeholder the install flow and webhook route
 * answer 503 on their own (src/connectors/sources/github), and `scripts/predeploy-check.mjs` allows them
 * unset because the feature stays closed by design. They are named so an operator sees WHICH is missing.
 */
function githubFaults(env: ConfigEnv): string[] {
  const faults: string[] = [];
  if (isPlaceholder(env.GITHUB_WEBHOOK_SECRET)) faults.push('GITHUB_WEBHOOK_SECRET');
  if (isPlaceholder(env.GITHUB_APP_ID) || !/^[1-9][0-9]*$/.test(env.GITHUB_APP_ID ?? ''))
    faults.push('GITHUB_APP_ID');
  if (isPlaceholder(env.GITHUB_APP_SLUG) || !/^[a-z0-9-]{1,100}$/i.test(env.GITHUB_APP_SLUG ?? ''))
    faults.push('GITHUB_APP_SLUG');
  if (isPlaceholder(env.GITHUB_CLIENT_ID)) faults.push('GITHUB_CLIENT_ID');
  if (isPlaceholder(env.GITHUB_CLIENT_SECRET)) faults.push('GITHUB_CLIENT_SECRET');
  return faults;
}

/**
 * Synchronous, pure checks, grouped by tier. A check value is required outside `development`: at
 * least one KEK the Worker holds must carry a well-formed one (without it a swapped-in KEK from
 * another environment could not be told apart from the right one). During a rotation window the
 * other KEK may lack one: that is a warning, and every check value that IS present must match.
 * `development` is accepted only on a local `APP_ORIGIN`, so a production deploy cannot opt out of
 * the check by naming itself `development`.
 */
export function assessConfig(env: ConfigEnv): ConfigAssessment {
  const storage: string[] = [];
  const credentials: string[] = [];
  const queue: string[] = [];
  const warnings: string[] = [];
  if (!hasFunction(env.DB, 'prepare')) storage.push('DB');
  if (!hasFunction(env.DELIVERY_QUEUE, 'send')) queue.push('DELIVERY_QUEUE');
  const keyring = keyringProblem({
    KEK_V1: env.KEK_V1 ?? '',
    ...(env.KEK_V2 ? { KEK_V2: env.KEK_V2 } : {}),
    KMS_ACTIVE_VERSION: env.KMS_ACTIVE_VERSION ?? '',
  });
  if (keyring) credentials.push(...keyring.split('/'));

  const named = isEnvironmentName(env.ENVIRONMENT_NAME);
  if (!named || (env.ENVIRONMENT_NAME === 'development' && !isLocalOrigin(env.APP_ORIGIN)))
    credentials.push('ENVIRONMENT_NAME');
  const checked = named && env.ENVIRONMENT_NAME !== 'development';
  const slots = kekSlots(env);
  let verifiable = 0;
  for (const [version, , check] of slots) {
    if (check !== '' && !CHECK_VALUE.test(check)) credentials.push(`KEK_CHECK_V${version}`);
    else if (check !== '') verifiable++;
  }
  if (checked && slots.length > 0) {
    if (verifiable === 0) {
      const first = slots[0];
      if (first && !credentials.includes(`KEK_CHECK_V${first[0]}`))
        credentials.push(`KEK_CHECK_V${first[0]}`);
    } else {
      for (const [version, , check] of slots) if (check === '') warnings.push(`KEK_CHECK_V${version}`);
    }
  }

  if (env.ENCRYPTION_KEY && !HEX_64.test(env.ENCRYPTION_KEY)) warnings.push('ENCRYPTION_KEY');
  // Without a valid key no credential fingerprint is computed, so a revoked secret is never destroyed outside
  // development (it would otherwise be possible to paste the burned value back unnoticed): named so it is seen.
  if (!isFingerprintKey(env.FINGERPRINT_KEY)) warnings.push('FINGERPRINT_KEY');
  // Optional: unset is fine (the log sink still runs); set but unusable means alerts reach the log only.
  if (env.ALERT_WEBHOOK_URL && resolveWebhookTarget(env.ALERT_WEBHOOK_URL, env.APP_ORIGIN) === null)
    warnings.push('ALERT_WEBHOOK_URL');
  warnings.push(...githubFaults(env));
  warnings.push(...mailFaults(env));
  return { storage, credentials: [...new Set(credentials)], queue, auth: authFaults(env), warnings };
}

/** Every required-binding fault, in tier order (F04). Warnings are not included. */
export function assertConfig(env: ConfigEnv): string[] {
  const a = assessConfig(env);
  return [...a.storage, ...a.credentials, ...a.queue, ...a.auth];
}

/**
 * Does each KEK produce the check value this environment expects? A mismatch means a KEK from another
 * environment (or a mistyped one) is loaded: refuse to seal under it or open with it rather than
 * seal new credentials under the wrong key or fail every open (F34 `kek_environment_mismatch`).
 * Returns binding names, like {@link assertConfig}.
 */
export async function kekMismatches(env: ConfigEnv): Promise<string[]> {
  if (!isEnvironmentName(env.ENVIRONMENT_NAME)) return [];
  const environment = env.ENVIRONMENT_NAME;
  const names: string[] = [];
  for (const [version, kek, check] of kekSlots(env)) {
    if (!CHECK_VALUE.test(check)) continue; // absent or malformed: assessConfig's finding
    let actual: string;
    try {
      actual = await kekCheckValue(parseKeyHex(kek), environment);
    } catch {
      continue; // malformed KEK: assessConfig's finding
    }
    if (actual !== check) names.push(`KEK_CHECK_V${version}`);
  }
  return names;
}

export interface BootReport extends ConfigAssessment {
  /**
   * Faults that stop the queue consumer and `scheduled`: storage, then credentials, then queue. An `auth`
   * fault is NOT in here (neither entrypoint needs a session); it is in {@link BootReport.auth}.
   */
  readonly names: readonly string[];
  /** `kek_environment_mismatch` when a well-formed KEK does not match this environment's check value. */
  readonly code: 'config_invalid' | 'kek_environment_mismatch' | null;
  /** Names in `env` this Worker does not read: a likely typo in a secret or var. Names only, bounded. */
  readonly unknownKeys: readonly string[];
}

const memo = new WeakMap<object, Promise<BootReport>>();

async function compute(env: Bindings): Promise<BootReport> {
  const a = assessConfig(env);
  // Once per isolate (the report is memoised per env object). Names only, never a value.
  const unknown = unknownKeys(env);
  if (unknown.length > 0) log('warn', 'config_unknown_keys', { unknown_bindings: unknown });
  let credentials = a.credentials;
  let code: BootReport['code'] = null;
  if (credentials.length > 0) code = 'config_invalid';
  else {
    try {
      const mismatched = await kekMismatches(env);
      if (mismatched.length > 0) {
        credentials = mismatched;
        code = 'kek_environment_mismatch';
      }
    } catch {
      // A failure of the check itself is a configuration fault, never a thrown request.
      credentials = ['KEK_CHECK'];
      code = 'config_invalid';
    }
  }
  const names = [...a.storage, ...credentials, ...a.queue];
  return {
    storage: a.storage,
    credentials,
    queue: a.queue,
    auth: a.auth,
    warnings: a.warnings,
    unknownKeys: unknown,
    names,
    code: names.length > 0 ? (code ?? 'config_invalid') : a.auth.length > 0 ? 'config_invalid' : null,
  };
}

/**
 * Everything wrong with this Worker's configuration, or an empty report. The key check runs only when
 * the static credential checks pass, and is computed once per `env` object (the runtime hands the
 * same object to every request of an isolate), so the steady-state cost is a map lookup. Never
 * rejects, and a result that could not be computed is not remembered.
 */
export function bootReport(env: Bindings): Promise<BootReport> {
  const cached = memo.get(env);
  if (cached) return cached;
  const result = compute(env).catch((): BootReport => ({
    storage: [],
    credentials: ['KEK_CHECK'],
    queue: [],
    auth: [],
    warnings: [],
    unknownKeys: [],
    names: ['KEK_CHECK'],
    code: 'config_invalid',
  }));
  memo.set(env, result);
  void result.then((r) => {
    if (r.names.includes('KEK_CHECK') && r.code === 'config_invalid') memo.delete(env);
  });
  return result;
}
