# Agent operating contract — Lumi Noti

## Mission
Build a globally competitive, simple, trustworthy, standalone notification router under the Lumi brand. Optimize for a nontechnical user connecting systems in minutes, not for the number of integrations shown on a landing page. No AI slop, fake screenshots, unsupported claims or placeholder connectors advertised as working.

## Ambition with evidence

**Aim higher at verified user outcomes, not at uncontrolled scope.** For non-trivial work, apply these lenses inside the existing task/PR; small fixes stay small.

- **Altitude — outcome before tactic.** Name the user's intended result, acceptance evidence, constraints and stop condition. Challenge a weak requested approach with a better bounded alternative; do not silently replace approved scope.
- **Depth — professional methods, not expert-sounding prose.** Inspect source code, representative raw payloads and redacted runtime evidence. Reproduce the problem, test the root cause and use a measured baseline. Treat a stretch target as a hypothesis for a bounded experiment, never as an achieved result.
- **Range — borrow techniques, not personas.** Apply the adjacent discipline that could expose the failure: distributed-systems fault injection, security threat modeling, or nontechnical onboarding observation. Do the actual check; do not add agents, dependencies or infrastructure merely to look ambitious.
- **Speed — shorten the verified feedback loop.** Deliver the smallest complete authorized slice, use existing tools and preserve reusable fixtures/tests. Continue through verification and in-scope repair, not just a plan; stop when acceptance is proven or a specific blocker needs human input.

**Here:** improve “a workspace receives useful, authorized event context and can diagnose failed delivery,” not merely the connector count. For delivery changes, exercise signed provider fixtures, tenant rejection, duplicate events, rate limits, retry exhaustion and the visible recovery path. Fixture success is not live-provider acceptance; preserve the connector definition of done below.

**Evidence and authority:** use observable tests, provider receipts and user-journey checks rather than the implementing model's confidence. Report the tested revision, actual results and unverified boundaries. Existing product, security, approval and release rules remain authoritative; ambition grants no permission to contact users, expose data or change production. Propose larger opportunities separately. Any claimed improvement to these instructions needs representative tasks and independent evaluation, not a self-score.

**Credit:** adapted from [Felix Rieseberg, “How to be more ambitious: A tutorial for humans with models”](https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/) (13 October 2026). Speed, Altitude, Depth and Range are his framework; the repository examples and scope/authority safeguards are Lumi's adaptation.

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
