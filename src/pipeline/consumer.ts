import { larkPayload } from '../connectors/destinations/lark/webhook';
import { CryptoError, type Keyring } from '../crypto/envelope';
import { keyringFromEnv } from '../crypto/keyring-env';
import { SCHEDULE_REDISPATCH_SQL, scheduleRedispatchParams } from '../delivery/claim';
import {
  classifyHttpFailure,
  classifyLarkReply,
  classifyThrown,
  type Classified,
} from '../delivery/classify';
import {
  DELIVERY_CLAIM_LEASE_MS,
  claimDelivery,
  loadDelivery,
  recordOutcomeStatement,
  type OutcomeRecord,
} from '../delivery/ledger';
import { decideRetry, type AttemptOutcome, type RandomSource, type RetryDecision } from '../delivery/retry';
import { isTerminal, transition, type DeliveryEvent } from '../delivery/state';
import type { Bindings, DeliveryMessage } from '../env';
import type { ErrorCode } from '../platform/errors';
import { log } from '../platform/log';
import { destinationAllowed, type DestinationKind } from './allowlist';
import { CREDENTIAL_COLUMNS, openCredentials, type CredentialRow } from './credentials';
import { parseDeliveryMessage } from './outbox';

type IntegrationRow = CredentialRow & { destination: DestinationKind };

/**
 * Mirrors `max_retries` on the `noti-deliveries` consumer in wrangler.jsonc (asserted by a
 * test). Once a message has used its queue retries, a further `msg.retry()` would hand it
 * to the dead-letter queue while the ledger still says `retrying`. From that point every
 * retry is parked on the outbox instead and re-enqueued as a fresh message.
 */
export const QUEUE_MAX_RETRIES = 5;

/** F189: per-attempt deadline, far below the 15-minute consumer wall clock. */
export const OUTBOUND_TIMEOUT_MS = 10_000;

/** The result of one attempt: the outcome for the retry policy plus a minted diagnostic. */
interface AttemptResult {
  readonly outcome: AttemptOutcome;
  readonly diagnostic: string | null;
  readonly unmapped: boolean;
}

const DELIVERED: AttemptResult = { outcome: { kind: 'delivered' }, diagnostic: null, unmapped: false };

function failed(code: ErrorCode, diagnostic: string, retryAfterSeconds: number | null = null): AttemptResult {
  return { outcome: { kind: 'failed', code, retryAfterSeconds }, diagnostic, unmapped: false };
}

function fromClassified(c: Classified): AttemptResult {
  return {
    outcome: { kind: 'failed', code: c.code, retryAfterSeconds: c.retryAfterSeconds },
    diagnostic: c.diagnostic,
    unmapped: c.unmapped,
  };
}

async function loadIntegration(env: Bindings, d: DeliveryMessage): Promise<IntegrationRow | null> {
  // Tenant re-check: the row must belong to the organization the ingress resolved.
  return env.DB.prepare(
    `SELECT destination,${CREDENTIAL_COLUMNS} FROM integrations
     WHERE id=? AND organization_id=? AND enabled=1 AND credentials_quarantined_at IS NULL`,
  )
    .bind(d.integrationId, d.organizationId)
    .first<IntegrationRow>();
}

/**
 * Only defects in the row's own bytes are permanent. A wrong or missing key, or an unknown
 * KEK version, is a deployment fault: retrying after the fix delivers, so it is classified
 * `internal_error` (retryable) and never dead-lettered on the first attempt.
 */
function classifyCryptoError(e: CryptoError): AttemptResult {
  if (e.code === 'destination_credentials_invalid') return failed('destination_credentials_invalid', e.code);
  if (e.code === 'malformed_envelope') return failed('config_invalid', e.code);
  return failed('internal_error', `provider_config_${e.code}`);
}

type Target = { url: URL; payload: unknown; destination: DestinationKind } | AttemptResult;

