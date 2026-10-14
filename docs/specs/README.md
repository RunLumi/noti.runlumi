# Lumi Noti — Feature Specification Index

> **262 features, `F01`–`F262`, no gaps.** Every feature is a full engineering spec with a
> user story, testable acceptance criteria, technical design, schema, error cases, security
> notes, test cases and dependencies.
>
> Start with [`00-current-state.md`](00-current-state.md). It audits the working tree,
> lists every verified defect by ID, and states the single largest gap between this
> repository and a shippable multi-tenant product.

## How to read a spec

Every feature entry follows one shape:

```
**Priority**  P0 | P1 | P2   ·   **Status**   ·   **Fixes** Dxx (where applicable)
**Story**       As a <user>, I want <capability>, so that <outcome>.
**Acceptance**  checkbox list, specific and testable
**Design**      the decision and why, including the trade-offs rejected
**Schema**      SQL / TS types where records are touched
**Errors**      condition -> behaviour table
**Security**    the threat this feature exists to address
**Tests**       named cases, ready to become test files
**Deps**        F-ids and files this blocks
```

**Priority meaning**

| | Meaning |
| --- | --- |
| **P0** | Blocks a correct or safe release. Nothing ships without it. |
| **P1** | Required for a V1 a non-technical customer can complete unaided. |
| **P2** | Differentiators and post-V1 expansion. |

## Status legend

`✅` implemented and covered by tests (the status note cites the evidence) · `🟡` partly
implemented (the note says what is missing) · `❌` not started · `⛔` blocked (the note says by
what, for example an unbuilt feature or access to a real provider account) · `🚫` deferred or
decided against (the note cites the ADR or spec decision).

## Spec map

| # | Spec | IDs | Count | What it covers |
| --- | --- | --- | --- | --- |
| 00 | [Current State Audit](00-current-state.md) | — | — | Verified defects D1–D16, findings N1–N6, distance to V1 |
| 01 | [Platform & Runtime](01-platform-runtime.md) | F01–F14 | 14 | Toolchain, CI, environments, migrations, D1/Queues topology, redaction, error taxonomy, ADRs |
| 02 | [Identity, Workspaces & Tenant Isolation](02-identity-tenancy.md) | F15–F32 | 18 | Better Auth adoption, org model, sessions, passkeys, **tenant isolation — the P0** |
| 03 | [Secrets & Crypto](03-secrets-and-crypto.md) | F33–F40 | 8 | Envelope encryption, AAD binding, key custody, rotation, signing-secret generation |
| 04 | [Canonical Event Model](04-event-model.md) | F41–F54 | 14 | CloudEvents envelope, closed catalog, outcome model, size budget, versioning, schema registry |
| 05 | [GitHub Source](05-source-github.md) | F55–F72 | 18 | GitHub App install, installation registry, signature verification, **no-redelivery repair**, connector contract, fixture replay |
| 06 | [Generic & Additional Sources](06-source-generic-and-more.md) | F73–F90 | 18 | Standard Webhooks, GitLab, Stripe, Linear, Sentry, Cloudflare Alerts, source ranking |
| 07 | [Destination Capability Model](07-destination-capabilities.md) | F91–F104 | 14 | Adapter contract, capability contract, degradation ladder, Lark/Slack/Teams specifics |
| 09 | [Extended Destinations](09-destinations-extended.md) | F105–F120 | 16 | Discord, Telegram (recommended **against**), email, generic customer webhook |
| 10 | [Routing & Filtering](10-routing-and-filtering.md) | F121–F140 | 20 | Rule model, filter registry, evaluation, provenance, safe change |
| 11 | [Grouping & Noise Control](11-grouping-and-noise.md) | F141–F168 | 28 | Grouping, digests, quiet hours, preferences, **preset library**, resolution notices |
| 12 | [Delivery Reliability](12-delivery-reliability.md) | F169–F190 | 22 | Durable acceptance, dedup, atomic outbox claim, retries, DLQ, replay, honest duplicates |
| 13 | [Observability](13-observability.md) | F191–F204 | 14 | Correlation, metrics, honest SLIs, cost controls, runbook |
| 14 | [Dashboard & UX](14-dashboard-and-ux.md) | F205–F226 | 22 | Setup wizard, delivery log, accessibility (WCAG 2.2 AA), error copy, usability plan |
| 15 | [Security & Compliance](15-security-and-compliance.md) | F227–F242 | 16 | Threat model, SSRF policy, accepted-risk register, DSAR, supply chain, release gate |
| 16 | [AI & Roadmap](16-ai-and-roadmap.md) | F243–F262 | 20 | Opt-in AI with provenance, metering, plans, enterprise, stop/continue gates |

There is no `08`: the Lark, Slack and Teams connector specifications live inside
[`07`](07-destination-capabilities.md) as F101–F104, because the capability model is not
separable from those three adapters.

## Current implementation status

Every feature carries its own `Status` line, and [`STATUS.md`](STATUS.md) is the generated
ledger of all of them (id, title, priority, glyph, note, with per-spec counts). The counts
below are produced by `npm run docs:spec-status`; `tests/spec-status.test.ts` fails if they are
stale. What is **not** done, grouped and ordered as a work queue, is in
[`REMAINING.md`](REMAINING.md). The per-slice narrative is [`../PROGRESS.md`](../PROGRESS.md).

