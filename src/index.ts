import { Hono } from 'hono';
import { createAuth } from './auth/better-auth';
import { api as githubApi, browser as githubBrowser } from './api/github';
import deliveries from './api/deliveries';
import integrations from './api/integrations';
import routing from './api/routing';
import workspaceLifecycle from './api/workspace-lifecycle';
import workspace from './auth/workspace';
import { githubWebhook } from './connectors/sources/github/route';
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
import { pruneRateLimits } from './security/rate-limit';
import { purgeRoutingDecisions } from './routing/provenance';
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
app.route('/api/workspace', workspace);
app.route('/api/workspace', workspaceLifecycle);
app.route('/api/integrations', integrations);
app.route('/api/deliveries', deliveries);
app.route('/api/observability', observability);
app.route('/api/integrations', routing);
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
  const remaining = await credentialStatus(env.DB, keyring.activeVersion);
  log('info', 'credential_maintenance', { migrated, rewrapped, remaining });
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
    if ((await pruneRateLimits(env.DB, Date.now() - 60 * 60 * 1000, 1000)) < 1000) break;
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
      { name: 'credential_maintenance', run: () => maintainCredentials(env) },
      { name: 'rate_limit_prune', run: () => pruneRateLimitWindows(env) },
      { name: 'workspace_purge', run: () => purgeWorkspace(env) },
      { name: 'retention_purge', run: () => purgeRetention(env) },
      { name: 'routing_decisions_purge', run: () => purgeRouting(env) },
    ]);
  },

  // One Worker consumes both queues. Wrapped so the runtime's third argument
  // (ExecutionContext) is never taken for test deps.
  queue: (batch: MessageBatch<unknown>, env: Bindings) =>
    batch.queue === DEAD_LETTER_QUEUE ? consumeDeadLetters(batch, env) : consumeDeliveries(batch, env),
};
