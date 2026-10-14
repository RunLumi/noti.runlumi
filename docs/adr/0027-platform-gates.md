# ADR 0027: Platform gates: exactOptionalPropertyTypes, a coverage floor, an integration job, migration immutability

Status: Accepted · Date: 2026-10-14 · Implements most of slice 1.15 of
[`docs/specs/REMAINING.md`](../specs/REMAINING.md): F01, F02, F05 (in part). No migration, no runtime change.

## Context

CI was green but proved less than spec 01 asks: `exactOptionalPropertyTypes` was off, no coverage number was measured or
protected, the real-wrangler migration run lived inside the one unit job, and nothing stopped an edit to a migration that
had already merged (ADR 0021 A4 edited 0026 in place because it had never run anywhere; that was a judgement call that
should be visible, not a habit).

## Decisions

1. **`exactOptionalPropertyTypes` is on in the root `tsconfig.json`** (worker and tests). Twenty-seven errors surfaced; each
   was fixed at the source rather than by widening types: parse results that return `undefined` after pushing a field error
   are no longer written into the update object, the two optional-with-`undefined` option shapes (`retryAfterMs`,
   `pathPrefix`) now say so, the GitLab status tables are `NonNullable`, Stripe omits an absent status, and test helpers pass
   `null` instead of `undefined` as a request body. `web/tsconfig.json` is unchanged; it also checks clean with the flag, but
   the flag is not enabled there.
2. **A coverage floor** in `vitest.config.ts` (`v8`, `src/` and `web/src/`, generated route tree excluded): statements 89,
   branches 84, functions 85, lines 91, set a little under the measured 89.99, 84.11, 85.38, 91.58. It is a floor, not a
   target; lowering a number is a reviewed change. CI runs `npm run test:coverage` in place of `npm test`.
3. **A separate `integration` job** runs `npm run test:integration`, which is `tests/migration-0026-d1.test.ts`: the real
   `wrangler d1 migrations apply --local` over the whole chain from an empty database, then the 0026 finalize and recover
   scripts. No secrets, no network, no account. The file also still runs in `verify` (the coverage run needs every test);
   the job exists so the migration proof has its own red/green signal and can be required separately.
4. **Migration immutability** (`migrations.sealed.json`, `scripts/migration-seal.mjs`, `scripts/lib/migration-seal.mjs`).
   The manifest holds the SHA-256 of every migration (CRLF-insensitive). `npm run migrations:check` fails on an edited,
   deleted or unsealed migration and on non-increasing numbering (gaps are allowed: 0023 is intentionally absent). On a pull
   request CI also passes `--base origin/<base>`, which reads the base branch's manifest and fails if any entry was removed or
   its hash changed, so editing a file and its hash together does not pass. `npm run migrations:seal` adds hashes for new
   files only and refuses to re-hash an edited one. The manifest is one entry per line, sorted, so two PRs that add
   migrations conflict only on adjacent lines.
   - 0026 is sealed at its current (non-destructive) content. That content has never run on a real D1.

## Not done

- `PRAGMA defer_foreign_keys` review per migration, and a rollback rehearsal on a real D1 (staging does not exist).
- A script named `build` (it is `build:web`); `exactOptionalPropertyTypes` for the web project.
- Marking `verify` and `integration` as required checks is a repository setting nobody here can see.
- Local D1 does not emulate overload or queue concurrency; the integration job does not claim to.

## Verification

Unit tests for the seal (`tests/platform/migration-seal.test.ts`: edit, delete, unsealed, numbering, CRLF, base forgery, and
the real chain) and for the gate configuration (`tests/platform/gates.test.ts`). Confirmed by hand that editing
`0001_init.sql` makes `migrations:check` exit 1 and restoring it exits 0. A deliberately red PR for each CI gate has **not**
been run (spec F02 asks for that once), and the new workflow job has not run on the CI host yet.
