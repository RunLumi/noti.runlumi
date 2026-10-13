# Agent operating contract — Lumi Noti

## Mission
Build a globally competitive, simple, trustworthy, standalone notification router under the Lumi brand. Optimize for a nontechnical user connecting systems in minutes, not for the number of integrations shown on a landing page. No AI slop, fake screenshots, unsupported claims or placeholder connectors advertised as working.

## Product boundaries
- Sources: GitHub first; then generic signed webhooks, GitLab, Stripe, Sentry, Cloudflare and other high-demand sources based on evidence.
- Destinations: Lark, Slack, Microsoft Teams first; add Discord, Telegram and email only when demand justifies.
- Formats: plain text, markdown where supported, and native destination cards/adaptive cards. Maintain source links and actor/context metadata.
- Many workspaces, many integrations per workspace, many destinations per integration; tenant isolation is mandatory.
- Not a Zapier clone: no arbitrary code execution, bidirectional sync, or unrestricted workflow graphs in V1.
- AI is optional and later: explain/filter/summarize noisy events with human-visible provenance, explicit opt-in, budget controls and deterministic fallback. Never silently fabricate event facts.

## Design and brand contract
- Read `DESIGN.md` before changing any UI. It is the authoritative visual system: exact Lumi colors, warm Paper White canvas, opaque evidence sheets, Civic Navy headings, self-hosted Geist, Tabler Outline icons, spacing and geometry.
- Use the original logo assets in `brand/`. Import SVGs into the Vite app so builds fingerprint and bundle them; do not redraw, recolor, stretch or substitute a generic icon for the Lumi mark. Use a light-compatible variant on paper/white and the white variant only on navy.
- Adapt the landing-oriented design document to this notification product. Its company/product narrative and email CTA are not requirements for the authenticated app; preserve Noti's actual workflows and honest prototype/planned labels.
- Keep glass in navigation controls only, with opaque, reduced-transparency and forced-color fallbacks. Reading surfaces stay opaque. Prefer no glass when it adds no useful hierarchy.
- Validate desktop and 320px mobile reflow, keyboard focus, contrast, reduced motion and Vietnamese diacritics. Keep body text at least 16px, metadata at least 12px and controls at least 44px tall.
- UI changes must document their design decisions and verification in `docs/adr/` and `docs/FRONTEND.md`. Never invent live metrics or provider acceptance evidence to make a screen look complete.

## Before coding
1. Inspect existing code, tests, docs, CI, Cloudflare platform limits and provider API docs; don't overwrite working code without reason.
2. Pick the smallest vertical slice that produces real user value; document assumptions and acceptance criteria.
3. Use official API documentation and test actual provider payloads. Do not invent webhook shapes, permissions, OAuth scopes or pricing.
4. Record material decisions in docs/adr/ and update docs when behavior changes.

## Engineering invariants
- TypeScript strict; explicit schemas at trust boundaries; validate raw request size and content type.
- Verify webhook signatures against raw bytes, use constant-time comparison where applicable, enforce timestamp/replay controls when provider supports them.
- GitHub App installation or authenticated repository webhook ownership must authorize every event route; never route private events to unauthorized tenants.
- Encrypt per-tenant destination secrets at rest; never print tokens, secrets, full sensitive payloads or webhook URLs in logs. Rotate/revoke credentials.
- Block SSRF: restrict outbound destinations to documented provider domains or explicitly approved verified endpoints, disallow unsafe redirects and private-network targets.
- Queue deliveries; persist stable idempotency keys; bound retries with exponential backoff/jitter, dead-letter inspection and manual redelivery. Acknowledge GitHub only after durable acceptance.
- At-least-once processing means exactly-once delivery cannot be promised; expose possible duplicates and dedupe where feasible.
- Isolate tenant records in every database query and authorization path; enforce least privilege, CSRF protections and rate limits.
- Destination capabilities vary. Use capability-aware renderers and honest fallbacks, not a fake universal rich-card schema.
- Respect Teams, Slack and Lark authentication, webhook retirement/deprecation, rate limits and platform-specific formatting policies.
- Accessibility: keyboard navigation, WCAG 2.2 AA targets, readable contrast, responsive mobile UX, clear errors and translated-ready strings.
- Observability: correlation IDs, delivery status, retries, latency and redacted error categories; configurable retention and data deletion.

## Implementation workflow
- Make changes in coherent small units; add tests with every behavioral change.
- Unit-test parsing, routing, filters, rendering, signing, deduplication, authorization and error classification.
- Integration-test Workers/D1/Queues and fixture-based provider payloads. E2E-test create → test → deliver → inspect → retry.
- Run format, lint, typecheck, unit, integration and build before merging. If a check cannot run, report it plainly.
- No fabricated benchmarks, security audits, customer evidence or test results.
- No destructive schema changes without migration/rollback strategy.
- Keep dependencies lean and Cloudflare Workers compatible. No Node-only or long-running runtime assumptions.

## Definition of done for a connector
Verified authentication and permissions; schema-validated representative events; deterministic normalized mapping; native destination rendering and fallback; retry/rate-limit policy; redacted logs; unit and integration tests; working test notification; setup and troubleshooting docs; real-provider acceptance evidence.

## Release rule
Don't describe a feature as production-ready until it has passed real-provider end-to-end validation, tenant isolation and secret-handling review, and a rollback rehearsal.
