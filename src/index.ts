import { Hono } from 'hono';
import { createAuth } from './auth/better-auth';
import { api as githubApi, browser as githubBrowser } from './api/github';
import audit from './api/audit';
import deliveries from './api/deliveries';
import integrations from './api/integrations';
import routing from './api/routing';
import setupProgress from './api/setup-progress';
import testSend from './api/test-send';
import sources from './api/sources';
import workspaceLifecycle from './api/workspace-lifecycle';
import workspace from './auth/workspace';
import { githubWebhook } from './connectors/sources/github/route';
import { genericWebhook } from './connectors/sources/generic/route';
import { providerWebhook } from './connectors/sources/provider-route';
import { PROVIDER_KINDS } from './connectors/sources/types';
import { rewrapStaleSourceKeys } from './connectors/sources/generic/secret';
import { keyringFromEnv } from './crypto/keyring-env';
import type { Bindings } from './env';
import { consumeDeliveries } from './pipeline/consumer';
import { DEAD_LETTER_QUEUE, consumeDeadLetters } from './pipeline/dead-letter';
import { credentialStatus, migrateLegacyCredentials, rewrapStaleKeys } from './pipeline/credentials';
import observability from './api/observability';
import { runCronJobs, writeHeartbeat } from './observability/cron';
import { detectStalls } from './observability/stall';
import { purgeEventDedup } from './delivery/dedup';
import { purgeExpiredRecords } from './pipeline/retention';
import { dispatchOutbox, purgeOutbox } from './pipeline/outbox';
import { purgeDueWorkspace } from './pipeline/purge';
import { pruneRateLimits, RATE_LIMIT_RETENTION_MS } from './security/rate-limit';
import { purgeExpiredAuthRecords } from './pipeline/expired-records';
import account from './api/account';
import { purgeRoutingDecisions } from './routing/provenance';
import { purgeNoiseRecords, releaseHeldEvents } from './pipeline/noise-release';
import { sweepStaleClaims } from './pipeline/sweep';
import { correlation } from './platform/correlation';
import { bootReport } from './platform/config';
import { log } from './platform/log';
import { requireSameOrigin } from './security/csrf';
import { securityHeaders } from './security/headers';
import { RETRY_AFTER_SECONDS, inMaintenance, maintenance } from './platform/maintenance';

export const app = new Hono<{ Bindings: Bindings }>();

app.use('*', correlation);
app.use('*', securityHeaders);
app.use('*', maintenance);
app.use('/api/*', requireSameOrigin);

const PROBE_PATHS: ReadonlySet<string> = new Set(['/health', '/health/ready']);
/**
 * The requests that SEAL or OPEN a credential, so they need a trustworthy key ring: create or update an
 * integration or source, rotate a source secret, send a test notification. Everything else under
 * `/api` (reads, delete, revoke, filters, the delivery log) never touches a key and stays up.
 */
const SEALING_METHODS: ReadonlySet<string> = new Set(['POST', 'PATCH', 'PUT']);
const SEALING_PATH = /^\/api\/(integrations|sources)(\/[^/]+(\/(test|rotate))?)?$/;
let configFailureLogged = false;

/**
 * Fail closed only where a fault makes the work unsafe or impossible (F04, F34; tiers in
 * src/platform/config.ts, ADR 0022):
 *  - no D1: nothing can be served, so everything except the probes is 503;
 *  - a bad key ring or a KEK that does not match this environment: requests that SEAL or OPEN a
 *    credential (see SEALING_PATH) are 503. Webhook ingress, sign-in and every read keep
 *    working: ingress never opens a credential to persist an event, and a webhook sender may not
 *    redeliver what we refuse (GitHub does not). A source whose secret cannot be opened answers 5xx
 *    from its own route, as before.
 * Names go to the log (once per isolate), never to the caller. Registered after the correlation id
 * and security headers, so the 503 carries both.
 */