async function resolveTarget(env: Bindings, keyring: Keyring, d: DeliveryMessage): Promise<Target> {
  const row = await loadIntegration(env, d);
  if (!row) return failed('config_invalid', 'integration_unavailable');
  let credentials;
  try {
    credentials = await openCredentials(row, keyring, env.ENCRYPTION_KEY);
  } catch (e) {
    if (e instanceof CryptoError) return classifyCryptoError(e);
    throw e;
  }
  let url: URL;
  try {
    url = new URL(credentials.webhookUrl);
  } catch {
    // The URL parser's message echoes its input, which is a secret. Never surface it.
    return failed('destination_url_rejected', 'destination_url_invalid');
  }
  if (!destinationAllowed(url, row.destination))
    return failed('destination_url_rejected', 'destination_not_allowed');
  const payload =
    row.destination === 'slack'
      ? { text: `${d.title}\n${d.url}` }
      : await larkPayload({ title: d.title, url: d.url }, credentials.signingSecret ?? undefined);
  return { url, payload, destination: row.destination };
}

async function post(url: URL, payload: unknown): Promise<Response | AttemptResult> {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    });
  } catch (e) {
    return fromClassified(classifyThrown(e));
  }
}

async function readLarkReply(res: Response): Promise<AttemptResult> {
  let reply: unknown;
  try {
    reply = await res.json();
  } catch {
    reply = null;
  }
  const rejected = classifyLarkReply(reply);
  return rejected ? fromClassified(rejected) : DELIVERED;
}

async function attemptDelivery(
  env: Bindings,
  keyring: Keyring,
  d: DeliveryMessage,
  nowMs: number,
): Promise<AttemptResult> {
  const target = await resolveTarget(env, keyring, d);
  if ('outcome' in target) return target;
  const res = await post(target.url, target.payload);
  if (!(res instanceof Response)) return res;
  if (!res.ok) {
    // Release the connection; the body is never read, so it can never reach a log.
    await res.body?.cancel();
    return fromClassified(classifyHttpFailure(res.status, res.headers, nowMs));
  }
  if (target.destination === 'slack') {
    await res.body?.cancel();
    return DELIVERED;
  }
  return readLarkReply(res);
}

export interface ConsumerDeps {
  readonly random: RandomSource;
  readonly now: () => number;
}

const DEFAULT_DEPS: ConsumerDeps = { random: Math.random, now: () => Date.now() };

/** The queue-facing subset of `Message` we use, so tests can supply plain objects. */
interface QueueMessage {
  readonly body: unknown;
  readonly attempts?: number;
  ack(): void;
  retry(options?: QueueRetryOptions): void;
}

/** Queue retries are only safe while the message has retries left (see QUEUE_MAX_RETRIES). */
function effectiveDecision(decision: RetryDecision, msg: QueueMessage): RetryDecision {
  if (decision.action !== 'retry' || decision.transport !== 'queue') return decision;
  const attempts = typeof msg.attempts === 'number' ? msg.attempts : 1;
  return attempts >= QUEUE_MAX_RETRIES ? { ...decision, transport: 'schedule' } : decision;
}

function outcomeEvent(decision: RetryDecision, outcome: AttemptOutcome): DeliveryEvent {
  if (decision.action === 'retry') {
    return { type: 'retry_scheduled', code: outcome.kind === 'failed' ? outcome.code : 'internal_error' };
  }
  if (decision.action === 'dead_letter') return { type: 'dead_letter', code: decision.code };
  return { type: outcome.kind === 'accepted' ? 'accepted' : 'delivered' };
}

