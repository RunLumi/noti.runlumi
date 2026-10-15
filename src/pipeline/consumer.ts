import { auditStatement } from '../audit/audit';
import { isDeadWebhook } from '../connectors/destinations/discord/classify';
import type { HostVerification } from '../connectors/destinations/generic-webhook/verified';
import { verifyHostAtSend } from '../connectors/destinations/generic-webhook/host-control';
import { genericWebhookEnabled } from '../connectors/destinations/features';
import { ownHostsOf, type UrlPolicyOptions } from '../connectors/destinations/url-policy';
import {
  type ClassifiedResponse,
  classifyDeliveryResponse,
  prepareDelivery,
  sendRequest,
  validateDestinationConfig,
  type CanonicalNotification,
  type ProviderResponse,
  type ValidatedDestinationConfig,
} from '../connectors/destinations';
import { CryptoError, toBytes, type Keyring } from '../crypto/envelope';
import { keyringFromEnv } from '../crypto/keyring-env';
import { SCHEDULE_REDISPATCH_SQL, scheduleRedispatchParams } from '../delivery/claim';
import {
  attemptStatement,
  deferralStatements,
  waitingSince,
  isUnconfirmed,
  statusClassOf,
  type AttemptReport,
  type AttemptRowOutcome,
} from '../delivery/attempts';
import {
  MAX_DEFERRED_MS,
  effectOf,
  gateAttempt,
  healthStatement,
  paceFromResponse,
  type Gate,
} from '../delivery/health';
import { guardGate, recordEgress } from '../delivery/egress-guard';
import { attemptFromClassification, failed, type AttemptResult } from '../delivery/classify';
import {
  DELIVERY_CLAIM_LEASE_MS,
  claimDelivery,
  deadLetterDeferredStatement,
  deferStatement,
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
import { withMessageCorrelation } from '../platform/correlation';
import { log } from '../platform/log';
import type { DestinationKind } from './allowlist';
import { CREDENTIAL_COLUMNS, REVOKED_REASON, blob, openCredentials, type CredentialRow } from './credentials';
import { parseDeliveryMessage } from './outbox';

type IntegrationRow = CredentialRow & {
  destination: DestinationKind;
  enabled: number;
  credentials_quarantined_at: string | null;
  credentials_quarantine_reason: string | null;
};

/**
 * Mirrors `max_retries` on the `noti-deliveries` consumer in wrangler.jsonc (asserted by a
 * test). Once a message has used its queue retries, a further `msg.retry()` would hand it
 * to the dead-letter queue while the ledger still says `retrying`. From that point every
 * retry is parked on the outbox instead and re-enqueued as a fresh message.
 */
export const QUEUE_MAX_RETRIES = 5;

/** F189: per-attempt deadline, far below the 15-minute consumer wall clock. */
export const OUTBOUND_TIMEOUT_MS = 10_000;

async function loadIntegration(env: Bindings, d: DeliveryMessage): Promise<IntegrationRow | null> {
  // Tenant re-check: the row must belong to the organization the ingress resolved.
  // The state is read, not filtered in SQL, so a REVOKED row is told apart from a missing, paused or
  // quarantined one (F40). Nothing is opened until the row has passed every check in `resolveTarget`.
  return env.DB.prepare(
    `SELECT destination,enabled,credentials_quarantined_at,credentials_quarantine_reason,${CREDENTIAL_COLUMNS}
     FROM integrations WHERE id=? AND organization_id=?`,
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

/** The stored credential a delivery used, so a later write can be tied to exactly that one. */
interface UsedCredential {
  readonly envelope: ArrayBuffer | null;
  readonly ciphertext: string;
}

type Target = { config: ValidatedDestinationConfig; credential: UsedCredential } | AttemptResult;

const urlPolicyOf = (env: Bindings): UrlPolicyOptions => ({ ownHosts: ownHostsOf(env.APP_ORIGIN) });

/**
 * Re-validate the stored destination with the same policy the API applies at write time
 * (`validateDestinationConfig`), so a row altered after it was written, or a legacy row that
 * predates the policy, cannot reach the network. Rejections carry a rule name, never the URL.
 */
async function resolveTarget(env: Bindings, keyring: Keyring, d: DeliveryMessage): Promise<Target> {
  const row = await loadIntegration(env, d);
  if (!row) return failed('config_invalid', 'integration_unavailable');
  // The customer revoked this connection's credential (F40): permanent, no retry, and nothing is decrypted.
  // Queued and in-flight messages fail closed here, whenever they were enqueued.
  if (row.credentials_quarantined_at !== null && row.credentials_quarantine_reason === REVOKED_REASON)
    return failed('destination_revoked', 'credentials_revoked');
  if (row.enabled !== 1 || row.credentials_quarantined_at !== null)
    return failed('config_invalid', 'integration_unavailable');
  // A gated kind never reaches the network while its feature is off, even for a row that was
  // stored while it was on (ADR 0014). Permanent: turning the feature on and redelivering works.
  if (row.destination === 'generic_webhook' && !genericWebhookEnabled(env))
    return failed('config_invalid', 'destination_type_disabled');
  let credentials;
  try {
    credentials = await openCredentials(row, keyring, env.ENCRYPTION_KEY);
  } catch (e) {
    if (e instanceof CryptoError) return classifyCryptoError(e);
    throw e;
  }
  const checked = validateDestinationConfig(
    {
      kind: row.destination,
      webhookUrl: credentials.webhookUrl,
      // Only Lark and the custom webhook have a signing secret; a stray value on another row
      // is ignored. A custom webhook with no secret fails validation and is never sent.
      ...((row.destination === 'lark' || row.destination === 'generic_webhook') && credentials.signingSecret
        ? { signingSecret: credentials.signingSecret }
        : {}),
    },
    urlPolicyOf(env),
  );
  if (checked.ok)
    return {
      config: checked.config,
      credential: { envelope: blob(toBytes(row.webhook_envelope)), ciphertext: row.webhook_ciphertext },
    };
  return checked.reason === 'destination_url_rejected'
    ? failed('destination_url_rejected', 'destination_not_allowed')
    : failed('config_invalid', 'destination_config_invalid');
}

/** The canonical notification the adapters render. Legacy messages lack the new fields. */
export function toNotification(d: DeliveryMessage): CanonicalNotification {
  return {
    title: d.title,
    eventType: d.eventType ?? DEFAULT_EVENT_TYPE,
    ...(d.url ? { url: d.url } : {}),
    ...(d.repo ? { repo: d.repo } : {}),
    ...(d.actor ? { actor: d.actor } : {}),
    ...(d.status ? { status: d.status } : {}),
    ...(d.summary ? { summary: d.summary } : {}),
  };
}

const DEFAULT_EVENT_TYPE = 'notification';

async function attemptDelivery(
  env: Bindings,
  keyring: Keyring,
  d: DeliveryMessage,
  deps: ConsumerDeps,
  attempt: number,
): Promise<AttemptReport> {
  const target = await resolveTarget(env, keyring, d);
  if ('outcome' in target) return reportOf(target, null, null);
  const { config, credential } = target;
  const prepared = await prepareDelivery(config, toNotification(d), {
    now: deps.now(),
    meta: { deliveryId: d.id, organizationId: d.organizationId },
  });
  if (!prepared.ok) {
    // Permanent by construction: the same text re-renders to the same failure.
    return reportOf(
      prepared.reason === 'payload_too_large'
        ? failed('payload_too_large', 'render_payload_too_large')
        : failed('render_failed', 'render_failed'),
      null,
      null,
    );
  }
  // A custom webhook goes only to a host the workspace approved, re-resolved when its record is stale and
  // refused if it now points at a private or reserved address (host-control.ts, ADR 0029). Fails closed.
  let hostVerification: HostVerification | undefined;
  if (config.kind === 'generic_webhook') {
    const hostCheck = await verifyHostAtSend(
      { db: env.DB, urlPolicy: urlPolicyOf(env) },
      d.organizationId,
      d.integrationId,
      new URL(prepared.request.url).hostname,
      deps.now(),
    );
    if (!hostCheck.ok)
      return reportOf(
        hostCheck.reason === 'lookup_failed'
          ? failed('destination_unavailable', 'host_lookup_failed')
          : failed(
              'destination_url_rejected',
              hostCheck.reason === 'host_not_allowed' ? 'host_not_allowed' : `host_${hostCheck.reason}`,
            ),
        null,
        null,
      );
    hostVerification = hostCheck.verification;
  }
  // Platform-wide, cross-tenant guard (egress-guard.ts): a Discord request that would feed the shared
  // invalid-request budget, or exceed the shared rate, waits instead of leaving the platform.
  if (config.kind === 'discord') {
    const guard = await guardGate(
      env.DB,
      'discord',
      { organizationId: d.organizationId, integrationId: d.integrationId },
      deps.now(),
    );
    if (guard.action === 'defer')
      return {
        ...reportOf(failed('destination_unavailable', guard.reason), null, null),
        deferred: { untilMs: guard.untilMs, reason: guard.reason },
      };
  }
  const seen: { res: ProviderResponse | null } = { res: null };
  const sent = await sendRequest(
    prepared.request,
    (res, at) => {
      seen.res = res;
      return classifyDeliveryResponse(config.kind, res, at);
    },
    {
      timeoutMs: OUTBOUND_TIMEOUT_MS,
      now: deps.now,
      urlPolicy: urlPolicyOf(env),
      ...(hostVerification ? { hostVerification } : {}),
    },
  );
  if (config.kind === 'discord')
    await recordEgress(
      env.DB,
      'discord',
      { organizationId: d.organizationId, integrationId: d.integrationId },
      deps.now(),
      seen.res?.status ?? null,
    );
  const classification = config.kind === 'discord' ? capDiscordAuthRetries(sent, attempt) : sent;
  if (config.kind === 'discord' && seen.res && isDeadWebhook(seen.res.status, classification)) {
    try {
      await pauseDeadDiscordWebhook(env, d, credential, classification, seen.res.status);
    } catch (e) {
      // The pause is a safeguard on top of an outcome that is already permanent; a D1 fault
      // here must not turn that outcome into a retry. The next failure pauses it instead.
      log('error', 'discord_auto_pause_failed', { delivery_id: d.id, error: e });
    }
  }
  const result = attemptFromClassification(classification, config.kind, seen.res);
  const shown = config.kind === 'generic_webhook' ? coarsenUnreachable(result) : result;
  const report = reportOf(shown, seen.res, classification, deps.now());
  if (shown.unmapped) {
    // F230: a provider reply no mapping covers is a countable event of its own, so a provider
    // changing its error shapes shows up as a rate rather than a scatter of generic failures.
    // Kind, attempt, numeric status and status class only: never the reply body, the status text or the webhook URL.
    log('warn', 'unmapped_provider_response', {
      delivery_id: d.id,
      workspace_id: d.organizationId,
      integration_id: d.integrationId,
      destination_kind: config.kind,
      attempt,
      // The numeric HTTP status is not a secret and is what tells an operator which reply to map.
      provider_status: seen.res?.status ?? null,
      status_class: report.statusClass,
    });
  }
  return report;
}

/**
 * Everything an attempt tells the ledger beyond the retry policy's inputs: the status CLASS (never
 * the status), and how long the destination asked to be left alone (rate-limit headers, a 429's
 * `Retry-After`). `provider_message_id` is always null today: no adapter response carries one.
 */
function reportOf(
  result: AttemptResult,
  res: ProviderResponse | null,
  classification: ClassifiedResponse | null,
  nowMs: number = Date.now(),
): AttemptReport {
  return {
    result,
    statusClass: statusClassOf(res, result.diagnostic),
    paceMs: classification
      ? paceFromResponse(
          res?.headers ?? null,
          classification.retryAfterMs,
          classification.reason === 'destination_rate_limited',
          nowMs,
        )
      : null,
    providerMessageId: null,
  };
}

/**
 * A customer endpoint's connection failures (timeout, refused, DNS, TLS, reset) are shown to
 * the tenant as one thing. Distinguishing them would let a tenant probe what answers on a
 * private address by choosing hosts and reading the reason (ADR 0014). HTTP statuses, which the
 * customer needs to fix their own endpoint, are not touched.
 */
function coarsenUnreachable(r: AttemptResult): AttemptResult {
  const o = r.outcome;
  if (
    o.kind === 'failed' &&
    (r.diagnostic === 'provider_timeout' || r.diagnostic === 'transient_error') &&
    (o.code === 'destination_timeout' || o.code === 'destination_unavailable')
  )
    return {
      ...r,
      outcome: { ...o, code: 'destination_unavailable' },
      diagnostic: 'destination_unreachable',
    };
  return r;
}

/**
 * An unclassified Discord 401/403 is retryable (it is not a dead webhook), but each one spends
 * the shared invalid-request budget, so only the first attempts are allowed to repeat.
 */
export const DISCORD_UNAUTHORIZED_MAX_ATTEMPTS = 2;

function capDiscordAuthRetries(c: ClassifiedResponse, attempt: number): ClassifiedResponse {
  const unauthorized = c.providerCode === 'http_401' || c.providerCode === 'http_403';
  if (c.outcome === 'retryable' && unauthorized && attempt >= DISCORD_UNAUTHORIZED_MAX_ATTEMPTS)
    return { outcome: 'permanent', reason: 'destination_unauthorized', providerCode: c.providerCode };
  return c;
}

/**
 * Discord says a webhook that returned 404 must not be used again ("repeated attempts to do so
 * will result in a temporary restriction"), and 401/403 count toward an invalid-request budget
 * shared by every Discord delivery from our egress (spec 09 F108). This delivery is already
 * permanent; pausing the integration is what stops the NEXT event from making the same
 * request. It is an audited, visible pause the customer lifts after fixing the webhook.
 *
 * Not built: the global, cross-workspace circuit breaker F108 describes. One dead webhook
 * costs one request per workspace that uses it, then the pause takes over.
 */
async function pauseDeadDiscordWebhook(
  env: Bindings,
  d: DeliveryMessage,
  credential: UsedCredential,
  classification: ClassifiedResponse,
  status: number,
): Promise<void> {
  // Tied to the credential THIS delivery used: if the customer replaced the webhook after the
  // attempt began, the new URL is not paused for the old one's failure. The pause and its audit
  // row are one batch, and the audit row is written only if the pause changed a row.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE integrations SET enabled=0,updated_at=CURRENT_TIMESTAMP
       WHERE id=?1 AND organization_id=?2 AND destination='discord' AND enabled=1
         AND webhook_envelope IS ?3 AND webhook_ciphertext=?4`,
    ).bind(d.integrationId, d.organizationId, credential.envelope, credential.ciphertext),
    auditStatement(
      env.DB,
      {
        organizationId: d.organizationId,
        actorId: null,
        action: 'integration.auto_pause',
        subjectType: 'integration',
        subjectId: d.integrationId,
        outcome: 'success',
        metadata: {
          destination: 'discord',
          providerStatus: status,
          reason: classification.reason,
          ...(classification.providerCode ? { providerCode: classification.providerCode } : {}),
        },
      },
      undefined,
      { onlyIfPreviousStatementChangedRows: true },
    ),
  ]);
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
  report: AttemptReport,
  attempt: number,
  nowMs: number,
): OutcomeRecord {
  const result = report.result;
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
    // F185: a retry after an attempt whose outcome we could not observe may show the message twice.
    possibleDuplicate: decision.action === 'retry' && isUnconfirmed(report),
    providerMessageId: report.providerMessageId,
  };
}

const ROW_OUTCOME: Readonly<Record<OutcomeRecord['state'], AttemptRowOutcome>> = {
  sent: 'delivered',
  accepted: 'accepted',
  retrying: 'retry_scheduled',
  dead_lettered: 'dead_lettered',
};

function scheduleStatement(env: Bindings, d: DeliveryMessage, notBeforeMs: number): D1PreparedStatement {
  return env.DB.prepare(SCHEDULE_REDISPATCH_SQL).bind(
    ...scheduleRedispatchParams(d.organizationId, d.id, notBeforeMs),
  );
}

/**
 * Persist the outcome, then act on the message. Nothing downstream happens unless the
 * fenced write changed exactly our row (H2): a consumer that lost its claim acks and leaves
 * the delivery to the new holder.
 *
 * One batch, one transaction: the ledger transition, then the statements gated on it
 * (`changes() = 1`: the attempt row, the destination-health update), then, for a wait the queue
 * cannot hold, the outbox park. The park statement is itself guarded on the ledger row being
 * `retrying` at exactly this time, so it is a no-op if the write changed nothing.
 */
async function applyDecision(
  env: Bindings,
  msg: QueueMessage,
  d: DeliveryMessage,
  decision: RetryDecision,
  record: OutcomeRecord,
  gated: readonly D1PreparedStatement[],
  claim: Claim,
): Promise<boolean> {
  const write = recordOutcomeStatement(env.DB, d, claim.token, record);
  if (decision.action === 'retry' && decision.transport === 'schedule' && record.nextAttemptAtMs !== null) {
    const [written] = await env.DB.batch([
      write,
      ...gated,
      scheduleStatement(env, d, record.nextAttemptAtMs),
    ]);
    msg.ack();
    return written?.meta.changes === 1;
  }
  const [written] = await env.DB.batch([write, ...gated]);
  const recorded = written?.meta.changes === 1;
  if (recorded && decision.action === 'retry') msg.retry({ delaySeconds: decision.delaySeconds });
  else msg.ack();
  return recorded;
}

/**
 * The statements that record an attempt beside its ledger transition. The attempt row must come
 * DIRECTLY after the ledger write and the health update directly after the attempt row: each is
 * gated on `changes() = 1` of the statement before it.
 */
function gatedStatements(
  env: Bindings,
  d: DeliveryMessage,
  claim: Claim,
  gate: Gate,
  report: AttemptReport,
  record: OutcomeRecord,
  startedAtMs: number,
): D1PreparedStatement[] {
  const outcome = report.result.outcome;
  const statements = [
    attemptStatement(env.DB, d, {
      attempt: record.attempt,
      startedAtMs,
      finishedAtMs: record.nowMs,
      outcome: ROW_OUTCOME[record.state],
      errorCode: record.code,
      reason: record.diagnostic,
      statusClass: report.statusClass,
      retryAfterMs:
        outcome.kind === 'failed' && outcome.retryAfterSeconds ? outcome.retryAfterSeconds * 1000 : null,
      providerMessageId: report.providerMessageId,
      possibleDuplicate: record.possibleDuplicate === true,
    }),
  ];
  // A test notification is not evidence about the destination (ADR 0018) and is never paced or broken.
  if (!claim.isTest) {
    const health = healthStatement(
      env.DB,
      d,
      {
        effect: effectOf(outcome, report.statusClass),
        nowMs: record.nowMs,
        code: record.code,
        paceMs: report.paceMs,
      },
      gate.action === 'proceed' && gate.known,
    );
    if (health) statements.push(health);
  }
  return statements;
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
  deps: ConsumerDeps,
  attempt: number,
): Promise<AttemptReport> {
  try {
    return await attemptDelivery(env, keyring, d, deps, attempt);
  } catch (e) {
    // Anything unexpected after the claim still produces an outcome, so the claim is
    // released through the normal (bounded) retry path rather than held forever (H1).
    log('error', 'delivery_attempt_failed', { delivery_id: d.id, error: e });
    return reportOf(failed('internal_error', 'consumer_error'), null, null);
  }
}

/**
 * F183/F187: may this claimed delivery call its destination now? A health-table fault must never
 * stop deliveries, so it fails OPEN (proceed) and is logged; the breaker is a safeguard, not a gate
 * the product depends on.
 */
async function gateOrProceed(env: Bindings, d: DeliveryMessage, claim: Claim, nowMs: number): Promise<Gate> {
  if (claim.isTest) return { action: 'proceed', probe: false, known: false };
  try {
    return await gateAttempt(env.DB, d, nowMs);
  } catch (e) {
    log('error', 'destination_health_unreadable', { delivery_id: d.id, error: e });
    return { action: 'proceed', probe: false, known: false };
  }
}

/**
 * Send the delivery back without calling the destination (breaker open, or the destination asked to
 * be left alone). No attempt is spent and nothing is dead-lettered by a SHORT wait; the attempt log gets
 * one `deferred` row per run of identical waits, so "why has this not been sent" has an answer without
 * hundreds of rows. A delivery held back for more than {@link MAX_DEFERRED_MS} with no real attempt in
 * between is dead-lettered instead (replayable), so a destination that never recovers cannot hold
 * deliveries for weeks.
 */
async function deferDelivery(
  env: Bindings,
  msg: QueueMessage,
  d: DeliveryMessage,
  claim: Claim,
  gate: Extract<Gate, { action: 'defer' }>,
  nowMs: number,
): Promise<void> {
  const since = await waitingSince(env.DB, d);
  if (since !== null && nowMs - since > MAX_DEFERRED_MS) {
    const reason = `${gate.reason}_timeout`;
    const [written] = await env.DB.batch([
      deadLetterDeferredStatement(env.DB, d, claim.token, nowMs, reason),
      attemptStatement(env.DB, d, {
        attempt: claim.attempts,
        startedAtMs: nowMs,
        finishedAtMs: nowMs,
        outcome: 'dead_lettered',
        errorCode: 'destination_unavailable',
        reason,
        statusClass: 'none',
        retryAfterMs: null,
        providerMessageId: null,
        possibleDuplicate: false,
      }),
    ]);
    msg.ack();
    log('warn', 'delivery_deferral_timeout', {
      delivery_id: d.id,
      workspace_id: d.organizationId,
      integration_id: d.integrationId,
      reason,
      recorded: written?.meta.changes === 1,
    });
    return;
  }
  const code = gate.reason === 'destination_paced' ? 'destination_rate_limited' : 'destination_unavailable';
  const wait = secondsUntil(gate.untilMs, nowMs);
  const viaQueue = queueRetriesLeft(msg) && wait <= QUEUE_MAX_DELAY_SECONDS;
  const untilMs = nowMs + wait * 1000;
  const [written] = await env.DB.batch([
    deferStatement(env.DB, d, claim.token, untilMs, code, gate.reason),
    ...deferralStatements(env.DB, d, {
      attemptsUsed: claim.attempts,
      nowMs,
      untilMs,
      errorCode: code,
      reason: gate.reason,
      retryAfterMs: wait * 1000,
    }),
    ...(viaQueue ? [] : [scheduleStatement(env, d, untilMs)]),
  ]);
  if (viaQueue && written?.meta.changes === 1) msg.retry({ delaySeconds: wait });
  else msg.ack();
  log('info', 'delivery_deferred', {
    delivery_id: d.id,
    workspace_id: d.organizationId,
    integration_id: d.integrationId,
    reason: gate.reason,
    recorded: written?.meta.changes === 1,
  });
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
  const gate = await gateOrProceed(env, d, claim, claimedAt);
  if (gate.action === 'defer') {
    await deferDelivery(env, msg, d, claim, gate, claimedAt);
    return;
  }
  const report = await attemptSafely(env, keyring, d, deps, attempt);
  if (report.deferred) {
    await deferDelivery(
      env,
      msg,
      d,
      claim,
      { action: 'defer', untilMs: report.deferred.untilMs, reason: report.deferred.reason },
      deps.now(),
    );
    return;
  }
  const result = report.result;
  const decision = effectiveDecision(
    decideRetry({ attempt, outcome: result.outcome, random: deps.random }),
    msg,
  );
  const record = outcomeRecord(decision, report, attempt, deps.now());
  const gated = gatedStatements(env, d, claim, gate, report, record, claimedAt);
  const recorded = await applyDecision(env, msg, d, decision, record, gated, claim);
  log(decision.action === 'dead_letter' ? 'warn' : 'info', 'delivery_attempt', {
    delivery_id: d.id,
    workspace_id: d.organizationId,
    integration_id: d.integrationId,
    attempt,
    outcome: recorded ? record.state : 'claim_lost',
    error_code: record.code,
    unmapped_provider_error: result.unmapped,
    status_class: report.statusClass,
    probe: gate.probe,
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
    // The consumer has no request to inherit a correlation id from: bind the one the message carries,
    // so every log line of this delivery (including the failure line below) names it (F193).
    await withMessageCorrelation(parseDeliveryMessage(msg.body)?.correlationId, async () => {
      try {
        await handleMessage(msg, env, keyring, deps);
      } catch (e) {
        // A ledger or platform failure (D1 down). Retried per message (F176). If the claim
        // was taken, the cron backstop releases it after the lease, and once queue retries
        // run out the DLQ consumer dead-letters the row (H1).
        log('error', 'delivery_consumer_failed', { error: e });
        msg.retry();
      }
    });
  }
}
