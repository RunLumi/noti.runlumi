# Evidence-led roadmap

## P0 — Foundation
- [ ] Scaffold TypeScript/Hono Worker and React/Vite dashboard; add strict types, lint/format/test/build.
- [ ] D1 migrations, workspace isolation, credential encryption, webhook verification, queue/outbox and delivery logs.
- [ ] Provider fixture tests, CI, staging deployment and operational runbook.

## P1 — First real delivery
- [ ] GitHub webhook -> Lark custom bot card, end to end.
- [ ] Per-integration issue/PR/comment/merge/workflow selection, preview, test, retries and logs.
- [ ] Slack incoming webhook destination, tested with real workspace.
- [ ] Microsoft Teams supported workflow/webhook destination, tested with real tenant.
- [ ] 10 unassisted setup tests; fix top friction before adding connectors.

## P2 — Make it effortless
- [ ] GitHub App install and repository selector.
- [ ] Generic inbound signed webhooks and mapping wizard.
- [ ] Routing templates, branch/actor/status filters, notification grouping and digest.
- [ ] Self-service recovery, onboarding, accessibility and localization.

## P3 — Expand by demand
- [ ] GitLab, Sentry, Stripe, Cloudflare; then Discord/Telegram/email.
- [ ] Optional opt-in AI summaries and noise reduction with source provenance, cost limits and deterministic fallback.
- [ ] SSO, advanced RBAC, audit export, enterprise retention, usage-based billing if validated.

## Stop/continue gates
Proceed from P1 only if a real signed webhook reliably reaches a real destination and at least 8/10 target users can set it up without engineering help. Otherwise improve onboarding/reliability instead of expanding catalog.