app.use('*', async (c, next) => {
  if (PROBE_PATHS.has(c.req.path)) return next();
  const report = await bootReport(c.env);
  const blocked =
    report.storage.length > 0 ||
    (report.credentials.length > 0 && SEALING_METHODS.has(c.req.method) && SEALING_PATH.test(c.req.path));
  if (!blocked) return next();
  if (!configFailureLogged) {
    configFailureLogged = true;
    log('error', 'config_invalid', { misconfigured: report.names, code: report.code });
  }
  return c.json({ error: 'Service unavailable' }, 503, { 'retry-after': '30', 'cache-control': 'no-store' });
});

app.all('/api/auth/*', (c) => createAuth(c.env, c.executionCtx).handler(c.req.raw));
app.route('/api/workspace/me', account);
app.route('/api/workspace', workspace);
app.route('/api/workspace', workspaceLifecycle);
app.route('/api/integrations', integrations);
app.route('/api/sources', sources);
app.route('/api/deliveries', deliveries);
app.route('/api/observability', observability);
app.route('/api/audit', audit);
app.route('/api/integrations', routing);
app.route('/api/integrations', testSend);
app.route('/api/setup', setupProgress);
app.route('/api/github', githubApi);
app.route('/github', githubBrowser);

/**
 * Liveness plus configuration (F04, F10): cheap, public, and it touches no dependency, so it stays
 * 200 while D1 is down. Names the misconfigured bindings, never a value, a length or a prefix.
 * Optional-binding faults are `warnings` on a 200: they stop one job, not the Worker.
 */
app.get('/health', async (c) => {
  const report = await bootReport(c.env);
  return report.names.length > 0
    ? c.json(
        {
          ok: false,
          service: 'lumi-noti',
          code: report.code,
          misconfigured: report.names,
          ...(report.warnings.length > 0 ? { warnings: report.warnings } : {}),
        },
        503,
        { 'cache-control': 'no-store' },
      )
    : c.json(
        {
          ok: true,
          service: 'lumi-noti',
          ...(report.warnings.length > 0 ? { warnings: report.warnings } : {}),
        },
        200,
        { 'cache-control': 'no-store' },
      );
});

const READY_D1_TIMEOUT_MS = 3000;
const READY_CACHE_MS = 5000;
const readyCache = new WeakMap<object, { at: number; ok: boolean; checks: Record<string, boolean> }>();

