# 02 — Identity, Workspaces & Tenant Isolation

> **Status: substantially implemented by PR #2** (`86c9679`), verified against the working
> tree on 2026-10-13. This file is no longer a from-scratch plan — it records what exists,
> what was deliberately decided, and the one large thing that is still missing.
>
> Adoption decision (2026-10-13): **Better Auth is the auth layer**; our data tables use
> Better Auth's `organization.id` **directly**, with no mapping table.

## What PR #2 delivered

| Capability | Implementation | Spec |
| --- | --- | --- |
| Identity, sessions, accounts | `betterAuth()` + Drizzle/D1 adapter | F15 |
| Password policy | `minPasswordLength: 12`, `requireEmailVerification: true`, `maxPasswordLength: 128` | F16 |
| Email verification | `sendVerificationEmail` via Cloudflare Email Sending, 1 h expiry | F17 |
| Password reset | `sendResetPassword`, `revokeSessionsOnPasswordReset: true` | F18 |
| Passkeys | `@better-auth/passkey`, RP ID derived server-side from `APP_ORIGIN` | F19 |
| Organizations, roles | `organization()` plugin, `admin`/`member` via `createAccessControl` | F20 |
| Invitations | `sendInvitationEmail`, `requireEmailVerificationOnInvitation: true` | F21 |
| Session lifetime | 30-day expiry, 24 h rolling refresh | F20 |
| Rate limiting | `rateLimit.storage: "database"` + per-route rules | F22 |
| CSRF / CORS | `trustedOrigins: [APP_ORIGIN]` | F23 |
| Multi-role authorization | `access` control statements, server-enforced | F24 |
| Signup → org onboarding | `web/src/onboarding.tsx` | F25 |

Two decisions in that implementation are worth keeping and saying out loud:

- **`rateLimit.storage: "database"`** rather than the default. The default is in-memory and
  therefore per-isolate — useless across Worker instances. This is the correct choice and it
  is rare enough that it deserves an ADR (F32).
- **Passkey `rpID` derived from `APP_ORIGIN`**, never from the client. Accepting the RP ID
  from the client is the classic WebAuthn misconfiguration.

## The gap that makes the rest provisional

Better Auth scoped **its own** tables. It did not scope ours.

```
member.organization_id          ✔
invitation.organization_id      ✔
session.active_organization_id  ✔

integrations            ⬜  migrations/0001, no tenancy column, routes on `repo`
deliveries              ⬜  no tenancy column
notification_outbox     ⬜  no tenancy column
event_receipts          ⬜  does not exist yet
```

`src/index.ts:32`:

```sql
SELECT id, destination, webhook_ciphertext, ... FROM integrations WHERE repo=? AND enabled=1
```

`repo` is `event.repository.full_name` — **request body content, chosen by the sender**. The
route sits outside Better Auth entirely and consults no session, no membership, no
organization. Any tenant that can create an integration row for `acme/repo` receives every
event GitHub sends about `acme/repo`.

> **The sentence to keep in every design doc and every review:**
> **The organization plugin is a membership registry. It is not a data-isolation boundary.**
> Isolation is an `organization_id` predicate we write ourselves, on every query, forever.

Everything in F25–F31 below exists because of that gap.

---

## F15 — Organization model

**Priority** P0 · **Status** ✅ multi-org: no `organizationLimit`; `selectMembership` returns 404 for non-member org, explicit `?org=` required on writes for multi-workspace users; `tests/workspace.test.ts`, `tests/api/org-required.test.ts`, `tests/api/workspace-active.test.ts` · **Decision changed 2026-10-13**

**Story** As a user, I want my notifications grouped under an organization, so that my
integrations and history are separate from anyone else's.

**What exists** — Better Auth's `organization` table with `id`, `name`, `slug`, `logo`,
`metadata`, `createdAt`, plus `activeOrganizationId` on `session`.

