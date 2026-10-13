# Running slice

This is an engineering alpha, not a production-ready multi-tenant product. It receives signed GitHub repository webhooks and routes configured events to Slack or unsigned Lark custom webhooks.

## Setup
1. npm install; npm run typecheck; npm test
2. Create D1 database: `npx wrangler d1 create lumi-noti`, replace ID in wrangler.jsonc.
3. Create queues: `npx wrangler queues create noti-deliveries` and `npx wrangler queues create noti-dead-letters`.
4. Apply schema: `npx wrangler d1 migrations apply lumi-noti --remote`.
5. Set secrets: `wrangler secret put GITHUB_WEBHOOK_SECRET`, `wrangler secret put KEK_V1` (`openssl rand -hex 32`), and — only if you have pre-envelope (v0) rows — `wrangler secret put ENCRYPTION_KEY`. `KMS_ACTIVE_VERSION` is a var in `wrangler.jsonc`. `GET /health` returns 503 and names the binding if the key ring is invalid.
6. Integrations are created through the tenant-scoped API (slice 3, not yet shipped). Legacy v0 rows are re-sealed automatically by the cron job; see ADR 0004.
7. Deploy with `npm run deploy`; configure GitHub repository webhook for `/webhooks/github`, content type JSON, shared signing secret.

## Explicit gaps before public release
- No authenticated dashboard, workspace model, GitHub App installation verification, or safe credential onboarding yet. Do not accept arbitrary public users.
- Queue insertion and D1 idempotency claim are not atomic; failed enqueue after claim requires a reconciliation job/outbox.
- No real-provider E2E test or deploy has been performed. Validate Slack and Lark response contracts, retry/DLQ behavior and credential encryption before production.
- Use real GitHub event fixtures (F71).

## Key rotation (KEK)

Who may run it: a workspace-platform operator holding Cloudflare `Workers Scripts:Edit` on
the account. Rehearse it in staging first, including a rollback at every step.

1. Generate the new key: `openssl rand -hex 32`. Then `wrangler secret put KEK_V2`. Deploy with
   `KMS_ACTIVE_VERSION` still `"1"`. Rollback: delete `KEK_V2`.
2. Set `KMS_ACTIVE_VERSION` to `"2"` and deploy. New connections wrap under v2, and each cron
   tick rewraps up to 25 old DEKs. Rollback: set it back to `"1"`. Rows already on v2 keep
   working, because v2 is still configured.
3. Verify zero rows remain on the old version:
   `wrangler d1 execute lumi-noti --remote --command "SELECT COUNT(*) FROM integrations WHERE kek_version=1"`.
   Also check that no rows are quarantined:
   `... "SELECT id, credentials_quarantine_reason FROM integrations WHERE credentials_quarantined_at IS NOT NULL"`.
4. Only once step 3 shows zero: `wrangler secret delete KEK_V1`. This is irreversible. Any row
   still on v1 becomes undeliverable, and you will see `unknown_kek_version`.

The next rotation reuses the free slot: write `KEK_V1` again and set it active.

## Retiring the legacy v0 key

After the envelope release deploys, each cron tick re-seals up to 25 v0 rows. Every tick logs
`{"job":"credential_maintenance", ..., "remaining":{"legacyRemaining":N,...}}`.

1. Wait for `legacyRemaining` to reach 0 and `quarantined` to be 0. If the cron run fails with
   `CredentialJobAborted`, the legacy key or KEK configuration is wrong; `GET /health` names the
   binding. No rows are quarantined in that case.
2. Keep the v0 columns until you are sure you will not roll back past this release. Then
   clear them (this is the contract step):
   `wrangler d1 execute lumi-noti --remote --command "UPDATE integrations SET webhook_ciphertext='', lark_secret_ciphertext=NULL WHERE webhook_envelope IS NOT NULL"`.
3. `wrangler secret delete ENCRYPTION_KEY`.

## Quarantined credentials

A row is quarantined only when its own ciphertext will not open. Common causes are a row
edited by hand or a ciphertext copied from another row. It stops delivering until fixed. Once
slice 3 ships, the fix is to re-enter the destination in the dashboard, which writes fresh key
material and clears the quarantine. Before that, an operator can reset the flag after
correcting the row:
`UPDATE integrations SET credentials_quarantined_at=NULL, credentials_quarantine_reason=NULL WHERE id='<id>' AND organization_id='<org>'`.
