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
import {
  destroyRevokedCredentials,
  destroySettings,
  type DestroySweepReport,
} from './pipeline/credential-destroy';
import { backfillRevokedFingerprints } from './pipeline/fingerprint-backfill';
import { keyringFromEnv } from './crypto/keyring-env';
import type { Bindings } from './env';
import { consumeDeliveries } from './pipeline/consumer';
import { DEAD_LETTER_QUEUE, consumeDeadLetters } from './pipeline/dead-letter';
import { credentialStatus, migrateLegacyCredentials, rewrapStaleKeys } from './pipeline/credentials';
import observability from './api/observability';
import { evaluateAlerts } from './observability/alerts/engine';
import type { JobName } from './observability/cadence';
import { markMaintenanceSkip, runCronJobs, writeHeartbeat, type CronJob } from './observability/cron';
import { createJobRecorder, type JobReport } from './observability/job-runs';
import type { StallCounts } from './observability/stall';
import { countStalls, detectStalls } from './observability/stall';
import { purgeEventDedup } from './delivery/dedup';
import { purgeEgressBuckets } from './delivery/egress-guard';
import { genericWebhookEnabled } from './connectors/destinations/features';
import { ownHostsOf } from './connectors/destinations/url-policy';
import {
  purgeStaleResolutions,
  reresolveDueHosts,
} from './connectors/destinations/generic-webhook/host-control';
import { purgeExpiredRecords } from './pipeline/retention';
import { dispatchOutbox, purgeOutbox } from './pipeline/outbox';
import { existingLegacyTables, purgeDueWorkspace } from './pipeline/purge';
import { recentAuditFailures } from './audit/audit';
import { pruneRateLimits, RATE_LIMIT_RETENTION_MS } from './security/rate-limit';
import { purgeExpiredAuthRecords } from './pipeline/expired-records';
import account from './api/account';
import sessions from './api/sessions';
import { purgeRoutingDecisions } from './routing/provenance';
import { purgeNoiseRecords, releaseHeldEvents } from './pipeline/noise-release';
import { sweepStaleClaims } from './pipeline/sweep';
import { correlation } from './platform/correlation';
import { ingressErrorBodies } from './platform/ingress-errors';
import { bootReport } from './platform/config';
import { d1Answers } from './platform/readiness';
import { log } from './platform/log';
import { requireSameOrigin } from './security/csrf';
import { securityHeaders } from './security/headers';
import { RETRY_AFTER_SECONDS, inMaintenance, maintenance } from './platform/maintenance';

export const app = new Hono<{ Bindings: Bindings }>();

app.use('*', correlation);
app.use('/webhooks/*', ingressErrorBodies);
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
/** Routes that need a working session (`createAuth`): the dashboard API and the GitHub browser flow. */
const SESSION_PATH = /^\/(api|github)(\/|$)/;
let configFailureLogged = false;

/**
 * Fail closed only where a fault makes the work unsafe or impossible (F04, F34; tiers in
 * src/platform/config.ts, ADR 0022):
 *  - no D1: nothing can be served, so everything except the probes is 503;
 *  - an unusable `APP_ORIGIN` or `BETTER_AUTH_SECRET`: every `/api` and `/github` request (no session can be
 *    verified), but not webhook ingress;
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
    (report.auth.length > 0 && SESSION_PATH.test(c.req.path)) ||
    (report.credentials.length > 0 && SEALING_METHODS.has(c.req.method) && SEALING_PATH.test(c.req.path));
  if (!blocked) return next();
  if (!configFailureLogged) {
    configFailureLogged = true;
    log('error', 'config_invalid', { misconfigured: [...report.names, ...report.auth], code: report.code });
  }
  return c.json({ error: 'Service unavailable' }, 503, { 'retry-after': '30', 'cache-control': 'no-store' });
});

/**
 * Better Auth's own session-management routes return each session's token and act on a token the caller
 * supplies, so they cannot be audited as one change. Session management is `src/api/sessions.ts` (ADR 0030);
 * these four are closed so there is a single audited path.
 */
const CLOSED_AUTH_ROUTES: ReadonlySet<string> = new Set([
  '/api/auth/list-sessions',
  '/api/auth/revoke-session',
  '/api/auth/revoke-sessions',
  '/api/auth/revoke-other-sessions',
]);
app.all('/api/auth/*', (c) => {
  if (CLOSED_AUTH_ROUTES.has(c.req.path.replace(/\/+$/, ''))) return c.json({ error: 'Not found' }, 404);
  return createAuth(c.env, c.executionCtx).handler(c.req.raw);
});
app.route('/api/workspace/me/sessions', sessions);
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
 * 200 while D1 is down. An anonymous caller learns only WHETHER the Worker is configured and a coarse
 * `code`, never which binding is wrong (ADR 0036): the names go to the log and to the platform operator's
 * `GET /api/observability/readiness`. Optional-binding faults do not change the answer.
 */
