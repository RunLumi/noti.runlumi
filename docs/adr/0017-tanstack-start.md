# ADR 0017: TanStack Start for the dashboard (SPA mode, one Worker)

Status: Accepted (draft PR) · Date: 2026-10-14 · Builds on [ADR 0002](0002-noti-design-system.md),
[ADR 0007](0007-integrations-ux.md) and [ADR 0013](0013-accessibility-localization.md).

## Context

The dashboard was a Vite SPA in `web/` (TanStack Router, hand-written route table in `main.tsx`),
deployed as a separate static site with `web/public/_headers`, and a Worker (`src/index.ts`) for the
API, webhooks, cron and queues. Development needed two processes and a Vite proxy. The request was
to apply TanStack Start. Start's value for this product is not server rendering (an authenticated
dashboard, no SEO need) but the file-route convention, one build pipeline and one origin.

## Sources read (2026-10-14)

- Overview, build from scratch, hosting, SPA mode, server entry point, server routes, server
  functions, middleware, static prerendering, environment variables:
  `https://tanstack.com/start/latest/docs/framework/react/` + `overview`,
  `build-from-scratch`, `guide/hosting`, `guide/spa-mode`, `guide/server-entry-point`,
  `guide/server-routes`, `guide/server-functions`, `guide/middleware`,
  `guide/static-prerendering`, `guide/environment-variables`.
- Cloudflare: `https://developers.cloudflare.com/workers/vite-plugin/` (overview),
  `.../vite-plugin/reference/api/`, `.../vite-plugin/reference/cloudflare-environments/`,
  `https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/` (bindings
  through `import { env } from 'cloudflare:workers'`; custom entry for queues and cron).
- Fetched pages were summarised by a tool, not read raw. Everything below that is behaviour rather
  than documentation was observed in this repository.

## Decision

1. **SPA mode, not SSR.** `tanstackStart({ spa: { enabled: true } })`. The build prerenders one
   shell document (`/_shell.html`); the browser renders every route. Reasons, with evidence:
   - The app is authenticated and every data call is a client `fetch` to the Hono API; there is no
     data a server render could include.
   - The locale is a browser decision (localStorage, then `navigator.languages`, ADR 0013). A
     server render is always English: a Vietnamese user would hydrate a mismatching tree. Observed:
     even the empty shell warns about `<html lang>` for a Vietnamese browser (fixed with
     `suppressHydrationWarning`); real page content would mismatch everywhere.
   - SSR would run every component's module in workerd, adding several hundred KiB gzip of React app to the
     Worker (see Findings), for no user-visible gain.
   - Public pages (sign-in, sign-up) are small forms; they gain nothing from SSR, and a cookie or
     locale read on the server is exactly where hydration mismatches come from.
   SSR for the public auth pages remains possible later (Start supports per-route `ssr`), but is not
   cheap or safe enough today to justify it.
2. **One Worker, one entry** (`src/worker.ts`): `/api/*`, `/webhooks/*`, `/github/*`, `/health`
   go to `app.fetch` from `src/index.ts` (middleware order and CSRF unchanged); every other
   `GET`/`HEAD` is answered with the prerendered shell by `src/web/shell.ts`; `scheduled` and
   `queue` are `src/index.ts`'s handlers. `src/index.ts` and its tests are untouched.
3. **Static assets** are served by the Workers assets layer (`assets` binding `ASSETS`,
   `html_handling: none`, `not_found_handling: none`). Fingerprinted `/assets/*` are served without
   invoking the Worker, with `web/public/_headers`. The Worker sends a path to the assets layer only
   when it ends in a known static extension (`js mjs css map svg png jpg jpeg gif webp avif ico
   woff woff2 ttf otf txt json xml webmanifest`); any other dotted last segment (`/invite/jo.smith`)
   is a client route and gets the shell. A missing static file is a 404 with
   `Cache-Control: no-store` and the SPA baseline headers (`_headers` does not apply to Worker
   responses).
