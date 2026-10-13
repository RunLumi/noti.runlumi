import type { MiddlewareHandler } from 'hono';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Central CSRF defence for the dashboard API (F23). Every state-changing request under
 * `/api/` must carry an `Origin` equal to `APP_ORIGIN`; a cross-site page cannot forge one.
 * Better Auth owns `/api/auth/*` and applies its own origin policy. Individual routes
 * additionally require `application/json` where they read a body.
 *
 * Doing this once, in middleware, means a new route cannot forget it.
 */
export const requireSameOrigin: MiddlewareHandler<{ Bindings: { APP_ORIGIN: string } }> = async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (MUTATING.has(c.req.method) && path.startsWith('/api/') && !path.startsWith('/api/auth/')) {
    const origin = c.req.header('origin');
    if (!origin || origin !== new URL(c.env.APP_ORIGIN).origin) return c.json({ error: 'Forbidden' }, 403);
  }
  await next();
};
