import { larkPayload } from '../connectors/destinations/lark/webhook';
import { CryptoError, type Keyring } from '../crypto/envelope';
import { keyringFromEnv } from '../crypto/keyring-env';
import { SCHEDULE_REDISPATCH_SQL, scheduleRedispatchParams } from '../delivery/claim';
import {
  classifyHttpFailure,
  classifyLarkReply,
  classifyRedirect,
  classifyThrown,
  type Classified,
} from '../delivery/classify';
import {
  DELIVERY_CLAIM_LEASE_MS,
  claimDelivery,
  loadDelivery,
  recordOutcomeStatement,
  type Claim,
  type OutcomeRecord,
} from '../delivery/ledger';
import {
  QUEUE_MAX_DELAY_SECONDS,
  decideRetry,
  type AttemptOutcome,
  type RandomSource,
  type RetryDecision,
} from '../delivery/retry';
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
      // `manual`, not `error`: a redirect is then an observable 3xx we classify as permanent,
      // instead of a TypeError indistinguishable from a network fault (F189). Never followed.
      redirect: 'manual',
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    });
  } catch (e) {
    return fromClassified(classifyThrown(e));
  }
}

const UNCONFIRMED: AttemptResult = {
  outcome: { kind: 'accepted' },
  diagnostic: 'provider_reply_unreadable',
  unmapped: true,
};

async function readLarkReply(res: Response): Promise<AttemptResult> {
  let reply: unknown;
  try {
    reply = await res.json();
  } catch {
    reply = null;
  }
  const verdict = classifyLarkReply(reply);
  if (verdict.kind === 'delivered') return DELIVERED;
  if (verdict.kind === 'unconfirmed') return UNCONFIRMED;
  return fromClassified(verdict.classified);
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
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    return fromClassified(classifyRedirect(res.status));
  }
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
  readonly newClaimToken: () => string;
}

const DEFAULT_DEPS: ConsumerDeps = {
  random: Math.random,
  now: () => Date.now(),
  newClaimToken: () => crypto.randomUUID(),
};

/** The queue-facing subset of `Message` we use, so tests can supply plain objects. */
interface QueueMessage {
  readonly body: unknown;
  readonly attempts?: number;
  ack(): void;
  retry(options?: QueueRetryOptions): void;
}

/**
 * Whether `msg.retry()` is still safe. On the message's last allowed delivery, a retry
 * would hand it to the dead-letter queue, so every path parks or acks instead.
 */
function queueRetriesLeft(msg: QueueMessage): boolean {
  const attempts = typeof msg.attempts === 'number' ? msg.attempts : 1;
  return attempts < QUEUE_MAX_RETRIES;
}

function effectiveDecision(decision: RetryDecision, msg: QueueMessage): RetryDecision {
  if (decision.action !== 'retry' || decision.transport !== 'queue') return decision;
  return queueRetriesLeft(msg) ? decision : { ...decision, transport: 'schedule' };
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
  const moved = transition('claimed', outcomeEvent(decision, result.outcome));
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

function scheduleStatement(env: Bindings, d: DeliveryMessage, notBeforeMs: number): D1PreparedStatement {
  return env.DB.prepare(SCHEDULE_REDISPATCH_SQL).bind(
    ...scheduleRedispatchParams(d.organizationId, d.id, notBeforeMs),
  );
}

/**
 * Persist the outcome, then act on the message. Nothing downstream happens unless the
 * fenced write changed exactly our row (H2): a consumer that lost its claim acks and leaves
 * the delivery to the new holder.
 */
async function applyDecision(
  env: Bindings,
  msg: QueueMessage,
  d: DeliveryMessage,
  claim: Claim,
  decision: RetryDecision,
  record: OutcomeRecord,
): Promise<boolean> {
  const write = recordOutcomeStatement(env.DB, d, claim.token, record);
  if (decision.action === 'retry' && decision.transport === 'schedule' && record.nextAttemptAtMs !== null) {
    // One transaction. The park statement is itself guarded on the ledger row being
    // `retrying` at exactly this time, so it is a no-op if the write changed nothing.
    const [written] = await env.DB.batch([write, scheduleStatement(env, d, record.nextAttemptAtMs)]);
    msg.ack();
    return written?.meta.changes === 1;
  }
  const recorded = (await write.run()).meta.changes === 1;
  if (recorded && decision.action === 'retry') msg.retry({ delaySeconds: decision.delaySeconds });
  else msg.ack();
  return recorded;
}

/** Seconds until `atMs`, at least 1. */
function secondsUntil(atMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((atMs - nowMs) / 1000));
}