async function d1Answers(db: D1Database): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const probe = db.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), READY_D1_TIMEOUT_MS);
    });
    return (await Promise.race([probe, timeout]))?.ok === 1;
  } catch {
    log('error', 'ready_d1_failed');
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Readiness (F10): is configuration valid, does D1 answer `SELECT 1`, is the queue binding present?
 * Booleans only, so it is safe to leave public; it sends no queue message and makes no outbound
 * call. 503 when any check fails. The answer is cached in the isolate for 5 seconds, so a public
 * caller cannot turn this into a D1 query per request.
 */
app.get('/health/ready', async (c) => {
  const cached = readyCache.get(c.env);
  const now = Date.now();
  if (cached && now - cached.at < READY_CACHE_MS)
    return c.json({ ok: cached.ok, checks: cached.checks }, cached.ok ? 200 : 503, {
      'cache-control': 'no-store',
    });
  const report = await bootReport(c.env);
  const d1 = await d1Answers(c.env.DB);
  const queue = typeof c.env.DELIVERY_QUEUE?.send === 'function';
  const checks = { config: report.names.length === 0, d1, queue };
  const ok = checks.config && checks.d1 && checks.queue;
  readyCache.set(c.env, { at: now, ok, checks });
  return c.json({ ok, checks }, ok ? 200 : 503, { 'cache-control': 'no-store' });
});

app.post('/webhooks/github', githubWebhook);
app.post('/webhooks/generic/:endpointId', genericWebhook);
// GitLab and Stripe (ADR 0015); the kind selects the connector, so there is no per-provider route code.
for (const kind of PROVIDER_KINDS) app.post(`/webhooks/${kind}/:endpointId`, providerWebhook(kind));

/**
 * Credential maintenance, bounded per tick: v0 → v1 migration, then KEK rewrap (F37).
 * Logs counts only — the runbook's zero-check reads `remaining`. An aborted batch throws,
 * so the cron invocation fails visibly instead of quarantining healthy rows.
 */
async function maintainCredentials(env: Bindings): Promise<void> {
  const keyring = keyringFromEnv(env);
  // A malformed optional legacy key stands down only this step (`/health` warns), never the Worker.
  const migrated =
    env.ENCRYPTION_KEY && /^[0-9a-f]{64}$/i.test(env.ENCRYPTION_KEY)
      ? await migrateLegacyCredentials(env.DB, keyring, env.ENCRYPTION_KEY, env.FINGERPRINT_KEY)
      : null;
  if (env.ENCRYPTION_KEY && migrated === null) log('warn', 'legacy_key_malformed_migration_skipped');
  const rewrapped = await rewrapStaleKeys(env.DB, keyring);
  const sourcesRewrapped = await rewrapStaleSourceKeys(env.DB, keyring);
  const remaining = await credentialStatus(env.DB, keyring.activeVersion);
  log('info', 'credential_maintenance', { migrated, rewrapped, sourcesRewrapped, remaining });
}

/** Backstop first, so a released claim is redispatched in the same tick (H1), then F174. */
async function reconcileOutbox(env: Bindings): Promise<void> {
  const releasedClaims = await sweepStaleClaims(env);
  const dispatch = await dispatchOutbox(env);
  const purged = await purgeOutbox(env);
  log('info', 'outbox_reconcile', { ...dispatch, released_claims: releasedClaims, purged });
}

/** Fixed-window counters older than an hour are dead weight; drain them in bounded rounds. */
async function pruneRateLimitWindows(env: Bindings): Promise<void> {
  for (let i = 0; i < 5; i++) {
    if ((await pruneRateLimits(env.DB, Date.now() - RATE_LIMIT_RETENTION_MS, 1000)) < 1000) break;
  }
}

async function purgeWorkspace(env: Bindings): Promise<void> {
  const purge = await purgeDueWorkspace(env.DB, Date.now());
  if (purge.organizationId) log('info', 'workspace_purge', { ...purge });
}

/** Routing provenance retention (ADR 0010): bounded rounds, isolated like every other job. */
async function purgeRouting(env: Bindings): Promise<void> {
  const deleted = await purgeRoutingDecisions(env.DB, Date.now());
  if (deleted > 0) log('info', 'routing_decisions_purged', { deleted });
}

/** Noise control (ADR 0016): release due held events through the outbox, bounded and leased. */
async function releaseNoise(env: Bindings): Promise<void> {
  const report = await releaseHeldEvents(env);
  if (report.events > 0 || report.reclaimed > 0) log('info', 'noise_release', { ...report });
}

async function purgeNoiseState(env: Bindings): Promise<void> {
  const purged = await purgeNoiseRecords(env);
  if (purged.held + purged.openFailures > 0) log('info', 'noise_purged', { ...purged });
}

/** Expired sessions, one-time tokens, install states and auth rate-limit rows (F237); hourly, bounded. */
async function purgeExpiredAuth(env: Bindings): Promise<void> {
  const purged = await purgeExpiredAuthRecords(env.DB, Date.now());
  const total = purged.sessions + purged.verifications + purged.authStates + purged.authRateLimits;
  if (total > 0) log('info', 'expired_auth_records_purged', { ...purged });
}

/** F171: expired dedup rows, bounded per tick and resumable (the next tick continues). */
async function purgeDedup(env: Bindings): Promise<void> {
  const report = await purgeEventDedup(env.DB, Date.now());
  if (report.purged > 0) log('info', 'dedup_purged', { ...report });
}

async function purgeRetention(env: Bindings): Promise<void> {
  const retention = await purgeExpiredRecords(env);
  if (retention.deliveries + retention.outbox + retention.audit > 0)
    log('info', 'retention_purge', { ...retention });
}

/**
 * A misconfigured Worker still records its heartbeat and runs stall detection (so the outage is
 * visible and the silence is measurable), then fails the invocation naming the bindings.
 */
async function assertBootable(env: Bindings): Promise<void> {
  const report = await bootReport(env);
  if (report.names.length === 0) return;
  log('error', 'config_invalid', { misconfigured: report.names, code: report.code });
  await runCronJobs([
    { name: 'heartbeat', run: () => writeHeartbeat(env.DB, Date.now()) },
    { name: 'stall_detection', run: () => detectStalls(env) },
  ]).catch(() => undefined);
  throw new Error(`config_invalid: ${report.names.join(',')}`);
}

/**
 * Per-message redelivery delay while the Worker is misconfigured: 5 minutes doubling per attempt, so the
 * five queue retries of `wrangler.jsonc` span about 2.6 hours (the Queues maximum delay is 12 hours).
 * A flat short delay would burn all retries in minutes and dead-letter in-flight deliveries.
 */
export function configRetryDelaySeconds(attempts: number): number {
  return Math.min(43_200, 300 * 2 ** Math.max(0, attempts - 1));
}

export default {
  fetch: app.fetch,

  // Awaited, not waitUntil: a failing job must fail the invocation visibly, not vanish. Each
  // job is isolated (src/observability/cron.ts) so one failure never skips the others; the
  // invocation still rejects at the end. Detection runs first so it survives any later failure.
  async scheduled(_event: ScheduledEvent, env: Bindings) {
    if (inMaintenance(env)) {
      log('warn', 'maintenance_mode_cron_skipped', {});
      return;
    }
    await assertBootable(env);
    await runCronJobs([
      { name: 'heartbeat', run: () => writeHeartbeat(env.DB, Date.now()) },
      { name: 'stall_detection', run: () => detectStalls(env) },
      { name: 'outbox_reconcile', run: () => reconcileOutbox(env) },
      // After the reconcile, with its own bounded budget (100 notifications per tick), so a large
      // backlog can never starve the reconcile or the jobs after it; what it releases is
      // dispatched by the next tick's reconcile.
      { name: 'noise_release', run: () => releaseNoise(env) },
      { name: 'credential_maintenance', run: () => maintainCredentials(env) },
      { name: 'rate_limit_prune', run: () => pruneRateLimitWindows(env) },
      { name: 'workspace_purge', run: () => purgeWorkspace(env) },
      { name: 'retention_purge', run: () => purgeRetention(env) },
      { name: 'routing_decisions_purge', run: () => purgeRouting(env) },
      { name: 'noise_purge', run: () => purgeNoiseState(env) },
      { name: 'expired_auth_purge', run: () => purgeExpiredAuth(env) },
      { name: 'dedup_purge', run: () => purgeDedup(env) },
    ]);
  },

  // One Worker consumes both queues. Wrapped so the runtime's third argument
  // (ExecutionContext) is never taken for test deps.
  // While the Worker cannot open credentials or reach D1, each delivery message is retried on its own
  // growing delay rather than consumed. This postpones, it does not make loss impossible: an outage
  // longer than the queue's retries (about 2.6 hours) moves messages to the dead-letter queue, whose
  // consumer marks the deliveries `dead_lettered` for replay (docs/RUNBOOK.md). The dead-letter consumer
  // only needs D1 and is never gated here.
  queue: async (batch: MessageBatch<unknown>, env: Bindings) => {
    if (inMaintenance(env)) {
      // The migration write freeze: nothing is read or written; the messages come back after the window.
      batch.retryAll({ delaySeconds: RETRY_AFTER_SECONDS });
      return;
    }
    if (batch.queue === DEAD_LETTER_QUEUE) return consumeDeadLetters(batch, env);
    const report = await bootReport(env);
    if (report.storage.length > 0 || report.credentials.length > 0) {
      log('error', 'config_invalid', { misconfigured: report.names, code: report.code });
      for (const message of batch.messages)
        message.retry({ delaySeconds: configRetryDelaySeconds(message.attempts) });
      return;
    }
    return consumeDeliveries(batch, env);
  },
};
