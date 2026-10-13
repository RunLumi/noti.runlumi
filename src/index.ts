import { Hono } from 'hono';
import { createAuth } from './auth/better-auth';
import { api as githubApi, browser as githubBrowser } from './api/github';
import integrations from './api/integrations';
import workspace from './auth/workspace';
import { githubWebhook } from './connectors/sources/github/route';
import { keyringFromEnv, keyringProblem } from './crypto/keyring-env';
import type { Bindings } from './env';
import { consumeDeliveries } from './pipeline/consumer';
import { DEAD_LETTER_QUEUE, consumeDeadLetters } from './pipeline/dead-letter';
import { credentialStatus, migrateLegacyCredentials, rewrapStaleKeys } from './pipeline/credentials';
import { dispatchOutbox } from './pipeline/outbox';
import { log } from './platform/log';

const app = new Hono<{ Bindings: Bindings }>();

app.all('/api/auth/*', (c) => createAuth(c.env, c.executionCtx).handler(c.req.raw));
app.route('/api/workspace', workspace);
app.route('/api/integrations', integrations);
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

export default {
  fetch: app.fetch,

  // Awaited, not waitUntil: a failing job must fail the invocation visibly, not vanish.
  async scheduled(_event: ScheduledEvent, env: Bindings) {
    // F174 reconciler: due pending rows, expired leases, and scheduled retries.
    const dispatch = await dispatchOutbox(env);
    log('info', 'outbox_reconcile', { ...dispatch });
    await maintainCredentials(env);
  },

  // One Worker consumes both queues. Wrapped so the runtime's third argument
  // (ExecutionContext) is never taken for test deps.
  queue: (batch: MessageBatch<unknown>, env: Bindings) =>
    batch.queue === DEAD_LETTER_QUEUE ? consumeDeadLetters(batch, env) : consumeDeliveries(batch, env),
};