/**
 * The row exists and is not terminal, but we could not claim it.
 * - `retrying` and not yet due (M1): wait out the remainder — by queue delay while retries
 *   remain and the wait fits, otherwise by parking the outbox row.
 * - `claimed` by a live consumer: check back after the lease while retries remain; on the
 *   last one, ack — the holder finishes, or the cron backstop releases a dead claim (H1).
 */
async function handleUnclaimable(
  env: Bindings,
  msg: QueueMessage,
  d: DeliveryMessage,
  nowMs: number,
): Promise<void> {
  const row = await loadDelivery(env.DB, d);
  if (!row || isTerminal(row.state)) {
    msg.ack();
    return;
  }
  if (row.state === 'retrying' && row.next_attempt_at !== null && row.next_attempt_at > nowMs) {
    const wait = secondsUntil(row.next_attempt_at, nowMs);
    if (queueRetriesLeft(msg) && wait <= QUEUE_MAX_DELAY_SECONDS) {
      msg.retry({ delaySeconds: wait });
      return;
    }
    await scheduleStatement(env, d, row.next_attempt_at).run();
    msg.ack();
    return;
  }
  if (queueRetriesLeft(msg)) msg.retry({ delaySeconds: Math.ceil(DELIVERY_CLAIM_LEASE_MS / 1000) });
  else msg.ack();
}

async function attemptSafely(
  env: Bindings,
  keyring: Keyring,
  d: DeliveryMessage,
  nowMs: number,
): Promise<AttemptResult> {
  try {
    return await attemptDelivery(env, keyring, d, nowMs);
  } catch (e) {
    // Anything unexpected after the claim still produces an outcome, so the claim is
    // released through the normal (bounded) retry path rather than held forever (H1).
    log('error', 'delivery_attempt_failed', { delivery_id: d.id, error: e });
    return failed('internal_error', 'consumer_error');
  }
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
  const claimedAt = deps.now();
  const claim = await claimDelivery(env.DB, d, claimedAt, deps.newClaimToken());
  if (!claim) {
    await handleUnclaimable(env, msg, d, claimedAt);
    return;
  }
  // The attempt number comes from the claim's RETURNING row, not the earlier read (M2).
  const attempt = claim.attempts + 1;
  const result = await attemptSafely(env, keyring, d, deps.now());
  const decision = effectiveDecision(
    decideRetry({ attempt, outcome: result.outcome, random: deps.random }),
    msg,
  );
  const record = outcomeRecord(decision, result, attempt, deps.now());
  const recorded = await applyDecision(env, msg, d, claim, decision, record);
  log(decision.action === 'dead_letter' ? 'warn' : 'info', 'delivery_attempt', {
    delivery_id: d.id,
    workspace_id: d.organizationId,
    integration_id: d.integrationId,
    attempt,
    outcome: recorded ? record.state : 'claim_lost',
    error_code: record.code,
    unmapped_provider_error: result.unmapped,
  });
}

/** Back-off for a whole batch when the key ring is unusable (F04): an operator must act. */
export const KEYRING_RETRY_DELAY_SECONDS = 60;

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
    // /health reports which binding is wrong. If the fault outlasts the queue's retries,
    // the DLQ consumer dead-letters the rows, so they stay visible and replayable.
    batch.retryAll({ delaySeconds: KEYRING_RETRY_DELAY_SECONDS });
    return;
  }
  for (const msg of batch.messages) {
    try {
      await handleMessage(msg, env, keyring, deps);
    } catch (e) {
      // A ledger or platform failure (D1 down). Retried per message (F176). If the claim
      // was taken, the cron backstop releases it after the lease, and once queue retries
      // run out the DLQ consumer dead-letters the row (H1).
      log('error', 'delivery_consumer_failed', { error: e });
      msg.retry();
    }
  }
}