**Decision — relax to multi-organization.** PR #2 set `organizationLimit: 1` and added
`ensureNotMember` throwing on create, add-member and accept-invite. That contradicts
`docs/PRODUCT.md`, which names as audience #4: *"Agency/operator: needs many customer
workspaces without cross-tenant leaks."* Under the restriction an agency operator cannot
serve two clients, so the restriction excludes a named target segment.

**Acceptance**
- [ ] `organizationLimit` removed; `ensureNotMember` removed from all three hooks.
- [ ] The old `auth_memberships.user_id PRIMARY KEY` constraint is irrelevant (that table is
      dead — see F31).
- [ ] Active organization is user-selectable; `activeOrganizationId` is **display state only**.
- [ ] ⚠️ **The security invariant that replaces it:** every domain query filters on an
          organization the caller is a member of. Multi-org is safe *because* of F26, not
          instead of it.
- [ ] The API surface that resolves "which org is this request for" must be explicit — a
          route may not default to `activeOrganizationId` when an explicit org is supplied,
          and may not accept an org the caller is not a member of.

**Errors** — a request naming an org the caller does not belong to returns **404**, not 403.
A 403 confirms the organization exists, which is an enumeration channel.

**Security** — membership is re-checked server-side on every request, never trusted from a
client-supplied role.

**Tests**
- `user_can_belong_to_multiple_organizations`
- `active_organization_is_display_state_only`
- `request_for_a_non_member_organization_returns_404`
- `explicit_organization_overrides_active_organization`

**Deps** — blocks nothing; **enables** the agency audience in `docs/PRODUCT.md`.

---

## F16 — User identity

**Priority** P0 · **Status** 🟡 Better Auth config sets email verification required, min 12 / max 128 password (`src/auth/better-auth.ts`), unverified sessions refused (`src/auth/workspace.ts`). Not built: tests of the policy itself, explicit email-canonicalization check, account deletion path

**Acceptance** — verified present:
- [x] `user` table via Better Auth, email unique.
- [x] `requireEmailVerification: true`.
- [x] `minPasswordLength: 12`, `maxPasswordLength: 128`.
- [x] Generic responses — Better Auth owns this.

**Remaining**
- [ ] ⚠️ Email canonicalization is Better Auth's responsibility; verify explicitly rather
      than assuming (Trimmed/lower-cased comparison).
- [ ] Email is on the F12 log denylist. `web/src/lib/api.ts` must never log it.
- [x] Account deletion path: `DELETE /api/workspace/me` (slice S3, `docs/DSAR.md`). A sole admin is refused until another admin exists or the workspace is deleted; no step-up re-authentication (AR-41).

**Security** — Better Auth does the hashing; we do not reimplement. `AGENTS.md`'s lean-
dependency rule is deliberately traded here: hand-rolled session and password handling is
exactly the code we should not own.

---

## F17 — Email verification

**Priority** P0 · **Status** 🟡 `sendVerificationEmail` 1 h expiry, `sendOnSignIn`, 3/900 s resend limit configured (`src/auth/better-auth.ts`, `src/auth/email.ts`). Not built: tests (resend limit, unverified access), email-volume monitoring or provider migration plan, never sent via real Cloudflare Email Sending · **Note** documented constraint changed

**What exists** — `sendVerificationEmail` via `src/auth/email.ts`, 1-hour expiry,
`autoSignInAfterVerification: false`, `sendOnSignIn: true`.

**⚠️ Correction to `docs/AUTH_SETUP.md`** — it states that Cloudflare Email Sending cannot
send to arbitrary addresses and that *"Do not assume Send Email can send to arbitrary new
customer addresses."* That is now **outdated**. Current docs:

> "Before you onboard a sending domain, you can send emails only to verified destination
> addresses in your account. **After you onboard a sending domain, you can send to any
> recipient immediately.**" — [email-service/platform/limits](https://developers.cloudflare.com/email-service/platform/limits/)

Constraints that remain real: **Workers Paid only**, **Beta**, 3,000 emails/month included then
$0.35/1,000, **200 verified destinations** before a sending domain is onboarded, and you can
only send from your routing domains.

