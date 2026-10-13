import { Hono } from 'hono';
import { createAuth } from './auth/better-auth';
import workspace from './auth/workspace';
import { githubWebhook } from './connectors/sources/github/route';
import { keyringFromEnv, keyringProblem } from './crypto/keyring-env';
import type { Bindings } from './env';
import { consumeDeliveries } from './pipeline/consumer';
import { migrateLegacyCredentials, rewrapStaleKeys } from './pipeline/credentials';
import { dispatchOutbox } from './pipeline/outbox';

const app = new Hono<{ Bindings: Bindings }>();

app.all('/api/auth/*', (c) => createAuth(c.env, c.executionCtx).handler(c.req.raw));
app.route('/api/workspace', workspace);

app.get('/health', (c) => {
  // Names the misconfigured binding, never its value (F04, F34).
  const problem = keyringProblem(c.env);
  return problem
    ? c.json({ ok: false, service: 'lumi-noti', misconfigured: problem }, 503)
    : c.json({ ok: true, service: 'lumi-noti' });
});

app.post('/webhooks/github', githubWebhook);

/** Credential maintenance, bounded per tick: v0 → v1 migration, then KEK rewrap (F37). */
async function maintainCredentials(env: Bindings): Promise<void> {
  const keyring = keyringFromEnv(env);
  await migrateLegacyCredentials(env.DB, keyring, env.ENCRYPTION_KEY);
  await rewrapStaleKeys(env.DB, keyring);
}

export default {
  fetch: app.fetch,

  // Awaited, not waitUntil: a failing job must fail the invocation visibly, not vanish.
  async scheduled(_event: ScheduledEvent, env: Bindings) {
    await dispatchOutbox(env);
    await maintainCredentials(env);
  },

  queue: consumeDeliveries,
};
