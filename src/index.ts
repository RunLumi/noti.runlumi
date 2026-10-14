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
import { keyringFromEnv, keyringProblem } from './crypto/keyring-env';
import type { Bindings } from './env';
import { consumeDeliveries } from './pipeline/consumer';
import { DEAD_LETTER_QUEUE, consumeDeadLetters } from './pipeline/dead-letter';
import { credentialStatus, migrateLegacyCredentials, rewrapStaleKeys } from './pipeline/credentials';
import observability from './api/observability';
import { runCronJobs, writeHeartbeat } from './observability/cron';
import { detectStalls } from './observability/stall';
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
import { log } from './platform/log';
import { requireSameOrigin } from './security/csrf';
import { securityHeaders } from './security/headers';

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', correlation);
app.use('*', securityHeaders);
app.use('/api/*', requireSameOrigin);

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

app.get('/health', (c) => {
  // Names the misconfigured binding, never its value (F04, F34).
  const problem = keyringProblem(c.env);
  return problem
    ? c.json({ ok: false, service: 'lumi-noti', misconfigured: problem }, 503)
    : c.json({ ok: true, service: 'lumi-noti' });
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
  const migrated = env.ENCRYPTION_KEY
    ? await migrateLegacyCredentials(env.DB, keyring, env.ENCRYPTION_KEY)
    : null;
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

async function purgeRetention(env: Bindings): Promise<void> {
  const retention = await purgeExpiredRecords(env);
  if (retention.deliveries + retention.outbox + retention.audit > 0)
    log('info', 'retention_purge', { ...retention });
}

export default {
  fetch: app.fetch,

  // Awaited, not waitUntil: a failing job must fail the invocation visibly, not vanish. Each
  // job is isolated (src/observability/cron.ts) so one failure never skips the others; the
  // invocation still rejects at the end. Detection runs first so it survives any later failure.
  async scheduled(_event: ScheduledEvent, env: Bindings) {
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
    ]);
  },

  // One Worker consumes both queues. Wrapped so the runtime's third argument
  // (ExecutionContext) is never taken for test deps.
  queue: (batch: MessageBatch<unknown>, env: Bindings) =>
    batch.queue === DEAD_LETTER_QUEUE ? consumeDeadLetters(batch, env) : consumeDeliveries(batch, env),
};
