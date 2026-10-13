# Running slice

This is an engineering alpha, not a production-ready multi-tenant product. It receives signed GitHub repository webhooks and routes configured events to Slack or unsigned Lark custom webhooks.

## Setup
1. npm install; npm run typecheck; npm test
2. Create D1 database: `npx wrangler d1 create lumi-noti`, replace ID in wrangler.jsonc.
3. Create queues: `npx wrangler queues create noti-deliveries` and `npx wrangler queues create noti-dead-letters`.
4. Apply schema: `npx wrangler d1 migrations apply lumi-noti --remote`.
5. Set secrets using `wrangler secret put GITHUB_WEBHOOK_SECRET` and `wrangler secret put ENCRYPTION_KEY` (64 hexadecimal characters).
6. Insert an integration record into D1 with AES-256-GCM encrypted webhook URL (base64 of 12-byte random IV followed by ciphertext+tag); set event_types to JSON array such as `["issues.opened","pull_request.merged"]`.
7. Deploy with `npm run deploy`; configure GitHub repository webhook for `/webhooks/github`, content type JSON, shared signing secret.

## Explicit gaps before public release
- No authenticated dashboard, workspace model, GitHub App installation verification, or safe credential onboarding yet. Do not accept arbitrary public users.
- Queue insertion and D1 idempotency claim are not atomic; failed enqueue after claim requires a reconciliation job/outbox.
- Lark signing secret is not yet supported. Use only Lark custom bots without signature verification enabled.
- No real-provider E2E test or deploy has been performed. Validate Slack and Lark response contracts, retry/DLQ behavior and credential encryption before production.
- Tighten signature comparison to constant-time and use real GitHub event fixtures.