"Done" means merged to `main` with tests. It does **not** mean production-ready: nothing has been
exercised against a real GitHub App, Slack, Teams or Lark yet, and the release rule in
`AGENTS.md` is unmet.

<!-- spec-status:begin (generated by scripts/spec-status.mjs; do not edit) -->
| | ✅ Done | 🟡 Partial | ❌ Not started | ⛔ Blocked | 🚫 Deferred / decided against | Total |
| --- | --- | --- | --- | --- | --- | --- |
| **All features** | 32 | 156 | 52 | 5 | 17 | 262 |
| P0 | 28 | 107 | 11 | 4 | 8 | 158 |
| P1 | 4 | 43 | 23 | 0 | 2 | 72 |
| P2 | 0 | 6 | 18 | 1 | 7 | 32 |
<!-- spec-status:end -->

**The release gate that opened this catalog** was F25 and F26: tenant isolation in *our*
tables. Tenant resolution, the `organization_id` contract for new writes, and tenant-scoped
reads and writes are in place and covered by cross-tenant tests. What remains before a
public launch is in [`../RELEASE_GATES.md`](../RELEASE_GATES.md).

> The organization plugin is an authorization and membership registry. **It is not a
> data-isolation boundary.** Isolation is an `organization_id` predicate we write on every
> query, and migration 0008 enforces it at the database for every new integration write.

## Cross-cutting invariants

These hold across every domain and are restated nowhere else:

1. **Verify before parse.** Signature verification runs against raw bytes before
   `JSON.parse`. Re-serialising a body invalidates the signature.
2. **Never trust a body field for authorization.** Tenant resolution comes from the verified
   credential, never from payload content.
3. **At-least-once, stated plainly.** "Exactly once" appears nowhere in code, tests, docs or
   marketing. Duplicates are surfaced, not hidden.
4. **Accepted ≠ delivered.** Teams Workflows returns `202` with no read-back; the UI must not
   call that delivered.
5. **Redact before logging, not after.** A truncated secret is still a secret.
6. **No silent loss.** Every suppression, grouping, silence and dedup is recorded with a
   reason the customer can see.
7. **Capabilities are per destination, not per type.** Lark custom-bot and Lark app differ;
   so do Slack webhook and Slack Web API.
8. **External claims are cited.** Every provider or platform fact carries a URL and the date
   read. Unverified claims are marked `⚠️ UNVERIFIED` with what to check — never asserted.

## Sources

All external research was read on **2026-10-13**. Reference documents in this repository:

| Document | Contents |
| --- | --- |
| [`../DESTINATION_API_REFERENCE.md`](../DESTINATION_API_REFERENCE.md) | Slack, Teams, Lark, Discord, Telegram, Email — endpoints, limits, error semantics, deprecations |
| [`COMPETITIVE-FEATURE-SET.md`](COMPETITIVE-FEATURE-SET.md) | Novu, Knock, Courier, Alertmanager, Sentry, PagerDuty and peers — feature inventory with 114 verified URLs |
| [`../../DESIGN.md`](../../DESIGN.md) | Canonical Lumi visual system: colours, type, materials, geometry, iconography, accessibility |
| [`../../AGENTS.md`](../../AGENTS.md) | Operating contract, engineering invariants, release rule |

### Known documentation contradictions

Cloudflare's own docs disagree with themselves in places. We build on the conservative
reading and re-verify before trusting any of them:

| Topic | Conflict | Our position |
| --- | --- | --- |
| Cron trigger limit | "per account" (limits page) vs "per Worker" (cron page) | Treat as account-wide; use one Worker |
| Cron CPU time | 30 s (limits) vs 15 min (pricing) | Assume 30 s |
| Workers Logs retention | 7 days (limits table) vs 3 days Free (pricing) | Build to 3 days |
| Workflows concurrency | 50,000 (table) vs 10,000 (prose) | Not used in V1 |

Two claims that were checked and are **false**, recorded so they are not repeated:

- **There is no IETF "Webhook Security BCP".** Datatracker returns 404 and no BCP of that
  title exists. Cite [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md).
- **RFC 9331 is not about rate limiting.** It is *ECN for L4S*. The RateLimit headers remain
  an unratified Internet-Draft, so we treat them as optional and best-effort.

## Priority roll-up

**P0 — blocks a correct or safe release**
F01–F05, F07–F13 (platform) · F15–F29 (identity and tenancy) · F33–F40 (secrets) ·
F41–F42, F44, F46–F50 (event model) · F55–F58, F61–F72 (GitHub source) ·
F91–F99 (destination capability model) · F103–F104 (Slack, Teams) ·
F119–F140 (routing) · F141–F143, F165–F167 (grouping) · F169–F190 (delivery reliability) ·
F205–F226 (dashboard and UX) · F227–F242 (security and compliance)

**P1 — required for a V1 a non-technical customer can complete unaided**
Everything else in F01–F226.

**P2 — differentiators and post-V1**
F52–F54 · F60, F63, F66–F70 · F105–F120 · F144–F168 · F191–F204 · F243–F262

## Maintaining this index

- A new feature takes the next free `F` number. **Never renumber an existing feature** —
> cross-references appear in 15 files and in the code.
- Adding a file means updating the spec map, the status table and the priority roll-up here.
- Keep the range contiguous. The audit in [`00`](00-current-state.md) records why the gaps
  between domains are deliberate (domain-aligned) and why gaps *within* a range are not.