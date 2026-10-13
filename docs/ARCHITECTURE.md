# Architecture (proposed, not yet implemented)

```text
Provider webhook / GitHub App
        |
 Cloudflare Worker (Hono)
  verify raw signature + authorization + replay/idempotency
        |
 D1: event receipt + route/delivery records
        |
 Cloudflare Queue (outbox publisher or recovery scheduled job)
        |
 Queue consumer: rules -> per-destination renderer -> HTTPS delivery
        |
 Lark / Slack / Microsoft Teams
        |
 D1 delivery attempts + redacted observability
```

## Stack
- TypeScript strict monorepo, Hono API, React/Vite dashboard.
- Workers runtime, D1 for tenants/integrations/delivery state, Queues for fan-out and retry, R2 only if large payload retention is justified.
- Cloudflare Workers secrets for encryption key material; encrypt tenant credentials before D1 storage. Rotation and versioning required.
- Wrangler for local/dev/staging/prod, migrations in source control, environment separation.

## Reliability caveat
D1 writes and Queue publish are not a single atomic transaction. Design a durable outbox in D1 plus a scheduled reconciler to publish unqueued receipts; make queue consumers idempotent. Use uniqueness constraints for provider delivery ID scoped by installation/source and destination. Retry on transient errors, honor Retry-After, dead-letter permanent failures, allow authorized redelivery.

## Suggested entities
workspaces, memberships, users, sources, destinations, integrations, event_receipts, outbox, delivery_attempts, audit_events, secret_versions. Every tenant-owned record has workspace_id and authorization checks.

## Connector contract
Source adapter: verify(request, credential), parse(raw), normalize(event) to versioned canonical event. Destination adapter: validateConfig, capabilities, render(canonical event, template), send, classifyError. Filters operate on normalized typed fields, not arbitrary evaluated scripts. Record adapter versions for replay/debugging.

## Security decisions pending validation
GitHub App installation scopes; Microsoft Teams Workflows/webhook lifecycle and Adaptive Card constraints; Slack incoming webhooks versus app permissions; Lark custom bot signing algorithm; provider rate limits; data residency, retention and billing requirements. Verify against official docs before implementing.

## Deployment environments
Local (Wrangler), staging (separate resources/secrets), production (separate resources/secrets). Never use production secrets in local fixtures. Add CI gates and deploy with protected environments.
