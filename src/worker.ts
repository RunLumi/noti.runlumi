/// <reference types="vite/client" />
/**
 * The deployed Worker's entry: one script, three surfaces (ADR 0017).
 *
 *  - `/api/*`, `/webhooks/*`, `/github/*`, `/health` go to the Hono app in `./index`, whose
 *    middleware (correlation id, security headers, same-origin check) is unchanged.
 *  - Every other request is the dashboard: TanStack Start's SPA shell, served by
 *    `./web/shell` with the SPA security headers.
 *  - `scheduled` and `queue` are `./index`'s handlers, untouched.
 *
 * TanStack Start's server handler is build tooling here: `vite dev` and the build's prerender of
 * the shell. In a deployment it is unreachable, so nothing renders React on the server and Start
 * server functions and server routes cannot run. They are not used either: state-changing work
 * goes through the Hono API so the CSRF middleware sees it.
 */
import app from './index';
import type { Bindings } from './env';
import { isBackendPath, serveDashboard } from './web/shell';
import { SECURITY_TXT_PATH, serveSecurityTxt } from './web/security-txt';

/**
 * Loaded on first use, so the React app inside Start's server bundle is never evaluated when
 * the Worker starts up to answer an API call, a webhook or a cron tick.
 */
async function renderWithStart(request: Request): Promise<Response> {
  const { default: start } = await import('@tanstack/react-start/server-entry');
  return start.fetch(request);
}

export default {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext): Response | Promise<Response> {
    const { pathname } = new URL(request.url);
    // Generated, never a static file: see src/web/security-txt.ts. Exact path only.
    if (pathname === SECURITY_TXT_PATH) return serveSecurityTxt(request, env.APP_ORIGIN);
    if (isBackendPath(pathname)) return app.fetch(request, env, ctx);
    // Start renders the document in two cases only, both build tooling: `vite dev`, and the
    // build's own prerender request while `/_shell.html` does not exist yet (see serveDashboard).
    // A deployed Worker always has the shell, so a request can never reach Start's handler,
    // whatever its path or headers.
    return serveDashboard(request, env, {
      devServer: import.meta.hot !== undefined,
      render: renderWithStart,
    });
  },
  scheduled: (event: ScheduledEvent, env: Bindings) => app.scheduled(event, env),
  queue: app.queue,
};
