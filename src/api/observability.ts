import { Hono } from 'hono';
import { authorize, isFailure } from '../auth/workspace';
import type { Bindings } from '../env';
import { hit } from '../security/rate-limit';
import { can } from '../auth/permissions';
import { log } from '../platform/log';
import { readSinkHealth } from '../observability/alerts/sink-health';
import { computeSummary, parseWindow } from '../observability/slis';

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
  // Platform operations detail is for admins: a member gets a coarse verdict, an admin the job list and
  // the health of the alert webhook (times and a count; never a URL).
  const { jobs, ...workspace } = summary;
  const jobsStatus = jobs === null ? 'unknown' : jobs.some((j) => j.stale) ? 'degraded' : 'ok';
  if (!can(who.role, 'delivery.replay')) return c.json({ ...workspace, jobsStatus });
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

export default observability;