**Acceptance**
- [x] Verification required before sessions grant application access.
- [ ] Resend cooldown is configured (Better Auth rate limit: 3 per 900 s on
      `/send-verification-email`).
- [ ] ⚠️ At 3,000/month, verification mail is a **design constraint**, not a detail. Monitor
      consumption and migrate to a transactional provider before password resets + invites +
      verifications approach the allowance.
- [ ] Emails sent via the `send_email` binding appear as **"dropped"** in Email Routing
      summaries even when delivered. Do not build send-success analytics on Email Routing data.

**Tests** — `unverified_user_cannot_access_workspace_api` (present via
`workspace.ts:12`); `resend_is_rate_limited`.

---

## F18 — Password reset

**Priority** P0 · **Status** 🟡 `sendResetPassword` and `revokeSessionsOnPasswordReset: true` configured, 3/900 s limit (`src/auth/better-auth.ts`). Not built: tests for revocation or generic response, documented reset-link TTL, real email delivery check

**Acceptance**
- [x] `sendResetPassword` implemented.
- [x] `revokeSessionsOnPasswordReset: true` — all other sessions die on reset.
- [ ] Response is generic whether or not the email exists. Rate limited to 3 per 900 s.
- [ ] Reset link TTL is explicit and documented.

**Tests** — `reset_revokes_other_sessions`; `reset_response_is_generic_for_unknown_email`.

---

## F19 — Passkeys

**Priority** P1 · **Status** 🟡 `@better-auth/passkey` with `rpID`/`origin` from `APP_ORIGIN`, 10/60 s limit (`src/auth/better-auth.ts`), UI `web/src/passkeys.tsx`. Not built: tests, sign-counter regression handling unverified, passkey-only recovery path, no real-device WebAuthn run

**Acceptance**
- [x] `@better-auth/passkey` with server-derived `rpID`, `rpName`, `origin`.
- [x] WebAuthn management UI at `web/src/passkeys.tsx`.
- [x] Rate limited: 10 per 60 s on `/sign-in/passkey`.
- [ ] ⚠️ **Verify sign-counter handling.** A counter regression on a non-discoverable
      credential signals possible cloning and should prompt re-registration, not pass
      silently.
- [ ] ⚠️ **A passkey is not proof of ownership of a newly typed email address.** Invariant
      retained from `docs/AUTH_SETUP.md`; `requireEmailVerification` must still gate access.
- [ ] Recovery path when a passkey-only user has no verified email and no password.

**Tests** — `passkey_cannot_authorise_an_unverified_email`; `counter_regression_prompts_reregistration`.

---

## F20 — Sessions

**Priority** P0 · **Status** 🟡 DB sessions, 30-day expiry with 24 h refresh, `cookieCache` off asserted (`tests/security/config-guards.test.ts`), verified-email gate (`src/auth/workspace.ts`). Not built: session/device list and revoke UI, absolute-timeout decision · **Caveat**

**Acceptance**
- [x] Database-backed sessions via `session` table.
- [x] 30-day expiry, 24 h rolling update.
- [x] Revocation on password reset.
- [x] `workspace.ts:9` requires `emailVerified` before granting a session to app routes.

**⚠️ Caveat to state, not to hide** — Better Auth stores session tokens in the database in a
form it controls; the original D7 finding (our own plaintext `auth_tokens`) no longer applies
to the live schema. It still applies to the dead `0004` table (F31). Do not claim anything
about Better Auth's internal token storage beyond what its docs say.

**Remaining**
- [ ] Session/device management UI — list, revoke, revoke-others (F23).
- [ ] Idle vs absolute timeout are currently a single 30-day value. Decide whether a second
      absolute bound is wanted.

---

## F21 — Invitations

**Priority** P0 · **Status** 🟡 `sendInvitationEmail`, role validation, verified-email requirement on accept configured (`src/auth/better-auth.ts`); accept UI `web/src/onboarding.tsx`. Not built: tests for acceptance or role validation, explicit invite TTL, second-org-creation check

