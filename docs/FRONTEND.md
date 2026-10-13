# Lumi Noti frontend

## Stack
Vite + React 19 + TypeScript, Tailwind 4, shadcn-compatible component conventions, Base UI headless Dialog primitives, TanStack Router, TanStack Query and TanStack Table, Lucide icons.

## Run
1. `npm install`
2. `npm run dev` for the Hono Worker on localhost:8787 (requires local D1 and environment bindings).
3. `npm run dev:web` for the Vite UI on localhost:5173; /auth and /api proxy to the Worker.
4. `npm run typecheck:web` and `npm run build:web`.

## Pages
- /signup, /signin, /forgot-password, /verify?token=, /reset?token=
- / (overview), /integrations, /activity, /team, /settings

## Current truth
Signup, signin, verify, forgot/reset, signout and /me are wired to the prototype Hono auth API. The UI does not claim that email delivery or rate limits are configured. Workspace pages show explicit placeholders where authenticated integration CRUD, delivery history and team management APIs do not yet exist. Passkeys are not presented as functional. No fake analytics, live notifications or fictitious members.

## Deployment
The Vite frontend is currently a separate build artifact (`web/dist`). Deploy it to Cloudflare Pages/Workers static assets with SPA fallback, routing /auth and /api to the Hono API on the same origin. Set up custom domains, origin policy, secure cookies, D1, Queue and outbound transactional email before public use. Do not use the Vite dev proxy as a production gateway.

## Must finish before public launch
- Real production transactional email transport and verified sender
- Shared durable rate limiting, CSRF and abuse protections
- WebAuthn passkey registration and sign-in
- Admin/member invite, remove, leave and last-admin invariant
- Authorized integration CRUD and secret onboarding
- Live delivery log and retry endpoints
- Frontend integration/E2E tests and accessibility audit
- Build and deploy verification; no tests have been executed in this session
