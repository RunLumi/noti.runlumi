# Lumi Noti identity: Better Auth / Hono / Drizzle / Cloudflare D1

This replaces the custom authentication prototype on PR #1. The previous `auth_*` tables in migration 0004 remain untouched for rollback; new registrations write only Better Auth tables introduced by `0005_better_auth.sql`. **No migration of real user credentials is implemented**. Do not deploy over an existing customer auth database without a migration plan.

## Design decisions

- Better Auth 1.6.x matched packages (`better-auth`, `@better-auth/passkey`, `@better-auth/drizzle-adapter`), Hono and Drizzle's D1 driver.
- Same-origin API: `/api/auth/*` (Better Auth), `/api/workspace/me`, `/api/workspace/team` (verified session required).
- Two roles only: admin and member. Creator = admin; delete organization disabled.
- At most one organization per user, **database unique index** on `member.user_id` plus plugin hooks rejecting membership overlaps.
- Always at least one admin for a populated org: **D1 triggers** reject deletion or demotion of the final admin, including simultaneous requests. Before hooks are not enough to guarantee this.
- Verified email required before password login; signup does not auto-issue a session. Passkeys are enrolled after verified sign-in, so passkeys cannot be used to bypass initial email verification. Verified authenticated users can open workspace setup or accept invitations.
- Rate limits use Better Auth's database storage (shared D1, not per-isolate memory), custom sign-up/sign-in/reset/invitation limits, and Cloudflare connecting IP.
- No hand-written password hashes or session tokens remain in application routes.

## Cloudflare Email Sending

Cloudflare now offers **Email Sending Beta** for transactional emails separately from inbound Email Routing: https://developers.cloudflare.com/email-service/ (Workers Paid and domain onboarding required for unrestricted customer email).
Configure:
1. Cloudflare dashboard > Compute > Email Service > Email Sending. Onboard `runlumi.app` (DNS/SPF/DKIM/DMARC), verify eligibility and sender.
2. `send_email: [{ name: 'AUTH_EMAIL' }]` already set in `wrangler.jsonc`.
3. Set `AUTH_FROM_EMAIL` to an authorized address in your domain, e.g. `noreply@runlumi.app`.
4. Email links use `APP_ORIGIN`, which must match your deployed HTTPS frontend origin.
5. Run a real signup, verify, password-reset and invitation delivery test. Free Email Routing's verified-destination limit is **not** a replacement for Email Sending enrollment.

If Email Sending is unavailable on the account, do not enable public signup: replace `sendAuthEmail()` with an approved transactional email provider.

## Install and run

```sh
npm install
npx wrangler d1 create lumi-noti
npx wrangler d1 migrations apply lumi-noti --local
npx wrangler d1 migrations apply lumi-noti --remote
npx wrangler secret put BETTER_AUTH_SECRET
npm run dev
npm run dev:web
npm run verify
python3 scripts/test_auth_schema.py
```

- Set the real D1 database UUID in `wrangler.jsonc`. Create existing Queues as described in `docs/IMPLEMENTATION.md`.
- Generate `BETTER_AUTH_SECRET` as at least 32 random characters (not a guessable phrase).
- For local Vite + Wrangler, override `APP_ORIGIN` to `http://localhost:5173` in `.dev.vars` and make Email Sending binding available using Wrangler's remote email binding support, or use a dedicated test email implementation in a non-production environment.
- Do not put secrets in Git or frontend `VITE_*` env vars.
- The Vite frontend and Hono API must be served at the **same origin** in production for default cookie and passkey configuration. Avoid cross-site cookie workarounds.
- The manual Drizzle schema mirrors Better Auth's core, organization, passkey and rate-limit models. When upgrading Better Auth, compare generated schemas with this one and produce reviewed D1 migrations. Never run auto-migrations against production without review.

## User journeys

1. `/signup` -> Better Auth sends verification email -> click email link -> `/signin`.
2. Login with verified email/password -> `/onboarding` -> create **one** organization (admin).
3. Admin `/team` -> invite email address with admin/member role -> invited user creates account if necessary -> verifies email -> opens `/invite?id=...` -> accepts -> joins organization. Invitation acceptance is rejected if the user already belongs to an organization.
4. `/settings` -> register/delete passkeys -> subsequently sign in with a passkey.
5. `/forgot-password` -> reset email -> `/reset?token=...` -> new password; previous sessions revoked.
6. Admin can promote another member before leaving/demotion. The last admin cannot leave, be removed, or be demoted, enforced by D1.

## Security / remaining release gates

- Review Better Auth + Drizzle generated schema against checked-in D1 SQL after dependency install.
- CI typecheck, Vitest, frontend build, and SQLite trigger smoke test must pass.
- Exercise actual Cloudflare Email Sending and WebAuthn on a HTTPS staging origin.
- Set up a Cloudflare WAF / Turnstile abuse policy for signup/credential stuffing and monitor rates.
- Test two simultaneous administrator removals, cross-organization access, user deletion, reset token reuse, expired invitations, and encrypted secret handling.
- Dependency upgrades should keep Better Auth scoped packages on matching patch versions.
- Launch only after a successful manual E2E demo and security review.