app.get('/health', async (c) => {
  const report = await bootReport(c.env);
  const healthy = report.names.length === 0 && report.auth.length === 0;
  return healthy
    ? c.json({ ok: true, service: 'lumi-noti' }, 200, { 'cache-control': 'no-store' })
    : c.json({ ok: false, service: 'lumi-noti', code: report.code }, 503, { 'cache-control': 'no-store' });
});

const READY_CACHE_MS = 5000;
const readyCache = new WeakMap<
  object,
  { at: number; ok: boolean; checks: Record<string, boolean>; warnings: string[] }
>();

/**
 * Warning only, never a failure: migration 0026 keeps its originals as `<table>_old` until an operator
 * finalizes (docs/RUNBOOK.md). They hold orphan rows with credentials, so a lingering one must be visible.
 */
async function readyWarnings(db: D1Database): Promise<string[]> {
  try {
    const warnings: string[] = [];
    if ((await existingLegacyTables(db)).length > 0) warnings.push('migration_0026_old_tables_present');
    // A failed 0026 run can leave this view behind, and while it exists EVERY `ALTER TABLE ... RENAME` fails.
    const gate = await db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='view' AND name='_gate_0026_poison'")
      .first<{ present: number }>();
    if (gate) warnings.push('migration_0026_gate_view_present');
    // An audit row that could not be written in the last hour (the Better Auth rows are not atomic with their change).
    if ((await recentAuditFailures(db)) > 0) warnings.push('audit_write_failed_recently');
    return warnings;
  } catch {
    return [];
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
    return c.json(
      {
        ok: cached.ok,
        checks: cached.checks,
        ...(cached.warnings.length > 0 ? { warnings: cached.warnings } : {}),
      },
      cached.ok ? 200 : 503,
      { 'cache-control': 'no-store' },
    );
  const report = await bootReport(c.env);
  const d1 = await d1Answers(c.env.DB);
  const queue = typeof c.env.DELIVERY_QUEUE?.send === 'function';
  const checks = { config: report.names.length === 0 && report.auth.length === 0, d1, queue };
  const ok = checks.config && checks.d1 && checks.queue;
  const warnings = d1 ? await readyWarnings(c.env.DB) : [];
  readyCache.set(c.env, { at: now, ok, checks, warnings });
  return c.json({ ok, checks, ...(warnings.length > 0 ? { warnings } : {}) }, ok ? 200 : 503, {
    'cache-control': 'no-store',
  });
});

app.post('/webhooks/github', githubWebhook);
app.post('/webhooks/generic/:endpointId', genericWebhook);
// GitLab and Stripe (ADR 0015); the kind selects the connector, so there is no per-provider route code.
for (const kind of PROVIDER_KINDS) app.post(`/webhooks/${kind}/:endpointId`, providerWebhook(kind));

const NO_DESTROY: DestroySweepReport = {
  integrations: 0,
  sources: 0,
  deferred: 0,
  failed: 0,
  awaitingFingerprint: 0,
};

/**
 * The destroy half of credential maintenance. It needs no key, so it runs FIRST and on its own: a bad KEK, a
 * failing migration batch or a rewrap abort must never leave a revoked secret in place (F40, ADR 0036).
 */
async function sweepDestroy(env: Bindings): Promise<DestroySweepReport> {
  try {
    return await destroyRevokedCredentials(env.DB, Date.now(), await destroySettings(env));
  } catch (error) {
    log('error', 'credential_destroy_sweep_failed', { error });
    return NO_DESTROY;
  }
}

/**
 * Credential maintenance, bounded per tick: first finish revokes (wipe and audit; no key needed, isolated),
 * then fingerprint backfill for revoked rows that lack one (so their destroy can proceed), then the v0 -> v1
 * migration and the KEK rewrap (F37). Logs counts only; the runbook's zero-check reads `remaining`. A
 * migration or rewrap abort still throws AFTER the destroy ran, so the cron invocation fails visibly.
 */
