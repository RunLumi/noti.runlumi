import { Hono } from 'hono';
import { authorize, currentSession, isFailure } from '../auth/workspace';
import type { Bindings } from '../env';
import { hit } from '../security/rate-limit';
import { log } from '../platform/log';
import { isPlatformOperator } from '../observability/operator';
import { readSinkHealth } from '../observability/alerts/sink-health';
import { computeSummary, parseWindow } from '../observability/slis';
import { bootReport } from '../platform/config';
import { d1Answers } from '../platform/readiness';
import { countAwaitingFingerprint } from '../pipeline/credential-destroy';

/**
 * Workspace delivery SLIs (docs/specs/13-observability.md F197, F198). Read-only, scoped to
 * the caller's workspace by `authorize`, and computed from the D1 ledger on request.
 *
 * `GET /api/observability/summary?window=24h` — `window` is `<n>h` or `<n>d`, between 1h
 * and 30d (default 24h); anything else is a 400, not a silent clamp.
 */
/** The summary scans a workspace's window; 30 a minute per user is far above what a page needs. */
export const SUMMARY_READS_PER_MINUTE = 30;
const WINDOW_MS = 60_000;

const observability = new Hono<{ Bindings: Bindings }>();

observability.get('/summary', async (c) => {
  const who = await authorize(c, 'delivery.read');
  if (isFailure(who)) return c.json({ error: who.error }, who.status);
  const limit = await hit(c.env.DB, `observability:read:${who.userId}`, SUMMARY_READS_PER_MINUTE, WINDOW_MS);
  if (limit.limited) {
    return c.json({ error: 'Too many requests; try again shortly' }, 429, {
      'retry-after': String(limit.retryAfterSeconds),
    });
  }
  const windowMs = parseWindow(c.req.query('window'));
  if (windowMs === null) return c.json({ error: 'window must be <n>h or <n>d, from 1h to 30d' }, 400);
  const summary = await computeSummary(c.env.DB, who.orgId, windowMs);
  c.header('Cache-Control', 'no-store');
  // Platform operations detail is for platform operators only (a workspace admin is any person who signed up):
  // everyone else gets a coarse verdict. Operators also get the alert webhook's health (times and a count;
  // never a URL).
  const { jobs, ...workspace } = summary;
  const jobsStatus = jobs === null ? 'unknown' : jobs.some((j) => j.stale) ? 'degraded' : 'ok';
  if (!isPlatformOperator(c.env, who.userId)) return c.json({ ...workspace, jobsStatus });
  const alerting = await readSinkHealth(c.env.DB).catch((error: unknown) => {
    log('warn', 'summary_sink_health_unreadable', { error });
    return null;
  });
  return c.json({
    ...workspace,
    jobsStatus,
    jobs,
    alerting: alerting && {
      webhookConfigured: Boolean(c.env.ALERT_WEBHOOK_URL?.trim()),
      ...alerting,
    },
  });
});

/**
 * Platform readiness for operators (ADR 0036, F10). The public `/health` and `/health/ready` say only
 * whether the Worker is configured; this says WHICH binding is wrong, per tier, plus the optional-binding
 * warnings and any unrecognised binding names. It is the one place those names are shown. Binding NAMES
 * only, never a value, a length or a prefix.
 *
 * Gate: a signed-in user who is on `PLATFORM_OPERATOR_USER_IDS`. Anyone else gets the same 404 as an
 * unknown path, so the route does not advertise itself, and an unset allow-list means nobody. It is not
 * tied to a workspace: it describes the platform, and a workspace admin is any person who signed up.
 */
observability.get('/readiness', async (c) => {
  const session = await currentSession(c);
  if (!session) return c.json({ error: 'Unauthorized' }, 401);
  if (!isPlatformOperator(c.env, session.user.id)) return c.json({ error: 'Not found' }, 404);
  const limit = await hit(
    c.env.DB,
    `observability:readiness:${session.user.id}`,
    SUMMARY_READS_PER_MINUTE,
    WINDOW_MS,
  );
  if (limit.limited)
    return c.json({ error: 'Too many requests; try again shortly' }, 429, {
      'retry-after': String(limit.retryAfterSeconds),
    });
  const report = await bootReport(c.env);
  const d1 = await d1Answers(c.env.DB);
  const queue = typeof c.env.DELIVERY_QUEUE?.send === 'function';
  const config = report.names.length === 0 && report.auth.length === 0;
  // Revoked secrets the sweep cannot wipe by itself: they need `scripts/force-destroy-revoked.mjs`.
  const awaitingFingerprint = d1 ? await countAwaitingFingerprint(c.env.DB).catch(() => 0) : 0;
  c.header('Cache-Control', 'no-store');
  return c.json({
    ok: config && d1 && queue,
    checks: { config, d1, queue },
    code: report.code,
    misconfigured: {
      storage: report.storage,
      credentials: report.credentials,
      queue: report.queue,
      auth: report.auth,
    },
    warnings: awaitingFingerprint > 0 ? [...report.warnings, 'revoked_secrets_not_wiped'] : report.warnings,
    revokedSecretsAwaitingFingerprint: awaitingFingerprint,
    unknownKeys: report.unknownKeys,
  });
});

export default observability;
