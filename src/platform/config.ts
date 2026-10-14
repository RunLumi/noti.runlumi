import { keyringProblem } from '../crypto/keyring-env';
import { parseKeyHex } from '../crypto/envelope';
import { isEnvironmentName, isFingerprintKey, kekCheckValue } from '../crypto/fingerprint';
import type { Bindings } from '../env';
import { resolveWebhookTarget } from '../observability/alerts/sinks';

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
 *  | warnings    | `ENCRYPTION_KEY` (optional legacy key), `FINGERPRINT_KEY` (optional), `ALERT_WEBHOOK_URL` (optional, set but not a Slack, Discord, Lark or Teams webhook URL), a second KEK without a check value | nothing; `/health` lists them and only the job that needs the binding stands down |
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
    | 'ENVIRONMENT_NAME'
    | 'KEK_CHECK_V1'
    | 'KEK_CHECK_V2'
    | 'APP_ORIGIN'
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
  readonly warnings: string[];
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
  if (env.FINGERPRINT_KEY && !isFingerprintKey(env.FINGERPRINT_KEY)) warnings.push('FINGERPRINT_KEY');
  // Optional: unset is fine (the log sink still runs); set but unusable means alerts reach the log only.
  if (env.ALERT_WEBHOOK_URL && resolveWebhookTarget(env.ALERT_WEBHOOK_URL, env.APP_ORIGIN) === null)
    warnings.push('ALERT_WEBHOOK_URL');
  return { storage, credentials: [...new Set(credentials)], queue, warnings };
}

/** Every required-binding fault, in tier order (F04). Warnings are not included. */
export function assertConfig(env: ConfigEnv): string[] {
  const a = assessConfig(env);
  return [...a.storage, ...a.credentials, ...a.queue];
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
  /** Every required-binding fault: storage, then credentials, then queue. Empty when the Worker may serve. */
  readonly names: readonly string[];
  /** `kek_environment_mismatch` when a well-formed KEK does not match this environment's check value. */
  readonly code: 'config_invalid' | 'kek_environment_mismatch' | null;
}

const memo = new WeakMap<object, Promise<BootReport>>();

async function compute(env: Bindings): Promise<BootReport> {
  const a = assessConfig(env);
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
    warnings: a.warnings,
    names,
    code: names.length > 0 ? (code ?? 'config_invalid') : null,
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
    warnings: [],
    names: ['KEK_CHECK'],
    code: 'config_invalid',
  }));
  memo.set(env, result);
  void result.then((r) => {
    if (r.names.includes('KEK_CHECK') && r.code === 'config_invalid') memo.delete(env);
  });
  return result;
}