async function maintainCredentials(env: Bindings): Promise<JobReport> {
  let destroyed = await sweepDestroy(env);
  const backfilled = await backfillRevokedFingerprints(env).catch((error: unknown) => {
    log('warn', 'fingerprint_backfill_sweep_failed', { error });
    return 0;
  });
  if (backfilled > 0) {
    const again = await sweepDestroy(env);
    destroyed = {
      integrations: destroyed.integrations + again.integrations,
      sources: destroyed.sources + again.sources,
      deferred: again.deferred,
      failed: destroyed.failed + again.failed,
      awaitingFingerprint: again.awaitingFingerprint,
    };
  }
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
  log('info', 'credential_maintenance', {
    migrated,
    rewrapped,
    sourcesRewrapped,
    destroyed,
    backfilled,
    remaining,
  });
  return {
    counters: {
      migrated: migrated?.processed ?? 0,
      rewrapped: rewrapped.processed,
      quarantined: (migrated?.quarantined ?? 0) + rewrapped.quarantined,
      sources_rewrapped: sourcesRewrapped,
      keys_destroyed: destroyed.integrations + destroyed.sources,
      keys_destroy_deferred: destroyed.deferred,
      keys_destroy_failed: destroyed.failed,
      keys_awaiting_fingerprint: destroyed.awaitingFingerprint,
    },
  };
}

/** Backstop first, so a released claim is redispatched in the same tick (H1), then F174. */
async function reconcileOutbox(env: Bindings): Promise<JobReport> {
  const releasedClaims = await sweepStaleClaims(env);
  const dispatch = await dispatchOutbox(env);
  const purged = await purgeOutbox(env);
  log('info', 'outbox_reconcile', { ...dispatch, released_claims: releasedClaims, purged });
  return {
    counters: {
      dispatched: dispatch.dispatched,
      reclaimed: dispatch.reclaimed,
      released_claims: releasedClaims,
      purged,
    },
  };
}

/** Fixed-window counters older than an hour are dead weight; drain them in bounded rounds. */
async function pruneRateLimitWindows(env: Bindings): Promise<JobReport> {
  let pruned = 0;
  for (let i = 0; i < 5; i++) {
    const n = await pruneRateLimits(env.DB, Date.now() - RATE_LIMIT_RETENTION_MS, 1000);
    pruned += n;
    if (n < 1000) break;
  }
  return { counters: { pruned } };
}

async function purgeWorkspace(env: Bindings): Promise<JobReport> {
  const purge = await purgeDueWorkspace(env.DB, Date.now());
  if (purge.organizationId) log('info', 'workspace_purge', { ...purge });
  return { counters: { deleted: purge.deleted } };
}

/** Routing provenance retention (ADR 0010): bounded rounds, isolated like every other job. */
async function purgeRouting(env: Bindings): Promise<JobReport> {
  const deleted = await purgeRoutingDecisions(env.DB, Date.now());
  if (deleted > 0) log('info', 'routing_decisions_purged', { deleted });
  return { counters: { deleted } };
}

/** Noise control (ADR 0016): release due held events through the outbox, bounded and leased. */
async function releaseNoise(env: Bindings): Promise<JobReport> {
  const report = await releaseHeldEvents(env);
  if (report.events > 0 || report.reclaimed > 0) log('info', 'noise_release', { ...report });
  return { counters: { events: report.events, reclaimed: report.reclaimed } };
}

async function purgeNoiseState(env: Bindings): Promise<JobReport> {
  const purged = await purgeNoiseRecords(env);
  if (purged.held + purged.openFailures > 0) log('info', 'noise_purged', { ...purged });
  return { counters: { held: purged.held, open_failures: purged.openFailures } };
}

/** Expired sessions, one-time tokens, install states and auth rate-limit rows (F237); hourly, bounded. */
async function purgeExpiredAuth(env: Bindings): Promise<JobReport> {
  const purged = await purgeExpiredAuthRecords(env.DB, Date.now());
  const total =
    purged.sessions +
    purged.overAgeSessions +
    purged.verifications +
    purged.authStates +
    purged.authRateLimits;
  if (total > 0) log('info', 'expired_auth_records_purged', { ...purged });
  return { counters: { purged: total } };
}

/** F171: expired dedup rows, bounded per tick and resumable (the next tick continues). */
async function purgeDedup(env: Bindings): Promise<JobReport> {
  const report = await purgeEventDedup(env.DB, Date.now());
  if (report.purged > 0) log('info', 'dedup_purged', { ...report });
  return { counters: { purged: report.purged } };
}

/** Egress guard buckets, and re-resolution of custom-webhook hosts (ADR 0029). Counts only in the report. */
async function maintainEgress(env: Bindings): Promise<JobReport> {
  const now = Date.now();
  const buckets = await purgeEgressBuckets(env.DB, now);
  // Always: records of deleted or disabled integrations go whatever the flag says.
  const stale = await purgeStaleResolutions(env.DB, now);
  if (!genericWebhookEnabled(env))
    return { counters: { buckets_purged: buckets, resolutions_purged: stale } };
  const report = await reresolveDueHosts(
    { db: env.DB, urlPolicy: { ownHosts: ownHostsOf(env.APP_ORIGIN) } },
    now,
  );
  return {
    counters: {
      buckets_purged: buckets,
      hosts_checked: report.checked,
      hosts_refused: report.refused,
      resolutions_purged: stale,
    },
  };
}

