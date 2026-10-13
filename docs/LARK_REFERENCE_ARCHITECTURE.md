# Lark architecture reference and adaptation

Reference: https://github.com/NCUHOME/FeishuGitPushBot (MIT; preserve attribution if copying code). Reviewed README, bot/feishu.go, bot/config.go, bot/worker.go on 2026-10-13.

## What to adopt

1. **Native Lark cards**: the reference uses card schema 2.0 with semantic colors, compact metadata and readable event summaries. Build a destination-specific card renderer; preserve actor, repository, branch, source URL, event outcome. Provide text fallback.
2. **Correlated notifications**: persist message IDs when using Lark App API; edit CI status cards and reply in PR/issue threads where permissions permit. Do not promise edits/replies for custom webhook destinations.
3. **Noise control**: bot-actor suppression, configurable merge windows for pushes/comments, and per-event filters. Never merge unrelated repositories, tenants, PRs, branches or workflow attempts.
4. **Delivery lifecycle**: durable inbox/outbox, idempotency, bounded retries, backoff, DLQ, correlation IDs and explicit delivery statuses.
5. **Capability modes**: (a) custom webhook URL with optional Lark signing secret for simple delivery; (b) Lark App credentials + chat ID for create/edit/reply/upload capabilities. Treat them as different credential types and user experiences.
6. **CI semantics**: normalize workflow run/job statuses, conclusions and attempts. Update an existing message only after resolving a stable entity key.
7. **Media**: optional avatar/image enrichment must be asynchronous, allowlisted, size-bounded and cached; avoid arbitrary remote URL fetches.

## What not to port

- Go/Gin HTTP listener, global singleton config, Bun/PostgreSQL assumptions, endless polling loops, synchronous image downloads, and blocking sleeps.
- Global Lark credentials; every destination belongs to an authorized workspace.
- A single global GitHub webhook secret for unrelated customers as the final multi-tenant design.
- The reference README documents FEISHU_WEBHOOK and FEISHU_SECRET, but inspected config and send path use Lark App API credentials. Do not assume custom webhook support is implemented there.

## Cloudflare design

Hono Worker -> signed webhook validation -> durable D1 inbox/outbox -> Queue dispatcher -> provider adapter (Lark webhook or Lark App) -> delivery ledger. Scheduled reconciliation recovers pending outbox entries after enqueue failure. All rows scoped to workspace and authorized source installation. Secrets encrypted per destination with key rotation. Queue consumers must classify transient vs permanent errors and honor provider throttling.

Suggested modules:
- src/connectors/sources/github/{verify,normalize,fixtures}.ts
- src/connectors/destinations/lark/{webhook,app,sign,card,capabilities}.ts
- src/core/{event,filter,route,outbox,delivery}.ts
- src/db/{schema,queries}.ts
- tests/{fixtures,unit,integration,e2e}

## Build order and gates

P0: Fix inbox/outbox atomicity, webhook verification, per-installation authorization and secret handling. Test duplicate webhook, queue outage and tenant isolation.
P1: Implement custom Lark webhook + optional signing secret, deterministic card V2 renderer, strict response parsing and fixture tests.
P2: Implement Lark App mode with message ID persistence, CI edits, thread replies, OAuth/scopes review and real-provider E2E.
P3: Add event aggregation and image caching only after metrics show notification noise or card usefulness merits complexity.

Do not merge the existing draft PR as production-ready: its current implementation lacks tests, a safe onboarding flow, Lark signing and atomic queue handoff. Acceptance requires a real GitHub -> Workers -> D1/Queue -> Lark demonstration, failure injection, redacted logs and rollback verification.
