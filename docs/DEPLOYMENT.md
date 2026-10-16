# Cloudflare deployment — 2026-10-16

## Live deployment

- URL: https://noti.runlumi.app
- Worker: `lumi-noti`, RunLumi account `73fe06de8746378768229a64680dd62f`.
- Source: `main` at `7f1294143df1e58f5824bc9d88e39a379b5a6ffb`, with the local deployment values in `wrangler.jsonc`.
- Worker version: `4a8a4221-ee29-4864-8334-ad768651bacd`.
- D1: `lumi-noti`, `3dd3fc34-06d0-453d-9e64-a0314aef73af`, initially empty; migrations through 0029 applied.
- Queues: `noti-deliveries` and `noti-dead-letters`; both consumers attached. Cron: every minute.
- Custom domain is enabled and mapped to this Worker; `workers.dev` remains disabled.
- Cloudflare Email Sending reports `runlumi.app` enabled. No authentication email was sent as part of this deployment.

Three independently generated secrets were installed as Worker secrets: `BETTER_AUTH_SECRET`, `KEK_V1`,
and `FINGERPRINT_KEY`. Their values were never printed or committed. The mode-0600 temporary upload file
was removed after Cloudflare confirmed the writes. Cloudflare retains the secrets; no separate key backup
is claimed. `KEK_CHECK_V1` is a public HKDF check value, not the key.

## Verification

- Full `npm run check`: formatting, lint, both type checks, 4,643 tests, web build and Worker-bundle guards passed.
- Schema check and migration seal check passed.
- After setting deployment IDs, nine deployment-guard tests and 35 local workerd migration integration tests passed.
- A separate remote D1 rehearsal applied migrations through 0025, loaded the repository's synthetic legacy
  fixtures, applied the remaining migrations and reconciled retained originals. The six tables were restored,
  preflight identified exactly 13 synthetic orphan rows, and contract reapplication, reconciliation and finalize
  succeeded. The disposable rehearsal database was removed afterwards. This does not prove production-size performance, Time Travel restore or queue pause semantics.
- `npm run smoke` against the custom domain passed: `/health` and `/health/ready` return 200; configuration,
  D1 and queue checks are true.
- `/signin` returns 200 with CSP, HSTS and `nosniff`; its fingerprinted stylesheet returns 200 with immutable
  cache headers and CSP. `/api/workspace/me` returns 401 without a session; `/api/auth/get-session` returns
  200 with `null`; `/x.js` returns 404.
- The first deployment smoke failed during local negative DNS caching. Public DNS and HTTPS with explicit
  resolution worked; normal local DNS subsequently resolved and the unmodified smoke command passed.

## Retained limits and operating notes

- GitHub App `lumi-noti` is registered under RunLumi (2026-10-16). Its public identifiers are recorded in
  `wrangler.jsonc` and its client/webhook secrets are stored on the Worker. See `GITHUB_APP.md` for the
  verified permissions, pending private-key/installation step and remaining provider acceptance checks.
- `GENERIC_WEBHOOK_ENABLED=false` is retained.
- Readiness warns `migration_0026_old_tables_present`. Automatic approval review rejected production
  finalization because it irreversibly drops tables. The six retained originals and `_snapshot_0026` remain;
  this warning does not fail readiness. Do not rerun finalization without explicit approval of the cleanup
  and recovery posture.
- Wrangler's remote `d1 execute --file` uses the import path and returns import statistics rather than the
  SELECT result rows required by the 0026 tooling. Remote rehearsal reconciliation used D1's query API
  with the exported finalize/recovery functions. Do not interpret import statistics as a passing preflight.
- The cron trigger is attached, but the first scheduled job run was not yet observed during the initial checks.
- Provider delivery, actual email delivery, signed-in browser flows, Time Travel restoration and Worker
  rollback have not been rehearsed. This is a live engineering deployment, not a production-readiness claim.

## Redeploy

Keep these public deployment values and the existing Worker secrets. Never regenerate the KEK for a
routine redeploy. Run `npm ci --ignore-scripts`, the checks, and `npm run deploy`. The deploy command builds
through Vite, validates the generated Worker bundle, deploys `web/dist/server/wrangler.json`, and runs smoke
checks. A bare root `wrangler deploy` does not build the Vite virtual modules. Inspect readiness warnings
separately from its HTTP status. See `RUNBOOK.md` for rollback and migration procedures.


## Automatic deployment from main

The `CI` workflow includes `Deploy production`, gated on the full `verify` and `integration` jobs.
It runs after pushes to `main`, or a manual workflow dispatch on `main`. GitHub's `production` environment
is restricted to that branch. Actions are pinned and the GitHub token remains read-only. Superseded main
revisions are skipped; deployments share one concurrency group and an in-progress upload is not cancelled.

Activation requires a dedicated Cloudflare API token stored as the environment secret
`CLOUDFLARE_API_TOKEN`, at:
https://github.com/RunLumi/noti.runlumi/settings/environments/24450122813/edit

Use the Cloudflare **Edit Cloudflare Workers** token template, restrict account resources to RunLumi
and zone resources to `runlumi.app`, and include Queues edit permission (the Worker has two consumers)
and D1 read permission for the migration-ledger query. Follow Cloudflare's current token permission UI;
if the read-only ledger query is denied, the job fails before upload. Do not grant broader access as a
workaround without reviewing the failed permission. Do not paste the token into a commit, issue or chat.
No KEK, auth signing key, destination credential or GitHub App secret belongs in the Actions environment.

The workflow installs with lifecycle scripts disabled, builds and verifies the Worker, checks that its
commit is still main, reads the D1 migration ledger without modifying it, deploys the built Vite config
with the commit SHA as its version tag, and runs the existing health/readiness smoke check.

Schema changes stay operator-managed. A new migration makes automatic deployment fail until the migration
is reviewed, rehearsed and applied using the runbook. The job never drops migration backups or changes
application secrets. After fixing a failed prerequisite, rerun CI or use **Actions → CI → Run workflow**
on `main`; the checks run again before deployment. A post-upload smoke failure leaves the new version
active and marks the job failed: inspect health and use the reviewed rollback procedure rather than
blindly retrying or automatically rolling back across schema changes.

Initial activation remains unverified until the environment secret is installed and a hosted production
deployment succeeds. The application remains an engineering deployment with the limits listed above.