function outcomeRecord(
  decision: RetryDecision,
  result: AttemptResult,
  attempt: number,
  nowMs: number,
): OutcomeRecord {
  const code = result.outcome.kind === 'failed' ? result.outcome.code : null;
  const event = outcomeEvent(decision, result.outcome);
  const moved = transition('claimed', event);
  if (!moved.ok) throw new Error(`illegal ledger transition ${moved.from} → ${moved.event}`);
  return {
    state: moved.to as OutcomeRecord['state'],
    attempt,
    nowMs,
    code,
    diagnostic: result.diagnostic,
    nextAttemptAtMs: decision.action === 'retry' ? nowMs + decision.delaySeconds * 1000 : null,
  };
}

async function applyDecision(
  env: Bindings,
  msg: QueueMessage,
  d: DeliveryMessage,
  decision: RetryDecision,
  record: OutcomeRecord,
): Promise<void> {
  const write = recordOutcomeStatement(env.DB, d, record);
  if (decision.action === 'retry' && decision.transport === 'schedule' && record.nextAttemptAtMs !== null) {
    // One transaction: the ledger says `retrying` exactly when the outbox row is parked.
    await env.DB.batch([
      write,
      env.DB.prepare(SCHEDULE_REDISPATCH_SQL).bind(
        ...scheduleRedispatchParams(d.organizationId, d.id, record.nextAttemptAtMs),
      ),
    ]);
    msg.ack();
    return;
  }
  await write.run();
  if (decision.action === 'retry') msg.retry({ delaySeconds: decision.delaySeconds });
  else msg.ack();
}

async function handleMessage(
  msg: QueueMessage,
  env: Bindings,
  keyring: Keyring,
  deps: ConsumerDeps,
): Promise<void> {
  const d = parseDeliveryMessage(msg.body);
  if (!d) {
    // Not a message we wrote. Nothing to record against; drop it rather than loop.
    log('warn', 'delivery_message_unparseable');
    msg.ack();
    return;
  }
  const row = await loadDelivery(env.DB, d);
  if (!row) {
    // Unknown row, or a message naming a tenant that does not own it: never written to.
    log('warn', 'delivery_not_found', { delivery_id: d.id, workspace_id: d.organizationId });
    msg.ack();
    return;
  }
  // A redelivered message for a finished delivery makes no second provider call. This
  // narrows, but cannot close, the at-least-once window.
  if (isTerminal(row.state)) {
    msg.ack();
    return;
  }
  if (!(await claimDelivery(env.DB, d, deps.now()))) {
    // Another consumer holds a live claim. Check back once it must have finished.
    msg.retry({ delaySeconds: Math.ceil(DELIVERY_CLAIM_LEASE_MS / 1000) });
    return;
  }
  const attempt = row.attempts + 1;
  const result = await attemptDelivery(env, keyring, d, deps.now());
  const decision = effectiveDecision(
    decideRetry({ attempt, outcome: result.outcome, random: deps.random }),
    msg,
  );
  const record = outcomeRecord(decision, result, attempt, deps.now());
  await applyDecision(env, msg, d, decision, record);
  log(decision.action === 'dead_letter' ? 'warn' : 'info', 'delivery_attempt', {
    delivery_id: d.id,
    workspace_id: d.organizationId,
    integration_id: d.integrationId,
    attempt,
    outcome: record.state,
    error_code: record.code,
    unmapped_provider_error: result.unmapped,
  });
}

export async function consumeDeliveries(
  batch: MessageBatch<unknown>,
  env: Bindings,
  deps: ConsumerDeps = DEFAULT_DEPS,
): Promise<void> {
  let keyring: Keyring;
  try {
    keyring = keyringFromEnv(env);
  } catch {
    // Misconfigured keys: nothing in this batch can be delivered, and nothing is lost.
    // /health reports which binding is wrong.
    batch.retryAll();
    return;
  }
  for (const msg of batch.messages) {
    try {
      await handleMessage(msg, env, keyring, deps);
    } catch (e) {
      // A ledger or platform failure: nothing was recorded, so the message is retried
      // (F176: per message, never the batch).
      log('error', 'delivery_consumer_failed', { error: e });
      msg.retry();
    }
  }
}
