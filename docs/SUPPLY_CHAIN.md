# Supply chain policy

Spec 15 F239. What the repository does about third-party code, what it checks in CI, and what it does not yet do. Written
2026-10-15 from the repository; nothing here is an audit.

## Gates in CI (`.github/workflows/ci.yml`)

| Control | Where | Notes |
| --- | --- | --- |
| Committed lockfile, `npm ci` only | every job | never `npm install` |
| No lifecycle scripts on install | `npm ci --ignore-scripts` in every job | see "Install scripts" |
| Production advisories at high or critical | `npm run audit:gate` | dated exceptions in `scripts/audit-gate.mjs`, list empty |
| Registry signatures and provenance | `npm audit signatures` | see below |
| Actions pinned to a commit SHA, read-only token, no `pull_request_target` | `tests/security/config-guards.test.ts` | Dependabot proposes bumps |
| Dependency review on PRs | `dependency-review` job | skipped until `DEPENDENCY_REVIEW` is `true`; non-blocking |
| Scrypt fallback absent from the deployed bundle | `npm run verify:worker-bundle` | |

## `npm audit signatures`

Verifies the registry signature of every installed package and, where one is published, its sigstore provenance
attestation. It reads the registry, so it needs network and fails if the registry is unreachable; it is therefore a CI step,
not part of `npm run check` (which must work offline).

Run on npm 10.9.2 against the committed lockfile on 2026-10-15: 407 packages with verified registry signatures, 210 with
verified attestations. The other 197 have no attestation published; that is normal and is **not** a failure. A failing
signature, or a package that previously had an attestation and no longer does, is investigated before the job is
re-run; do not add a bypass.

## Install scripts

`package-lock.json` marks five installed packages with `hasInstallScript` (checked 2026-10-15):

| Package | Scope | What its script is for | Needed here? |
| --- | --- | --- | --- |
| `esbuild` (0.28.2, plus 0.18.20 and 0.25.12 nested under drizzle-kit) | build and dev tools | verifies or selects the platform binary | No: the platform binary arrives as its own optional package |
| `workerd` 1.20261006.1 | dev (local runtime for tests and wrangler) | validates the platform binary | No: same mechanism |
| `fsevents` 2.3.3 | optional, macOS only | builds a native watcher | No: only a file-watching optimisation |

Evidence that none is required: with `npm ci --ignore-scripts` the full unit suite (179 files, 4,450 tests), `npm run
build:web` and `npm run test:integration` (real `wrangler d1 migrations apply --local`) all pass. That was run on macOS
(arm64), Node 22 on 2026-10-15; the Linux CI runner is expected to behave the same and CI now proves it on every push.

Policy:

1. CI installs with `--ignore-scripts`. A `.npmrc` with `ignore-scripts=true` is deliberately **not** used: it would also
   skip `predeploy` and other `pre`/`post` scripts of our own `npm run` commands.
2. A dependency that needs a lifecycle script to work is added to the table above with a reason, in the PR that adds it. The
   reviewer treats it like any dependency that touches secrets or egress: it runs on a developer machine with that
   person's credentials.
3. Developers installing locally should use `npm ci --ignore-scripts` too. The release job (`npm run deploy`) must run
   from a tree installed that way.
4. Adding a dependency that handles credentials, payloads, signing or egress needs a note in the ADR for the change. Cryptography uses Web Crypto, not a library.

## Deploy credentials and OIDC

**UNVERIFIED:** whether Cloudflare Workers deployment accepts GitHub OIDC federation so that no long-lived Cloudflare API
token exists. It has not been checked against Cloudflare's documentation in this repository, so nothing here promises it.

Until verified, the fallback applies, and these are decisions for the owner that this repository does not change:

- Deploy is run by an operator with `npm run deploy` (nothing in CI deploys today, and no deploy secret is referenced by any workflow).
- If a CI deploy is added later: a token scoped to Workers deploy for this one account, stored as a secret of a protected
  environment with required reviewers, available to `main` only, never to fork pull requests, rotated on suspicion and on
  the departure of anyone who held it. Record its scope in `docs/SECURITY.md`.
- Before relying on OIDC: read Cloudflare's current CI/CD and API token documentation, record the URL and date here, and try it on staging first.

## What is not done

- A pinned `wrangler` exact version (the range is `^4.149.0`; the lockfile pins what is installed). Migrations are sealed by
  hash (ADR 0027), which limits the effect of a drift.
- A triage window for an advisory with no fix; today it lands in the risk register by hand.
- Required status checks: branch protection is a repository setting this change does not touch (docs/RELEASE_GATES.md).
