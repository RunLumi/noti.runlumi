# Lumi Noti

**Connect what happens to the people who need to know.**

Noti is a standalone, Cloudflare-native notification routing product in the Lumi ecosystem. Connect events from many systems to Lark, Slack, Microsoft Teams and other destinations without writing code. Noti is **not** a general-purpose workflow automation engine.

## Product promise
- Configure a source, choose events, add filters, choose destinations and preview the message in minutes.
- Each workspace can manage many independent integrations, each with its own credentials, routing rules, formats and delivery history.
- Every notification is traceable, secure, retryable and understandable by non-engineers.
- Standalone first: a customer never needs another Lumi product.

## Current status
**Foundation/specification only.** No working integration or production deployment is claimed. See [roadmap](docs/ROADMAP.md), [architecture](docs/ARCHITECTURE.md), and [agent instructions](AGENTS.md).

## Initial wedge
GitHub events → Lark, Slack, Teams. Start with GitHub issue/PR/comment/merge/workflow events, destination-specific card previews, per-event filters, test delivery and logs. Extend to generic inbound webhooks next. Prefer a verified end-to-end path over a broad catalog of mock connectors.

## Technology
TypeScript, Hono, React + Vite, Cloudflare Workers, D1, Queues, Vitest, Playwright. Pin versions after checking current Cloudflare compatibility. Use Workers secrets and application-layer encryption for tenant webhook credentials. No Docker or long-running server required.

## Development
1. Read AGENTS.md and docs/ROADMAP.md.
2. Scaffold the app and run local Workers/D1/Queues emulation using Wrangler.
3. Build one real signed GitHub webhook → normalized event → persisted delivery → Lark notification path, then Slack and Teams.
4. Validate with tests and actual provider sandbox webhooks before claiming a connector works.

## License
No license has been selected yet. Do not assume this repository is open source until the owner adds one.