/** The hourly throttle makes most ticks a no-op: those record `skipped`, so "ran" and "worked" differ. */
async function purgeRetention(env: Bindings): Promise<JobReport> {
  const retention = await purgeExpiredRecords(env);
  if (retention.deliveries + retention.outbox + retention.audit + retention.jobRuns > 0)
    log('info', 'retention_purge', { ...retention });
  return {
    skipped: retention.skipped,
    counters: {
      deliveries: retention.deliveries,
      attempts: retention.attempts,
      outbox: retention.outbox,
      audit: retention.audit,
      job_runs: retention.jobRuns,
      ingress_usage: retention.ingressUsage,
    },
  };
}

/** Evaluate the alert registry and notify the sinks (docs/specs/13-observability.md F200). */
async function evaluateAlertRegistry(env: Bindings, stalls: Promise<StallCounts>): Promise<JobReport> {
  const report = await evaluateAlerts(env, Date.now(), { stallCounts: await stalls });
  return {
    counters: {
      fired: report.fired,
      renotified: report.renotified,
      resolved: report.resolved,
      firing: report.firing,
      unknown: report.unknown,
      notify_failures: report.notifyFailures,
      resent: report.resent,
    },
  };
}

/**
 * A misconfigured Worker still records its heartbeat and runs stall detection (so the outage is
 * visible and the silence is measurable), then fails the invocation naming the bindings.
 */
/**
 * Detection first. The stall counts are read ONCE per tick and shared by the stall detector and the alert
 * engine (`outbox_stall`), so an outage does not double the query load.
 */
function detectionJobs(env: Bindings): CronJob<JobName>[] {
  let stalls: Promise<StallCounts> | undefined;
  const shared = (): Promise<StallCounts> => (stalls ??= countStalls(env.DB, Date.now()));
  return [
    { name: 'heartbeat', run: () => writeHeartbeat(env.DB, Date.now()) },
    { name: 'stall_detection', run: () => detectStalls(env, Date.now(), shared()) },
    { name: 'alerts', flushBefore: true, run: () => evaluateAlertRegistry(env, shared()) },
  ];
}

async function assertBootable(env: Bindings): Promise<void> {
  const report = await bootReport(env);
  if (report.names.length === 0) return;
  log('error', 'config_invalid', { misconfigured: report.names, code: report.code });
  // `alerts` is the one that matters here: `key_config_fault` fires from this very state.
  await runCronJobs(detectionJobs(env), { recorder: createJobRecorder(env.DB) }).catch(() => undefined);
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
      // The one write the freeze allows: "silence here is on purpose" (see markMaintenanceSkip).
      await markMaintenanceSkip(env.DB, Date.now());
      return;
    }
    await assertBootable(env);
    // Every execution is recorded in `job_runs` (F192); the alert job runs second so detection survives
    // a later job's failure, and flushes first so it sees this tick's heartbeat.
    const jobs: CronJob<JobName>[] = [
      ...detectionJobs(env),
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
      { name: 'egress_maintenance', run: () => maintainEgress(env) },
    ];
    await runCronJobs(jobs, { recorder: createJobRecorder(env.DB) });
  },

  // One Worker consumes both queues. Wrapped so the runtime's third argument
  // (ExecutionContext) is never taken for test deps.
  // While the Worker cannot open credentials or reach D1, each delivery message is retried on its own
  // growing delay rather than consumed. This postpones, it does not make loss impossible: an outage
  // longer than the queue's retries (about 2.6 hours) moves messages to the dead-letter queue, whose
  // consumer marks the deliveries `dead_lettered` for replay (docs/RUNBOOK.md). The dead-letter consumer
  // only needs D1 and is never gated here.
  queue: async (batch: MessageBatch<unknown>, env: Bindings) => {
    // The dead-letter consumer is never gated, in maintenance or out of it: its queue has max_retries 1, so
    // handing its message back (retryAll consumes an attempt) would drop the message before the ledger row
    // is marked `dead_lettered`. Pausing queue delivery is the freeze for it (docs/RUNBOOK.md).
    if (batch.queue === DEAD_LETTER_QUEUE) return consumeDeadLetters(batch, env);
    if (inMaintenance(env)) {
      // The migration write freeze: nothing is read or written; the messages come back after the window.
      // retryAll counts as an attempt (max_retries 5 at 300 s: a message dead-letters after about 25 minutes of
      // this), so pause queue delivery first; this is the backstop for a message already in flight.
      batch.retryAll({ delaySeconds: RETRY_AFTER_SECONDS });
      return;
    }
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
