# ADR 0037: Automatic main deployment after CI

Status: Proposed

## Context

The first Worker deployment was performed locally. The owner requested automatic deployment from main.
The deployment IDs and public key check value must be recorded in Git; runtime secrets already exist
on Cloudflare, while a dedicated CI deployment credential still needs provisioning.

## Decision

Use the existing GitHub CI workflow's production job, gated on both `verify` and `integration`.
Only pushes or explicit reruns on `main` can reach the GitHub `production` environment. That environment
permits only `main`. The owner requested automatic deployment, so no per-run reviewer is required.

A dedicated account/zone-scoped Cloudflare deployment token is an environment secret, exposed only to
the final deploy step. Existing Worker application secrets stay on Cloudflare. Do not export a local
Wrangler OAuth session to GitHub. The available session cannot configure Cloudflare Workers Builds
(403), so that integration is not the activation path for this change. Cloudflare's GitHub Actions
documentation currently describes API-token authentication; this ADR makes no OIDC support claim.

Install without dependency lifecycle scripts. Build through Vite and verify the generated Worker,
including native scrypt selection. Serialize uploads and skip a revision that is no longer main after
its build. Read the production D1 migration ledger before upload and refuse pending migrations. Schema
changes, backup-table finalization and secret rotation remain reviewed operator procedures. Tag the
Worker version with its source SHA and require the existing health/readiness smoke check after upload.

## Consequences

The deploy step builds again after the check jobs; it does not trust a PR artifact or deploy code from a
fork. Older revisions can be skipped when main moves, and GitHub concurrency may supersede a pending
job. A newer main will run its own checks. This favors a recent checked deployment over uploading every
intermediate commit.

A smoke failure reports failure after upload; it does not automatically roll back, since database
compatibility needs an operator decision. Missing credentials or unapplied migrations fail before
upload. Rerun the workflow on main after fixing the prerequisite. The environment secret is required
for activation; configuration/tests alone are not hosted deployment evidence.

## Verification

Focused tests cover the read-only migration query, pending migrations, incomplete API responses,
redacted failures and the workflow's branch/credential boundary. The read-only guard was exercised
against the live deployment database and found all 28 migrations applied. Full CI and the first
credentialed hosted deployment must be read back before marking automatic deployment verified.

See [DEPLOYMENT.md](../DEPLOYMENT.md) for setup and operating procedures.

## Revisit when

A staging environment, credential federation, automatic backward-compatible migrations or native
Cloudflare Builds is verified and selected. Any change to the main-only credential boundary requires review.
