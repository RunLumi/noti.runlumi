# ADR 0027: Platform gates: exactOptionalPropertyTypes, a coverage floor, an integration job, migration immutability

Status: Accepted · Date: 2026-10-14 · Implements most of slice 1.15 of
[`docs/specs/REMAINING.md`](../specs/REMAINING.md): F01, F02, F05 (in part). No migration. Behaviour-preserving source edits only, forced by the stricter compiler flag: `parseUpdateIntegration` no longer assigns a failed parse (already an error response) into its output object, and the Stripe mapper omits an absent status through `statusField` instead of writing `undefined`.

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
   branches 83.5, functions 85, lines 91, set under the measured 89.99, 84.11, 85.38, 91.58. Branches has half a point of margin
   (the first draft had 0.11, which a harmless refactor would trip). It is a floor, not a target; lowering a number is a
   reviewed change. **The floor is enforced in CI only** (`npm run test:coverage`); `npm run check` does not run coverage, to
   keep the local loop fast.
3. **A separate `integration` job** runs `npm run test:integration`, which is `tests/migration-0026-d1.test.ts`: the real
   `wrangler d1 migrations apply --local` over the whole chain from an empty database, then the 0026 finalize and recover
   scripts. No secrets, no network, no account. The file also still runs in `verify` (the coverage run needs every test);
   the job exists so the migration proof has its own red/green signal and can be required separately.
4. **Migration seal, one sidecar per migration** (`migrations/NNNN_name.sql.sha256`, `scripts/migration-seal.mjs`,
   `scripts/lib/migration-seal.mjs`). `npm run migrations:seal` writes the SHA-256 (CRLF-insensitive) of each migration that
   has no sidecar and never rewrites one; if any sealed file was edited or the chain is malformed it writes nothing and exits 1.
   `npm run migrations:check` fails on an edited, deleted, unsealed or duplicate-numbered migration, a bad sidecar, and any
   numbering gap not on the explicit allow-list (`ALLOWED_GAPS`: 0023, reserved and never used). Sidecars are disjoint files, so
   two PRs adding migrations cannot conflict; two that pick the same number fail after the merge.
   - **Base comparison** (`--base <ref>`, CI on pull requests): every migration the base has must be present with identical
     content (so it works even where the base has no sidecars), every base sidecar must be unchanged, and a new migration must
     be numbered above the base's highest. An unresolvable ref or any git failure exits 2, never "no base";
     `--require-base` also fails when the base has no sidecars (to be added to CI once main carries them).
   - The checker is tested as a real process in a throwaway git repository: missing ref, edit plus forged sidecar, add,
     delete, duplicate number, disjoint merge, seal refusing without writing.
   - 0026 is sealed at its current (non-destructive) content. That content has never run on a real D1.
5. **What this is and is not.** It is a check. It blocks a merge only if branch protection requires the `verify` and
   `integration` jobs, and a change to the workflow, the script or the sidecars can switch it off in the same PR. Nothing in the
   repository can enforce that, so `.github/CODEOWNERS` names the owners of `.github/`, `migrations/`, the seal scripts,
   `vitest.config.ts` and `tsconfig.json`, and the operator actions (required checks, required code-owner review) are listed as
   OPEN in [`RELEASE_GATES.md`](../RELEASE_GATES.md). They have not been done.

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