4. **CSP stays strict.** Start's shell contains two inline bootstrap scripts, which the old policy
   (`script-src 'self'`) blocks. The Worker computes the SHA-256 of each inline script in the
   document it serves and adds those hashes to `script-src` for that response. The hash is of the
   text the HTML parser produces (Start writes a raw NUL into route ids; the parser turns it into
   U+FFFD, and a naive hash of the bytes silently failed in the browser). No `'unsafe-inline'`, no
   nonce. `renderHeadersFile()` now emits a `/_shell.html` rule instead of `/index.html`.
5. **Start's server features are unused, and in a deployment Start's handler is unreachable.**
   *Correction (security review of PR #41):* the first version let any request that carried an
   `X-TSS_SHELL` header reach Start, and the deployed bundle carries Start's server-function
   handler. That was reachable in production and is fixed. `src/web/shell.ts` now calls Start's
   renderer in exactly two situations, both build tooling: (a) `vite dev`, and (b) the build's
   own prerender request, which must carry the header `X-TSS_SHELL` with the value exactly `true`,
   be addressed to a loopback host (`localhost`, `127.0.0.1`, `[::1]`) **and** find no
   `/_shell.html` yet. A deployment always has the shell and a real hostname, so no path, header
   or method can reach Start there (`tests/web/worker.test.ts` imports `src/worker.ts` and tries
   `/_serverFn/x`, `/anything`, `//x`, encoded and dot-segment paths, with and without the header).
   The renderer is a dynamic import, so Start's server entry is not even evaluated otherwise.
   `process.env.TSS_PRERENDERING` is still defined in the SSR bundle (Start reads it to honour
   the header); I found no other way to set it inside workerd for the prerender. It is inert
   because the code path above is unreachable. Server functions, server routes and middleware are
   not used and would bypass `src/security/csrf.ts`. The rule: **state-changing work goes through
   the Hono API.** `tests/web/start-boundary.test.ts` enforces it across all of `web/src`,
   including the generated route tree (which may carry only Start's type registration).
   Start's own docs install a CSRF middleware for server functions only and say nothing about
   server routes; neither knows `APP_ORIGIN`.
   A related advisory: GHSA-qx66-fv34-fjm8 (critical, 2026-09-30, reflected XSS through Start's
   server-function responses) affects `@tanstack/react-start` < 1.168.60 and
   `@tanstack/start-server-core` < 1.169.39. This PR uses 1.168.60 / 1.169.39. Even unpatched, the
   path would not have been reachable once decision 5 holds; patching removes the dependence.
6. **Single origin in development.** `npm run dev` is `cd web && vite dev` on :5173 with the Worker
   in the same process (`@cloudflare/vite-plugin`, `viteEnvironment: { name: 'ssr' }`). The proxy
   and `dev:web` are removed; local D1 state is `.wrangler/state`, shared with
   `wrangler d1 migrations apply --local`.
7. **Deploy** is `npm run deploy` = `build:web` then
   `wrangler deploy --config web/dist/server/wrangler.json`. `wrangler.jsonc` `main` is now
   `src/worker.ts`, which only builds through Vite, so bare `wrangler dev`/`deploy` no longer work
   (documented in `wrangler.jsonc`, `docs/IMPLEMENTATION.md`, `docs/FRONTEND.md`).
8. **Route migration is mechanical.** Each `createRoute` became a file in `web/src/routes/`
   importing the same component; `validateSearch` for `/activity` and `/integrations/$id` moved
   verbatim. `main.tsx` and `index.html` are gone; the QueryClient and `LocaleProvider` moved to the
   router's `Wrap` (`router.tsx`); `routeTree.gen.ts` is generated and committed.
9. **Tests.** The route-coverage test reads `web/src/routes`; the font test reads `routes/__root.tsx`;
   `main.tsx` left the `useLocale` exemptions. New: `tests/web/shell.test.ts` (hashing, NUL/CRLF,
   headers, fallbacks, methods, asset misses) and `tests/web/start-boundary.test.ts`.
   `scripts/verify_worker_bundle.mjs` now scans `web/dist/server` (scrypt and `timingSafeEqual`
   checks kept) and also asserts the `ASSETS` binding, cron, queue consumers, exported
   `scheduled`/`queue` and the prerendered shell.

## Findings (all observed here, 2026-10-14)

| Question | Result |
| --- | --- |
| One Worker routes API to Hono and the rest to Start, with `scheduled` and `queue`? | Yes. Built with Vite 8.3.1; the bundle exports `queue` and `scheduled`; `/cdn-cgi/handler/scheduled` ran the cron jobs (heartbeat row written to D1) under both `vite dev` and `vite preview`. |
| D1 and Queue bindings reachable from both? | D1 yes (API sign-in and the cron). Queue producer/consumer config is carried into `web/dist/server/wrangler.json`; the consumer was **not** exercised with a live message. |
| Cookies and same-origin API calls | Yes: sign-in, workspace creation (POST through the CSRF check), reload of a deep link, all on one origin, no console errors. |
| Prerender through the Cloudflare plugin | Works, with two workarounds. (a) `process.env.TSS_PRERENDERING` is not visible inside workerd, so Start rendered the `/` page into the "shell"; defining it for the `ssr` environment fixes it. (b) The prerender request must reach Start, not the shell handler (it carries `X-TSS_SHELL`). |
| Output location | Start writes the shell relative to the **working directory**, not the Vite root: `vite build --config web/vite.config.ts` from the repo root put `_shell.html` in `./dist/client/`. Scripts `cd web` first. |
| `router.isShell()` | Only set on the server in 1.168; the client's first render sees `false`, so using it caused React error 418. The root component uses `useHydrated()` instead (an empty screen until hydrated). |
| CSP | Inline bootstrap scripts blocked until hashed; see decision 4. |
| `.dev.vars` | The plugin copies it into `web/dist/server/` (gitignored `dist/`). `wrangler deploy` does not upload it; do not publish `web/dist/server` as a folder. |
| Bundle, client | JS 269 KiB gzip, CSS 13 KiB gzip (before: 247 / 12 on the same Vite 8). Within the app budget (<300 KiB JS, <50 KiB CSS). The router and Start client add about 22 KiB. |
| Bundle, Worker | 1159 KiB gzip / 5361 KiB raw, including Start's server bundle (the whole React app). It was about 711 KiB gzip before the dashboard moved in (measured on the previous commit). Limit: 3 MiB gzip on the free plan, 10 MiB on paid. Start's handler is imported lazily so it is not evaluated on API, webhook or cron invocations. |
| Versions that work together | `vite` 8.3.1, `@vitejs/plugin-react` 6.1.1, `@cloudflare/vite-plugin` 1.62.1 (2026-09-29), `@tanstack/react-start` **1.168.60** (2026-09-30), `@tanstack/start-server-core` 1.169.39, `@tanstack/react-router` **1.170.41** (pinned exactly by Start; a second copy otherwise), `wrangler` ^4.149.0 (plugin peer `^4.143.1`). Start 1.168.x peers `vite >=7`; 1.169.x needs `vite >=8`. No conflict with the toolchain upgrade (#36). |

## Dependency age (policy: at least two weeks old) and exceptions

Checked against the lockfile diff versus `origin/main` (141 changed packages, publish times from
`npm view <pkg> time`, cutoff 2026-09-30), and `npm run audit:gate` passes.

- **Exception (security fix): `@tanstack/react-start` 1.168.60 and the packages it pins
  (`start-server-core` 1.169.39, `start-client-core` 1.170.34, `start-plugin-core` 1.171.49,
  `router-plugin` 1.168.42, `router-generator` 1.167.40, `start-storage-context` 1.167.36),
  all published 2026-09-30 about 17:48 UTC, roughly 13 days before this PR.** 1.168.59 (the
  older version I first used) is vulnerable to GHSA-qx66-fv34-fjm8 (critical); 1.168.60 is the
  first patched release. The critical advisory outweighs the age rule. Production tree: these
  are bundled into the Worker, but unreachable at runtime (decision 5).
- **Exception (pre-release, production tree): `h3-v2` is `npm:h3@2.0.1-rc.20`**, pinned exactly
  by `@tanstack/start-server-core` (`npm ls h3-v2`: `react-start > start-server-core > h3-v2`),
  published 2026-03-27 (old enough, but a release candidate). h3 2.0.1 stable was published
  2026-10-03 (under two weeks). I did not override a package Start pins exactly to a version it
  was not tested with. It is bundled into the Worker and unreachable at runtime (decision 5).
  Revisit when Start bumps it.
- **Fixed with `overrides` in `package.json`** (all build-time only: `browserslist` under
  `@babel/core` and `exsolve`, both under `start-plugin-core`; none enters the Worker bundle):
  `baseline-browser-mapping` 2.11.26 (2026-09-24, was 2.11.27 of 2026-10-01),
  `caniuse-lite` 1.0.30001813 (2026-09-28, was ...814 of 2026-09-30),
  `electron-to-chromium` 1.5.441 (2026-09-29, was 1.5.445 of 2026-10-06), `exsolve` 1.1.1
  (2026-07-27, was 1.1.3 of 2026-10-03). Each satisfies its parent's range
  (`browserslist` ^2.11.26 / ^1.0.30001813 / ^1.5.439, `start-plugin-core` ^1.1.1). Remove the
  overrides once the versions age in.
- **`@tanstack/react-router` 1.170.42 (main) versus 1.170.41 (here), and `router-core` 1.171.35
  versus 1.171.34**: `@tanstack/react-start` pins the router exactly, so staying on main's
  version would install a second copy. I read the commits between `router-core` 1.171.34 and
  1.171.35 (`gh api repos/TanStack/router/compare`): link-preload cancellation, render and
  parsing performance, test and CI work, and "avoid null bytes in dehydrated SSR match ids"
  (#7654). No security fix. The repository's published advisories (`gh api
  repos/TanStack/router/security-advisories`) list nothing for `react-router`/`router-core` in
  this range; the only 2026-09/10 advisory is GHSA-qx66 above.
  (The NUL change is why the shell hash code keeps hashing what the parser produces: it is correct
  for either version.)

## Consequences

- One origin, one process in development; no proxy to misconfigure, and the CSRF check sees the
  same `Origin` in development as in production.
- The Worker is larger (about +450 KiB gzip) and the build is slower: it starts workerd to
  prerender the shell. Cold start is unaffected for API traffic because Start loads lazily.
- A new dependency set (`@tanstack/react-start`, `@cloudflare/vite-plugin`) with a fast-moving
  release cadence; the router is pinned to Start's exact version.
- Navigation requests now invoke the Worker (assets are served without it). Billing and the CPU
  budget for those are a few string operations and one asset read.
- A change to Start's bootstrap script needs no code change (hashes are computed at serve time).

## Rollback

Revert this PR. The previous layout (`web/index.html`, `main.tsx`, Vite proxy, `src/index.ts` as
the Worker `main`, static host with `web/public/_headers`) is restored by the revert alone; no data
or migration is involved. After a deploy, roll back with `wrangler rollback`; the API behaviour is
byte-identical because `src/index.ts` is unchanged.

## Not verified (UNVERIFIED)

- A real Cloudflare deployment (assets layer behaviour for `html_handling: none`, the `ASSETS`
  binding, and `_headers` on assets were exercised only in the local workerd).
- The queue consumer receiving a live message through the new entry; the DLQ path.
- The Vite build in GitHub Actions (it needs workerd to start there).
- `vite dev` HMR for the Worker side (API code edits) beyond the first load.
- Per-route `ssr` for public pages, and Rsbuild (not supported by the Cloudflare plugin).
- Keyboard, 320 px and axe-in-browser passes on the routed shell; only the Node/jsdom axe suite
  ran. Screens other than sign-in, onboarding, overview and integrations were not opened in a
  browser under the CSP.
- That the Start documentation's SPA-mode statement "default rewrites send 404s to the shell"
  has no Cloudflare equivalent: the Worker does this itself.
