import type { MiddlewareHandler } from 'hono';
import type { Bindings } from '../env';

/** How long a caller (a provider's webhook retry, a browser) is told to wait. */
export const RETRY_AFTER_SECONDS = 300;

/** True only for the exact string "true": any other value, including a typo, leaves the Worker running. */
export function inMaintenance(env: Pick<Bindings, 'MAINTENANCE_MODE'>): boolean {
  return env.MAINTENANCE_MODE === 'true';
}

/**
 * The write freeze for a migration window (migration 0026). Every route answers 503 with
 * Retry-After except the probes (`/health`, `/health/ready`), so ingress providers retry instead of dropping an event, and no
 * handler touches D1. It runs before any route; cron and queue consumers check `inMaintenance`
 * themselves (src/index.ts).
 */
const PROBES: ReadonlySet<string> = new Set(['/health', '/health/ready']);

export const maintenance: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
  if (!inMaintenance(c.env) || PROBES.has(new URL(c.req.url).pathname)) return next();
  return c.json({ error: 'Under maintenance. Try again shortly.' }, 503, {
    'retry-after': String(RETRY_AFTER_SECONDS),
    'cache-control': 'no-store',
  });
};