**Acceptance**
- [x] `sendInvitationEmail` with a `/invite?id=` link.
- [x] `requireEmailVerificationOnInvitation: true`.
- [x] Invites are **role-validated** in `beforeCreateInvitation`.
- [ ] Invite acceptance UI exists at `web/src/onboarding.tsx`; confirm it does not create a
      second organization for an existing user (this was the original invariant-2 risk).
- [ ] Invite TTL is explicit.
- [ ] Per F15, accepting an invite into a second organization is now **allowed**.

**Tests** — `invite_acceptance_does_not_create_an_organisation`;
`invite_requires_verified_email`.

---

## F22 — Rate limiting

**Priority** P0 · **Status** 🟡 Better Auth `rateLimit.storage: 'database'` with per-route rules and `cf-connecting-ip` configured (`src/auth/better-auth.ts`). Not built: any test of these rules; ingress limits live separately (F29)

**Acceptance**
- [x] `storage: "database"` — survives across Worker instances.
- [x] Per-route rules on sign-up (4/600 s), sign-in (5/60 s), reset (3/900 s), verify
      (3/900 s), invite (5/60 s), passkey (10/60 s).
- [x] IP source is `cf-connecting-ip`, not a spoofable header.

**Remaining**
- [ ] ⚠️ This rate-limits **auth endpoints only**. The webhook ingress route is not behind
      Better Auth and has no flood limit — see F29.
- [ ] Billing/quota accounting must **not** reuse these counters (see F28).

---

## F23 — CSRF and origin policy

**Priority** P0 · **Status** ✅ `requireSameOrigin` middleware enforces exact `APP_ORIGIN` on all mutating `/api/*` routes (`src/security/csrf.ts`); `trustedOrigins` pinned; `tests/security/csrf.test.ts`, `tests/api/workspace-active.test.ts`. SameSite cookie attribute not independently confirmed

**Acceptance**
- [x] `trustedOrigins: [env.APP_ORIGIN]` — single exact origin, no suffix matching.
- [x] Better Auth's CSRF is active on its routes.
- [ ] ⚠️ **Our own `/api/workspace/*` routes are not Better Auth endpoints.** They are
      session-cookie-authenticated custom Hono routes, so they need our own origin check and
      CSRF handling. Currently `workspace.ts` reads the session cookie and trusts it.
- [ ] Confirm `SameSite` on the session cookie.

**Tests** — `workspace_api_rejects_cross_origin_mutation`;
`workspace_api_rejects_missing_csrf_token`.

---

## F24 — Authorization model

