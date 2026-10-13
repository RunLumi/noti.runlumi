# ADR 0003: Adopt Better Auth, and pin the dependency graph exactly

Status: Accepted · Date: 2026-10-13 · Supersedes nothing

## Context

`AGENTS.md` requires TypeScript strictness, verified email before access, revocable
sessions, passkeys and rate limiting, while also requiring lean, Workers-compatible
dependencies. Hand-rolling all of that is exactly the code we should not own — session
handling and password storage are where subtle defects are most likely and least visible.

PR #2 adopted Better Auth. Two problems surfaced immediately and are addressed here.

## Decision

**1. Better Auth owns identity.** Users, sessions, accounts, organizations, members,
invitations, roles, passkeys and auth rate limiting are Better Auth's responsibility.
We keep a thin tenant-authorization layer (`organization_id` predicates on our own tables)
and delete the hand-rolled identity code.

**2. Pin the whole Better Auth family exactly.** All three packages must move together:

```
better-auth                      1.7.7
@better-auth/passkey             1.7.7
@better-auth/drizzle-adapter     1.7.7
```

No caret ranges across this family.

**3. Commit a lockfile and install with `npm ci`.** `npm install` re-resolves ranges, so a
green local build would not imply a green CI build.

**4. Our tenant-owned tables reuse Better Auth's `organization.id` directly.** No mapping
table, no sync job, no dual key.

## Why the exact pin, specifically

This was a live failure, not a style preference. `better-auth@1.6.33` declared a dependency
on `@better-auth/core@^1.6.33`. npm resolved that to 1.7.7, which peers
`@better-fetch/fetch@1.3.2` — while `@better-auth/passkey@1.6.33` peers
`@better-fetch/fetch@1.3.1`. `npm install` failed with `ERESOLVE`, and CI ran `npm install`.

**CI was therefore broken on `main`.** Aligning the three packages forward to 1.7.7 fixed it;
pinning exactly prevents the drift from recurring.

## Accepted consequences

| Consequence | Why it is acceptable |
| --- | --- |
| **Session tokens are stored in plaintext in D1** | Structural property of Better Auth — `token` is stored as issued and looked up by exact match, with no hashing option. A read-only D1 compromise yields usable session cookies. Mitigated by D1 encryption at rest, strict `session.token` redaction and retention. Recorded in `15-security-and-compliance.md`. |
| **Auth database cannot be sharded** | Better Auth accepts a single `database` instance. Application tables shard separately (`01` F06); the auth DB is small and low-write. |
| **D1 has no interactive transactions** | Affects password reset and membership changes. Design for partial-failure recovery rather than assuming atomicity. |
| **Heavy dependency** | Deliberate trade against `AGENTS.md`'s lean-dependency rule. Hand-rolled session and password code is a worse use of that budget. |

## Consequences we explicitly reject

- **Keeping `src/auth/crypto.ts`.** Deleted. PBKDF2 at a fixed work factor with no per-row
  algorithm record cannot be upgraded without a migration of every row at once.
- **Keeping `migrations/0004_identity.sql` tables as active.** They are superseded by
  `0005`. They cannot be dropped — `0004` has already been applied — so they are marked
  deprecated in place (`02` F31). Note `auth_tokens` has no hash column, so any future code
  reading it reads plaintext tokens; that is the reason for the marker.
- **Treating the organization plugin as tenant isolation.** It is a membership registry.
  Isolation is a predicate we write (`02` F24–F27).

## Security work this made necessary

| Control | Where |
| --- | --- |
| `BETTER_AUTH_SECRET` ≥32 chars asserted at construction | `src/auth/better-auth.ts` |
| `trustedOrigins: [APP_ORIGIN]` — exact origin, no suffix matching | `src/auth/better-auth.ts` |
| `ipAddressHeaders: ["cf-connecting-ip"]` — never the spoofable `x-forwarded-for` | `src/auth/better-auth.ts` |
| `rateLimit.storage: "database"` — the default per-isolate `Map` is ineffective on Workers | `src/auth/better-auth.ts` |
| Passkey `rpID`/`origin` server-derived from `APP_ORIGIN`, never client-supplied | `src/auth/better-auth.ts` |
| Worker bundle guard against the pure-JS scrypt fallback (non-constant-time comparison) | `scripts/verify_worker_bundle.mjs` |

## Verification

Run on 2026-10-13:

- `npm ci` resolves cleanly from the committed lockfile.
- `npm run check` — format, type-aware lint (22 files, 0 problems), Worker and web
  typecheck, 21 unit tests, web build, worker bundle guard — exits 0.
- Bundle inspection confirms zero `noble/hashes/scrypt` references and a present
  `timingSafeEqual`, i.e. the native `node:crypto` scrypt path resolved.

## Revisit when

- Better Auth 1.8+ ships, or the D1 concurrency fix for the Kysely adapter
  (better-auth#11490, merged 2026-10-10) reaches a release. We use the Drizzle adapter, so
  that fix likely does not apply — re-verify rather than assume.
- Session token hashing becomes configurable.
- `organizationLimit: 1` is relaxed (`02` F15).