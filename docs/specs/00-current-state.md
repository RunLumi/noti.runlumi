# 00 — Current State Audit

> **Re-verified 2026-10-13 against commit `86c9679`** (PR #2, "Better Auth + React
> frontend"). The original audit below was taken at `5761257`. Changes are marked
> ✅ resolved · 🟡 partly resolved · ⬜ unchanged.
> Method: read every source file, migration, config, test and doc.
> This is an internal audit of code we own. It contains **no external claims**.

## 0. Summary of the Better Auth migration (PR #2)

**Resolved**

| Item | Evidence |
| --- | --- |
| Hand-rolled auth deleted | `src/auth/crypto.ts` **removed** |
| Real identity | Better Auth + Drizzle/D1: `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation`, `passkey`, `rate_limit` |
| Secret validation at construction | `BETTER_AUTH_SECRET` length asserted in `createAuth()` |
| CSRF/CORS origin | `trustedOrigins: [env.APP_ORIGIN]` |
| Password policy | `minPasswordLength: 12`, `requireEmailVerification: true`, `revokeSessionsOnPasswordReset: true` |
| Passkeys | `@better-auth/passkey`, with `rpID`/`origin` derived **server-side** from `APP_ORIGIN`, never client-supplied |
| Rate limiting that survives scale | `rateLimit.storage: "database"` — correct choice; the default is per-isolate in-memory |
| Client IP for rate limiting | `ipAddress.ipAddressHeaders: ["cf-connecting-ip"]` |
| Auth-side tenant scoping | `src/auth/workspace.ts` resolves membership first, then joins through `membership.orgId` |
| Frontend typecheck in CI | `typecheck:web`, `build:web` added |

**The critical point:** Better Auth scoped **its own** tables. It did **not** scope ours.

```
member.organization_id  ✔  exists
invitation.organization_id  ✔  exists
session.organization_id  ✔  exists (active_organization_id)

integrations  ⬜  still migrations/0001 — NO tenancy column, still routes on `repo`
deliveries  ⬜  no tenancy column
notification_outbox  ⬜  no tenancy column
```

`src/index.ts:32` still reads:

```sql
SELECT ... FROM integrations WHERE repo=? AND enabled=1
```

`repo` is `event.repository.full_name` — **attacker-supplied request body content**. The
webhook route is not behind Better Auth and consults no session or organization. **D2 and D3
are untouched by PR #2 and remain the single largest gap between this repo and a shippable
multi-tenant product.**

## 0b. New findings introduced or revealed by PR #2

### N1 — A dead parallel auth schema still exists in the migration chain ✅ marked
`migrations/0004_identity.sql` creates `auth_users`, `auth_orgs`, `auth_memberships`,
`auth_tokens`, `auth_invites`. Better Auth replaced all of them in `0005`. A **fresh**
database still gets six unused tables — including `auth_tokens`, which has **no hash column**
(the original D7 defect), so any future code that reads it reads plaintext tokens.
Cannot be dropped (already applied); must be documented as deprecated, and `0004` must be
labelled so nobody re-reads it as the current design.

### N2 — `organizationLimit: 1` contradicted the stated audience ✅ resolved
`better-auth.ts` set `organizationLimit: 1`, and `ensureNotMember` threw
`"An account can belong to only one organization"` on create, add-member and accept-invite.
`docs/PRODUCT.md` names as audience #4: **"Agency/operator: needs many customer workspaces
without cross-tenant leaks."** With this setting an agency operator cannot serve two clients.

**Resolved 2026-10-13.** `organizationLimit` and `ensureNotMember` are removed. Relaxing the
cap alone would have introduced a tenant leak — see N7 — so the selection rule was rewritten
in the same change.

### N3 — No self-service workspace deletion ✅ resolved (PR #12)
Better Auth's own deletion stays disabled. Noti's two-phase deletion replaces it: an admin
request soft-stops the workspace, a 7-day cancel window follows, then a cron purge removes
the data (`src/api/workspace-lifecycle.ts`, `src/pipeline/purge.ts`).

### N4 — `createAuth()` constructed per request ❌ was a false positive
`src/auth/workspace.ts` calls `createAuth(c.env, c.executionCtx)` on every request.

**Reassessed and deliberately left as-is**, with a comment in the source explaining why. The
original reasoning — defeating Better Auth's schema-validation cache — does not hold here:
with the Drizzle adapter, validation inspects the local schema object and issues **no**
database query. Meanwhile [better-auth#10315](https://github.com/better-auth/better-auth/issues/10315)
(open, filed from a production incident) shows promises cached on a Better Auth instance can be
poisoned when the first client disconnects, hanging every later request on that isolate.
Module-scope caching would widen that blast radius. Per-request construction is the safer
shape until the upstream bug is fixed.

### N5 — `docs/AUTH_SETUP.md` was actively wrong ✅ resolved
It documented `auth_users`, PBKDF2 in `src/auth/crypto.ts`, `auth_tokens`, a hand-built
passkey plan and `AUTH_EMAIL` setup — all superseded. It also carried an out-of-date claim
that Cloudflare Email Sending cannot send to arbitrary recipients; that restriction was
lifted once a sending domain is onboarded. Rewritten against the working tree on 2026-10-13.

### N6 — No bridge from a GitHub installation to an organization ✅ resolved (PR #6, PR #11)
`migrations/0006` adds `github_installations` (unique per `(installation_id, app_id)`, cascades
with the organization). `/webhooks/github` now resolves the tenant **only** from the verified
payload's `installation.id`, scoped to our `GITHUB_APP_ID`, and rejects every other outcome
with `403` — unknown installation, foreign App, missing block, suspended or uninstalled.
PR #11 adds the install flow that writes that row. The claimed installation id is verified
with the installer's own token (ADR 0008), and lifecycle events keep the row current.

### N7 — Ambiguous membership selection would have leaked a tenant ✅ resolved
Found while implementing N2 — the most valuable thing in this change.

`GET /team` resolved the caller's organization with:

```ts
.where(eq(schema.member.userId, s.user.id)).limit(1)
```

With one organization that is correct. The moment `organizationLimit` was relaxed it would
return **whichever** membership the database happened to yield first, and `/team` would list
**that organization's members** to a user who also belongs to another. Multi-organization
support would have converted a latent assumption into a cross-tenant read — the same defect
class as D3, arriving through a different door.

Resolved by extracting `selectMembership` as a pure function: an explicit `?org=` request
(validated against membership, `404` when absent), then the session's active organization,
then the single-membership case, and **refusal when ambiguous** rather than a guess. Covered
by 11 cases in `tests/workspace.test.ts`, including a stale-active-organization case that must
not silently fall through to another tenant.

## 1. What exists today

| Area | File | State |
| --- | --- | --- |
| Worker entry | `src/index.ts` | Hono app, 3 routes: `GET /health`, `POST /webhooks/github`, `scheduled`, `queue` |
| GitHub verification | `src/connectors/sources/github/events.ts` | HMAC-SHA256 verify + event classifier |
| Lark destination | `src/connectors/destinations/lark/webhook.ts` | Card 2.0 renderer, signature, response check |
| Slack destination | *inline in `src/index.ts`* | **No adapter file.** Payload is `{text}`, no Block Kit |
| Auth crypto | `src/auth/crypto.ts` | `randomToken`, `sha256`, PBKDF2 password hash |
| Schema | `migrations/0001`–`0004` | 8 tables |
| Tests | `tests/github.test.ts`, `tests/lark.test.ts` | 9 unit assertions total |
| CI | `.github/workflows/ci.yml` | `npm install` + typecheck + vitest |
| Build | `package.json` | **No lint, no format, no build, no coverage** |

Data flow as implemented:

```
GitHub → verify HMAC → classify → SELECT integrations WHERE repo=? AND enabled=1
       → INSERT deliveries + INSERT notification_outbox (batched, NOT atomic)
       → waitUntil(dispatchOutbox) AND cron "* * * * *" both publish
       → Queue consumer → decrypt → hostname allowlist → fetch → UPDATE deliveries
```

## 2. Verified defects

Status as of slice 4 (2026-10-13):

| # | Defect | Status |
| --- | --- | --- |
| D1 | Secret name mismatch | ✅ `.dev.vars.example` declares every binding the Worker reads; guarded by `tests/config.dev_vars.test.ts` |
| D2 | No tenant boundary in schema | 🟡 expand phase: nullable `organization_id` on `integrations`, `deliveries`, `notification_outbox` (0006); NOT NULL contract migration pending backfill |
| D3 | Routing keys on `repo` from body | ✅ tenant comes from the verified installation; `repo` only narrows within that tenant |
| D4 | Queue publish not atomic with claim | ✅ lease-fenced atomic outbox claim plus a consumer claim on the ledger row; the reconciler reclaims expired leases (slice 4) |
| D5 | Secrets copied into queue bodies | ✅ messages carry ids only; consumer re-reads the row by `id AND organization_id` (PR #7) |
| D6 | No envelope encryption, AAD or key version | ✅ envelope + AAD + versioned KEK + rewrap + v0 migration (PR #7, ADR 0004) |
| D7 | Plaintext session tokens | 🟡 moot for Better Auth's `session`; ⬜ `0004`'s dead `auth_tokens` still plaintext (N1) |
| D8 | Slack has no adapter | 🟡 Slack/Teams/Lark adapters + capability model shipped as pure modules (ADR 0006); consumer wiring pending slice 4 |
| D9 | Allowlist runs too late | ✅ enforced at write time by the integrations API and again before every send (PR #9) |
| D10 | Delivery-id collisions | ✅ delivery id is SHA-256 over 0x00-separated `(dedup_key, destination)`; rows with legacy ids are still served (slice 4) |
| D11 | No error classification | 🟡 F13 taxonomy, bounded two-tier retry, terminal `dead_lettered`; provider mappings beyond Lark and generic HTTP wait for slice 5 (slice 4) |
| D12 | `event_types` unvalidated JSON | ✅ validated against the closed catalog on every write (PR #9) |
| D13 | No integration test of the delivery path | ✅ `tests/pipeline/delivery-path.test.ts` runs ingress → outbox → queue → consumer over the real migrations (PR #7) |
| D14 | CI does not enforce the documented workflow | 🟡 `npm ci`, format, lint, typecheck, build, tests and bundle guard enforced; coverage threshold not yet |
| D15 | Magic 1 MiB webhook cap | ⬜ unchanged |
| D16 | Unbounded event-type string space | ✅ closed 18-type catalog; ingress ignores anything else (PR #9) |

New: **N1–N7** above. N2, N4, N5 and N7 are resolved; N1 is marked; N3 and N6 are resolved.

Each item below is reproducible from the code. Severity is our judgement.

### D1 — Secret name mismatch breaks local dev (blocker)
`.dev.vars.example:2` declares `ENCRYPTION_KEY_BASE64`; `src/index.ts` reads
`env.ENCRYPTION_KEY` and decrypts with it. Following the documented setup
in `docs/IMPLEMENTATION.md` step 5 works only if the developer ignores the example file.
There is no schema-level or startup-level validation that would surface this.

**Now also wrong in the other direction:** PR #2 added `BETTER_AUTH_SECRET`, `APP_ORIGIN`,
`AUTH_FROM_EMAIL` and an `AUTH_EMAIL` binding, and `.dev.vars.example` lists **none** of them.
A developer following the example file now gets an auth module that throws on first request.

**Fix:** converge on one name and one encoding; add a startup assertion + a unit test that
reads `.dev.vars.example` and asserts every key it declares is referenced in `Bindings`.

### D2 — Single global webhook secret is not multi-tenant (blocker)
`GITHUB_WEBHOOK_SECRET` is one Worker secret. Routing is by
`integrations.repo` — a plain, **attacker-supplied string** from `event.repository.full_name`.
There is no `workspace_id` on any table, so there is no tenant boundary to enforce.
Any tenant that can create an integration for `acme/repo` can receive another tenant's
events for that repository.

This is already acknowledged in `docs/RELEASE_GATES.md`. It is the single largest
distance between the code and a shippable product.

**Fix:** F02 (tenancy), F19 (per-connection credential lookup), F27 (GitHub App
installation binding). Until F02 lands, the product must not accept public signups.

### D3 — Routing is `repo`-only, and `repo` is trusted input
`SELECT ... WHERE repo=?` with no tenant predicate and no index on the
credential actually used to authenticate the request. Even with tenancy added, the
*authorization* decision must come from the verified credential / installation,
never from a body field. See F19.

### D4 — Queue publish is not atomic with the claim (reliability)
`dispatchOutbox` (`src/index.ts:88`) calls `Queue.send()` then `UPDATE ... state='dispatched'`.
A crash between the two re-enqueues on the next cron pass. Two additional amplifiers:

1. The webhook handler calls `dispatchOutbox` via `waitUntil` **and** cron runs every minute,
   so both paths can pick the same `pending` row concurrently. The `SELECT` has no claim
   step (`UPDATE ... WHERE id=? AND state='pending'` returning `changes`).
2. The queue consumer has no pre-flight guard — it does not check `deliveries.state`
   before sending. A duplicate message causes a duplicate external notification.

At-least-once is the correct contract, but the *duplication window is currently unbounded*
rather than bounded to a network timeout. F107 (atomic claim), F108 (idempotent consumer),
F112 (dedupe window) close this.

### D5 — Encrypted secrets are copied into queue message bodies
The `Delivery` payload carries `ciphertext` and `larkSecretCiphertext` into the Queue.
Secret material is replicated into queue storage and visible in queue inspection tooling.
It also means a rotated key breaks in-flight messages.

**Fix:** queue only `delivery_id`; the consumer reads the destination row from D1. F104.

### D6 — Encryption has no version, no AAD, no rotation
`decrypt()` uses a bare AES-GCM with a 12-byte IV prefix and **no additional authenticated
data**. Without AAD, a ciphertext cannot be bound to its row — a ciphertext swapped between
two `integrations` rows decrypts cleanly and is delivered to the wrong destination.
There is no key version column and no rotation path.

**Fix:** F152 (envelope encryption with AAD binding to `integration_id`), F155 (rotation).

### D7 — PBKDF2 with no work factor contract, and no password hash in the token table
`hashPassword` uses PBKDF2-SHA256 / 310k iterations. Reasonable, but:

- `auth_tokens` (`migrations/0004`) has **no hash column** — sessions/verify/reset tokens are
  stored as plaintext IDs. `AGENTS.md` requires tokens "stored hashed". A D1 read therefore
  leaks every live session. F21.
- No password policy, no breached-password check, no `alg`/`params` column to allow
  migrating the work factor later. F22.

### D8 — Slack has no adapter and no capability model
Slack delivery is a single `fetch` with `{text: title + '\n' + url}` inside
`src/index.ts:66`. There is no `render`, no `classifyError`, no Block Kit, no
`client_msg_id` dedupe, no `chat.update`. Lark gets a proper adapter; Slack gets an
inline string. `AGENTS.md` requires capability-aware renderers. F53.

### D9 — Destination allowlist is correct but late and duplicated
`src/index.ts:65` validates `https:` + hostname + path prefix + no userinfo, and sets
`redirect:'error'`. This is good. But it runs in the queue consumer, after the secret was
persisted — so a hostile URL can be stored and only rejected at send time, and the failure
is indistinguishable from a provider outage. Validation must run at **write time** (F72)
and be defence-in-depth at send time.

### D10 — `PRIMARY KEY (id)` collisions across the outbox/delivery fan-out
Delivery id is `x-github-delivery + ':' + integration_id`. Two *different destinations*
configured as two integration rows are fine, but two rows for the **same** destination and
event type silently collapse via `INSERT OR IGNORE`, and the second is dropped with no
signal. There is no uniqueness on (event, integration, destination, channel). F110.

### D11 — No error classification
Every failure becomes `state='retrying'` with `e.message` truncated to 100 chars. A permanent
failure (404 revoked webhook, 403 revoked token, 410 deleted channel) is retried the full
5 times, then dropped by the DLQ silently. `docs/RELEASE_GATES.md` requires
"don't leave exhausted deliveries as 'retrying'". F109 (classification), F113 (DLQ surfacing).

### D12 — `event_types` is unvalidated JSON in a TEXT column
`JSON.parse(row.event_types)` inside a `try/catch` that `continue`s — a corrupt row is
silently skipped forever. No FK, no normalised event-type table, no way to report a broken
integration to the user. F30.

### D13 — No test of the actual delivery path
Both test files are pure unit tests of helpers. There is **no** integration test that runs
the Worker, and no test for: signature rejection at the route, idempotency, the outbox
transaction, queue retry, DLQ, or the SSRF guard. `docs/RELEASE_GATES.md` requires them.
F120.

### D14 — CI does not enforce the documented workflow
`AGENTS.md` requires format, lint, typecheck, unit, integration, build. CI runs
`npm install` (not `npm ci` — no lockfile committed), typecheck, vitest. No lint, no format,
no build, no coverage, no `npm audit`. `tsconfig.json` sets `strict: true` but not
`noUncheckedIndexedAccess`, which is why `src/index.ts:20` can do
`keyHex.match(/../g)!` and get away with it. F08, F09.

### D15 — 1 MiB webhook cap is a magic number, not a policy
Hardcoded `1024*1024` twice (`src/index.ts:27,29`) and checked against `content-length`
*and* the encoded body. But retention of the raw body for debugging does not exist, and
the cap is not documented against GitHub's actual limit. F31.

### D16 — `classifyGithubEvent` produces an unbounded event-type string space
`return kind + '.' + action` is a combinatorial expansion (`issues` × every action).
Event types are the routing key, so the effective rule surface is unbounded and
unenumerable in a UI. Needs a closed catalog with documented passthrough. F30.

## 3. What is genuinely good here

Worth preserving so a rewrite does not regress it:

- **HMAC verification over the raw body** before `JSON.parse`, with a strict
  `^sha256=[a-f0-9]{64}$` shape guard *before* the constant-time compare. The shape guard
  is what makes the fixed-32-byte compare sound; that detail is easy to lose later.
- **Signature failure returns 401 with no body detail** — no oracle.
- **202 + `waitUntil` for prompt dispatch, cron for reconciliation.** Two-tier dispatch is
  the right shape; it only needs an atomic claim (D4).
- **Outbound allowlist** (https + hostname + path prefix + no userinfo + `redirect:'error'`)
  is materially stricter than the common default.
- **Encryption happens before D1**, not after. Never store a plaintext destination URL.
- **Replay protection keyed on `X-GitHub-Delivery`** via `INSERT OR IGNORE` — the right key,
  the right primitive; it just needs the gaps in D4/D10 closed.

## 4. Distance to a launchable V1

Ordered by the dependency chain, not by effort:

```text
D1  fix secret-name mismatch                        ─┐
D2  tenancy (workspace_id everywhere + authz)       ─┤
D6  envelope encryption with AAD + key version      ─┤
D7  hashed session tokens                           ─┤
     └─► Viable single-tenant-with-auth foundation  ─┘

D3  authorize by verified credential, not body field ─┐
D5  queue by id, not by secret                      ─┤
D8  Slack adapter + capability model                ─┤
D11 error classification + DLQ surfacing            ─┤
D13 integration tests on the real path               ─┤
     └─► Honest multi-tenant alpha                   ─┘

F27 GitHub App install  ·  F36 grouping/digest  ·  F72 write-time validation
F14 dashboard + setup wizard  ·  F109 retries  ·  F119 delivery log UI
     └─► V1 shippable                                 ─┘
```

## 5. Non-goals this audit implies

- Do not add a second source before tenancy exists. Every new source multiplies D2.
- Do not add destinations beyond the existing three before D8 (capability model) exists,
  or the renderer becomes a pile of special cases.
- Do not add AI, billing or a marketplace before the delivery ledger is trustworthy —
  each makes duplicates and silent drops user-visible.

## 6. How to verify this audit

| Claim | Check |
| --- | --- |
| D1 | `grep -rn ENCRYPTION_KEY` — `.dev.vars.example` vs `src/index.ts:4` |
| D2 | `grep -n "workspace_id" migrations/*.sql` → no matches |
| D4 | Read `dispatchOutbox`; note `send()` precedes the state `UPDATE` with no claim |
| D5 | `type Delivery = {...}` in `src/index.ts:5` contains `ciphertext` |
| D7 | `migrations/0004_identity.sql` — `auth_tokens` has no hash column |
| D8 | No file under `src/connectors/destinations/slack/` |
| D13 | `tests/` contains only `github.test.ts` and `lark.test.ts`, both pure unit |
| D14 | `.github/workflows/ci.yml` runs 2 npm scripts; `package.json` has no `lint`/`build` |