**Priority** P0 · **Status** ✅ domain capabilities in `src/auth/permissions.ts`, single `authorize()` gate with audited denials and capability named in 403 (`src/auth/workspace.ts`); role x capability table in `tests/auth/permissions.test.ts` (PR #9); no viewer role

**What exists** — `src/auth/permissions.ts` defines `admin` and `member` via
`createAccessControl(defaultStatements)`:

| Capability | admin | member |
| --- | --- | --- |
| `organization.update` | ✅ | ❌ |
| `member.create/update/delete` | ✅ | ❌ |
| `invitation.create/cancel` | ✅ | ❌ |

**The missing half** — this capability set covers **Better Auth's** resources. There is **no**
capability for domain actions:

| Capability | admin | member | status |
| --- | --- | --- | --- |
| `integration.create/update/delete` | ✅ | ✅ | ❌ undefined |
| `destination.manage_credentials` | ✅ | ✅ | ❌ undefined |
| `delivery.replay` | ✅ | ❌ | ❌ undefined |
| `audit.read` | ✅ | ❌ | ❌ undefined |
| `workspace.delete` | ✅ (owner) | ❌ | ❛ disabled (N3) |

**Acceptance**
- [ ] Domain capabilities are added to the `ac` definition.
- [ ] `viewer` is **not** added in V1 — it requires changing the role set and the CHECK
      constraints, for no V1 value.
- [ ] Permission checks are server-side on every mutating route. Client-side button hiding is
      never the control.
- [ ] The capability name appears in a 403 so support can diagnose it.

**Security** — one `authorize(actor, orgId, capability)` helper. A missed check must be a
missing argument, not a missing `if`.

**Tests** — table-driven over (role × capability), including the undefined ones.

---

## F25 — Domain tenancy bridge

**Priority** P0 · **Status** 🟡 contract done in schema: `organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE` on `integrations`, `deliveries`, `notification_outbox`, `held_events`, `routing_decisions`, `noise_open_failures` (`migrations/0026_tenant_contract.sql`: backfill only where derivable, quarantine of the rest, per-table row-count check, ADR 0021; `tests/migration-0026.test.ts`); every-tenant-table schema test (`tests/security/tenant-query-scope.test.ts`). Not built: chunked backfill (one statement per table, fine only while tables are small), rollback rehearsal on a real D1, dropping `integrations.repo` as a routing key

**Story** As a security reviewer, I want every tenant-owned record to carry an organization
id, so that isolation is representable in the schema and not merely intended in application
code.

**Acceptance**
- [ ] `integrations`, `deliveries`, `notification_outbox`, and all new tables gain a
      `NOT NULL organization_id` referencing `organization(id)`.
- [ ] Use Better Auth's `organization.id` **directly**. No mapping table, no sync job, no
      dual key.
- [ ] Migration is **expand / backfill / contract**, never a rewrite of `0001` — `0001` has
      already been applied to live databases:
      1. add nullable `organization_id` + index, backfill in **~1,000-row chunks**
         (Cloudflare requires batching large data migrations)
      2. deploy code tolerant of null
      3. enforce `NOT NULL` + FK
      4. later: drop `integrations.repo` as a routing key
- [ ] `repo` survives as a **display attribute** only.
- [ ] Row counts compared before/after; a mismatch fails the migration.
- [ ] No public signup until this lands — `docs/RELEASE_GATES.md` already says so.

**Design** — This cannot be retrofitted as a side effect of the auth work, because the auth
work had no model of where a webhook's events should go. The **only** correct way to resolve
`organization_id` for an inbound event is the GitHub App installation (F25 in
`06-source-github.md`), which does not exist yet.

**Errors** — a failed backfill aborts before the `NOT NULL` step, leaving a schema the
deployed code can read.

**Security** — this *is* the tenant boundary at rest. Without it there is nothing for the
authorization layer to enforce.

**Tests** — `every_tenant_table_has_organization_id` (static); `backfill_is_chunked`;
`rollback_to_pre_contract_is_rehearsed`.

**Deps** — F32 (installation registry). **Blocks** F26, F27, public signup.

---

## F26 — Tenant-scoped authorization

**Priority** P0 · **Status** 🟡 `authorize()` resolves membership then scopes every domain query by `organization_id`; cross-tenant 404 tested (`tests/api/integrations.test.ts`, PR #9); static every-query test with a reviewed, no-dead-entry allowlist (42 entries) (`tests/security/tenant-query-scope.test.ts`, scanner `tests/support/sql-scope.ts`, ADR 0021). Not built: repository functions that take the organization as a parameter (queries are inline literals checked by the scanner, not typed functions); the scanner cannot see dynamically assembled SQL

**Story** As a security reviewer, I want every data access to require an explicit
organization scope, so that a missing filter is a type error rather than a breach.

**What exists (good pattern, keep it)** — `workspace.ts:39-52` resolves the caller's
membership first, then joins through `membership.organizationId`. That is the right shape.

**Acceptance**
- [ ] The same shape applies to every domain query: resolve membership → scope by
      `organizationId` → act.
- [ ] Every repository function takes the organization id explicitly. There is no unscoped
      `getIntegration(id)`.
- [ ] ⚠️ **The authorization decision comes from the verified credential, never from the
      payload.** `WHERE organization_id = ? AND connection_id = ?`, where `connection_id`
      resolved by verifying the signature against that connection's own credential. This is
      the exact inversion of today's `WHERE repo = <body field>`.
- [ ] Cross-tenant access returns **404**, not 403.
- [ ] A test greps the query builders for a missing `organization_id` predicate.

**Tests**
- `repository_functions_require_an_organization_scope` (static)
- `every_tenant_query_filters_by_organization_id` (static)
- `cross_organization_read_returns_404`
- `body_supplied_identifiers_are_never_authorization`

**Deps** — F25.

---

## F27 — Connection and installation registry

**Priority** P0 · **Status** ✅ `github_installations` with unique installation id, tenant taken from the verified installation row, unknown installation refused (PR #6, PR #11, ADR 0008; `tests/github/install-flow.test.ts`). Audit of unknown-installation 403s not built

**Story** As an operator, I want every inbound event to resolve to exactly one organization
through its verified installation, so that no event can be routed using sender-chosen data.

**Acceptance** — fully specified in `06-source-github.md` F55–F57. In summary:
- [ ] `github_installations(organization_id, installation_id UNIQUE, app_id, …)`.
- [ ] Lookup `WHERE installation_id = ? AND app_id = ?` → organization from **our row**.
- [ ] Missing installation → 403 + audit, never "route to all".
- [ ] `X-GitHub-Hook-Installation-Target-*` are **not** used for routing.

**Deps** — F25. This is the bridge between the two halves of the system.

---

## F28 — Audit events

**Priority** P1 · **Status** 🟡 `audit_events` append-only with integration, source, replay, denial, installation and workspace events (`src/audit/actions.ts`, PR #9), admin `GET /api/audit` plus page (ADR 0019); the request id is stamped on every row written in a request (migration 0028, ADR 0028). Not built: member/invite/role/session events, actor email by decision; IP and user agent stored but not shown

**Acceptance**
- [ ] `audit_events(id, organization_id, actor_id, action, subject_type, subject_id,
      ip, user_agent, metadata_json, created_at)`, append-only.
- [ ] Recorded for: integration CRUD, destination credential add/rotate/revoke, member
      invite/remove/role change, delivery replay, workspace rename/delete, session
      revocation, cross-tenant access denials, installation lifecycle.
- [ ] ⚠️ **Cross-tenant denials are the highest-value row and the easiest to forget.** They
      must be emitted by the authorization layer itself (F26), not by individual routes.
- [ ] Actor email stored redacted; actor id authoritative.
- [ ] `metadata_json` redacted through F12 and size-capped.

**Deps** — F12, F26.

---

## F29 — Webhook ingress protection

**Priority** P0 · **Status** 🟡 per-installation GitHub limiter (`ingressLimiter`, `tests/security/rate-limit.test.ts`) and per-source flood limit with 429 + Retry-After for generic and provider sources (`tests/sources/ingress.test.ts`); D1 counters, fails open. Built in ADR 0028: the full-route GitHub 429 with `Retry-After` (`tests/github/ingress-codes.test.ts`) and usage accounting kept apart from the abuse counters (`ingress_usage`, `src/security/ingress-usage.ts`: accepted, duplicate and rate-limited events per workspace, UTC day and source; best effort, so it can under-count, and it is not a billing meter). Not built: keying per `(organization_id, connection_id)` (F27), billing-grade metering (F253)

**Story** As an operator, I want webhook ingress bounded, so that one misbehaving provider
cannot exhaust our Worker quota.

**Acceptance**
- [ ] `POST /webhooks/github` has **no** auth rate limit today — Better Auth's rules apply
      only to `/api/auth/*`. This route needs its own flood control.
- [ ] Keyed per `(organization_id, connection_id)` once F27 exists; by connection id before
      that.
- [ ] `429` with `Retry-After` (F50).
- [ ] ⚠️ A quota/billing counter must be **separate** from the auth rate-limit tables —
      Better Auth's `rate_limit` table is for abuse, not accounting.
- [ ] ⚠️ Cloudflare's Rate Limiting binding is per-location and "not an accurate accounting
      system"; a D1-backed counter is authoritative.

**Tests** — `webhook_ingress_is_rate_limited_per_connection`;
`auth_rate_limits_are_not_reused_for_quota`.

---

## F30 — Workspace deletion and data export

**Priority** P1 · **Status** ✅ two-phase deletion, bounded purge, credential-free export (PR #12); personal-account export and erasure added in slice S3 (`docs/DSAR.md`)

**Acceptance**
- [ ] ⚠️ `disableOrganizationDeletion: true` currently makes this **impossible**. Either
      enable deletion or build an owner-initiated purge. `docs/SECURITY.md` commits to data
      deletion; today there is no path.
- [ ] Two-phase: soft-stop ingestion and delivery → retention window → hard purge of
      envelopes, raw bodies and ciphertext.
- [ ] Export produces a machine-readable archive with **credentials redacted**.
- [ ] D1 Time Travel retains up to 30 days and restores are in-place
      ([d1/reference/time-travel](https://developers.cloudflare.com/d1/reference/time-travel/)),
      so erasure-from-backups cannot be promised faster than that. Documentation must say so.

**Tests** — `workspace_deletion_purges_all_tenant_data`; `export_omits_credentials`.

**Deps** — F25, N3.

---

## F31 — Retire the superseded identity schema

**Priority** P1 · **Status** ✅ `migrations/0004_identity.sql` marked superseded, `docs/AUTH_SETUP.md` rewritten, CI guard that no source references retired tables (`tests/retired-schema.test.ts`, ADR 0003, PR #12) · **Decision: documentation only**

**Acceptance** — per the decision taken 2026-10-13, **no schema change**:
- [ ] `migrations/0004_identity.sql` gains a header comment naming it **superseded by
      `0005_better_auth.sql`** and listing the six tables it creates:
      `auth_users`, `auth_orgs`, `auth_memberships`, `auth_tokens`, `auth_invites`.
- [ ] It stays in the chain. It cannot be dropped — it has already been applied — and adding
      a destructive migration risks more than dead tables cost.
- [ ] ⚠️ **`auth_tokens` has no hash column.** Any future code that reads it reads plaintext
      tokens. That is the reason for the comment, and the reason the legacy invariants in
      `docs/AUTH_SETUP.md` must not be carried forward as if they described the live schema.
- [ ] An ADR records why the tables were left in place.
- [ ] ⚠️ `docs/AUTH_SETUP.md` is rewritten to describe Better Auth. It currently documents
      deleted code (`src/auth/crypto.ts` PBKDF2, `auth_users`, `auth_tokens`) and is the most
      likely thing to mislead the next contributor.

**Tests** — a CI check that no source file references `auth_users`, `auth_orgs`,
`auth_memberships`, `auth_tokens` or `auth_invites`.

**Deps** — none.

---

## F32 — Better Auth ADR

**Priority** P1 · **Status** 🟡 `docs/adr/0003-better-auth.md` records Better Auth ownership, pinned versions, `organization.id` reuse, database rate-limit storage, server-derived passkey RP ID, plugin-is-not-isolation. Not recorded: multi-org decision as accepted (still listed under revisit), Email Sending constraint

**Records**
1. Better Auth owns identity, sessions, organizations, roles, invitations, passkeys and auth
   rate limiting. `AGENTS.md`'s lean-dependency rule is traded deliberately: hand-rolled
   session and password handling is code we should not own.
2. `organization.id` is used directly in our tables — no mapping layer.
3. **`rateLimit.storage: "database"`** — the default is per-isolate in-memory and therefore
   ineffective across instances.
4. Passkey `rpID`/`origin` are derived from `APP_ORIGIN`, never from the client.
5. **Multi-organization is allowed** (F15), and isolation comes from `organization_id`
   predicates, not from membership cardinality.
6. The Cloudflare Email Sending Paid/Beta/3,000-per-month constraint is accepted for V1 and
   is a known scaling limit.
7. What Better Auth does **not** do, restated so it is never forgotten: it does not scope our
   domain queries. That is F25/F26 and it is ours.

**Deps** — none.