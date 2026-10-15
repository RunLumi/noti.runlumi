# Identity and workspaces

> **Supersedes the hand-rolled identity design.** The previous revision of this document
> described `migrations/0004_identity.sql`, PBKDF2 in `src/auth/crypto.ts`, a custom
> `auth_tokens` table and a one-user-one-organization rule. None of that is the current
> design. See `docs/adr/0003-better-auth.md`.

## Stack

Better Auth (`better-auth`, `@better-auth/passkey`, `@better-auth/drizzle-adapter`) on Hono,
D1 via Drizzle. Versions are pinned exactly in `package.json`; the three Better Auth packages
must move together.

Current: **1.7.7**. Why pinned exactly: `better-auth@1.6.33` depended on
`@better-auth/core@^1.6.33`, which floated to 1.7.7 while `@better-auth/passkey@1.6.33` still
pegged `@better-fetch/fetch@1.3.1`. That conflict made `npm install` fail outright, and CI
was broken on `main` until it was fixed. Do not reintroduce caret ranges across this family.

## What is implemented

| Capability | Where |
| --- | --- |
| Email + password, 12-char minimum | `src/auth/better-auth.ts` |
| Email verification required before access | `emailVerification`, enforced in `src/auth/workspace.ts` |
| Password reset, revoking other sessions | `revokeSessionsOnPasswordReset: true` |
| Passkeys | `@better-auth/passkey`, RP ID derived server-side from `APP_ORIGIN` |
| Organizations, roles `admin`/`member` | `organization()` plugin + `src/auth/permissions.ts` |
| Invitations, email-verification gated | `sendInvitationEmail`, `requireEmailVerificationOnInvitation: true` |
| Auth rate limiting | `rateLimit.storage: "database"` |

Two configuration choices worth preserving deliberately:

- **`rateLimit.storage: "database"`.** The Better Auth default is an in-process `Map`, which
  is per-V8-isolate. On Workers that is effectively unenforced — a client can spread requests
  across isolates and multiply its effective limit. Database storage is correct here.
- **Passkey `rpID` and `origin` derived from `APP_ORIGIN`.** Never from the client. Accepting
  the RP ID from a request is the classic WebAuthn misconfiguration.

## Required environment

- Migration `0005_better_auth.sql` (the auth schema). `0004_identity.sql` is **superseded**;
  it still creates six unused tables and cannot be dropped because it has already been applied
  to live databases. See `docs/specs/02-identity-tenancy.md` F31.
- `BETTER_AUTH_SECRET` — minimum 32 characters, asserted in `createAuth()`.
- `APP_ORIGIN` and `AUTH_FROM_EMAIL` as non-secret vars; `AUTH_EMAIL` as the Cloudflare
  Email Sending binding. Both mail bindings are in the boot check's auth tier (ADR 0047): without them every
  `/api` request answers 503, because no account could ever be verified.
- `SIGNUP_MODE` (`open`, `invite_only`, `closed`; `wrangler.jsonc` deploys `invite_only`) and the
  `SIGNUP_ALLOWLIST` secret for the first operator's address. Enforced in Better Auth's `user.create.before`
  hook, so every account-creating path is covered (`src/auth/signup-policy.ts`, `docs/RUNBOOK.md`).
- `tests/config.dev_vars.test.ts` asserts `.dev.vars.example` and the source agree, so a
  secret can no longer be renamed in code without failing CI.

### Cloudflare Email Sending — corrected

The previous revision of this document said *"Do not assume Send Email can send to arbitrary
new customer addresses."* That is **outdated**. Current behaviour:

> "Before you onboard a sending domain, you can send emails only to verified destination
> addresses in your account. **After you onboard a sending domain, you can send to any
> recipient immediately.**"
> — https://developers.cloudflare.com/email-service/platform/limits/ (read 2026-10-13)

Constraints that remain real: **Workers Paid only**, **Beta**, 3,000 emails/month included then
$0.35/1,000, **200 verified destinations** per account before a domain is onboarded, and you
may only send from your routing domains. At 3,000/month, verification + reset + invitation mail
is a real budget line — monitor it before it becomes an incident.

## Known limits and accepted risks

These are properties of the chosen design, not oversights.

| Risk | Detail | Status |
| --- | --- | --- |
| **Session tokens are stored in plaintext in D1** | Better Auth stores the raw token and looks it up by exact match. There is no configuration option to hash it. A read-only D1 compromise yields usable session cookies. | Accepted; see `15-security-and-compliance.md`. Redact `session.token` everywhere; note Better Auth's own docs contain a `databaseHooks` example that logs it — do not copy that. |
| **One organization per user** | `organizationLimit: 1` plus `ensureNotMember` hooks. Contradicts the agency audience in `docs/PRODUCT.md`. | Decision recorded in `02` F15 to relax; code change still to do |
| **No self-service workspace deletion** | `disableOrganizationDeletion: true` with no replacement. | Open — `02` F30 |
| **Auth DB cannot be sharded** | Better Auth takes a single `database` instance. Application tables can still be sharded separately. | Accepted; see `01` F06 |
| **D1 has no interactive transactions** | Password reset and membership changes can partially fail. | Documented; `02` F17 |

## What Better Auth does **not** do

> **The organization plugin is an authorization and membership registry. It is not a
> data-isolation boundary.**

It scopes `member`, `invitation`, `organization` and `session`. It has no effect on
`integrations`, `deliveries` or `notification_outbox`, because it has no knowledge of them.
Every query against our own tables must carry an explicit `organization_id` predicate derived
from a server-side membership check — never from client input, and never from
`session.activeOrganizationId` alone.

**Today that predicate does not exist.** `src/index.ts` still runs
`SELECT ... FROM integrations WHERE repo=?` where `repo` is `event.repository.full_name`, and
no tenant-owned table carries an organization column. This is the release gate. See
`docs/specs/02-identity-tenancy.md` F25–F27 and `00-current-state.md` D2/D3.

## Enforcement

- `workspace.ts` resolves the caller's membership **first**, then joins through
  `membership.orgId`. That ordering is the pattern every domain query must follow.
- Roles live in `src/auth/permissions.ts`. That capability set currently covers only
  Better Auth's own resources; `integration`, `destination`, `replay` and `audit`
  capabilities are undefined and need adding (`02` F24).
- Cross-tenant access must return **404**, never 403 — a 403 confirms the row exists.
- `/api/workspace/*` are our own Hono routes, not Better Auth endpoints, so they need their
  own origin and CSRF handling. Better Auth's protection does not extend to them.

## Acceptance tests still required

Before public multi-tenant auth: E2E for signup → verify → sign in → create workspace →
invite → accept; invitation rejection and expiry; simultaneous last-admin departures;
session revocation on reset; passkey registration, authentication and replay; sign-up rate
limit; and a cross-tenant access suite asserting 404 for every tenant-owned route.