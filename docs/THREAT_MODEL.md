# Threat model and accepted-risk register

Status: living document. Written 2026-10-13 against `main` after PR #13. It implements the
shape of F227 (threat model) and F241 (risk register) from
[`specs/15-security-and-compliance.md`](specs/15-security-and-compliance.md).

**No formal security audit has been performed, and nothing here is an audit result.** This is
our own analysis of our own code. Every control named below points at code, a test, an ADR or
a spec; a control that does not exist yet is marked **gap** rather than described as if it did.
Per `AGENTS.md`, nothing here may be quoted as "production-ready" until
[`RELEASE_GATES.md`](RELEASE_GATES.md) is complete.

Review this file whenever a source, a destination or a trust boundary is added (F227).

## 1. What we protect (assets)

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| Destination credentials (Slack/Teams/Lark webhook URLs and Lark signing secrets) | `integrations`, sealed under per-connection DEKs (ADR 0004) | A webhook URL is a bearer credential for posting into a customer's chat |
| Event payload fragments (title, URL, repository) | `deliveries`, `notification_outbox`, queue messages | One tenant's private engineering activity |
| Key-encryption keys (`KEK_V<n>`), legacy `ENCRYPTION_KEY` | Worker secrets | Compromise exposes every credential at rest |
| `GITHUB_WEBHOOK_SECRET`, `GITHUB_CLIENT_SECRET`, `BETTER_AUTH_SECRET` | Worker secrets | Forge ingress, impersonate the installer check, forge sessions |
| Session tokens | Better Auth `session` table (see AR-1) | Usable bearer credentials |
| Tenant boundary (`organization_id`) | every tenant table, enforced by triggers and scoped queries (ADR 0004, slices 1 and 3a) | Cross-tenant disclosure is the worst outcome |
| Audit log | `audit_events`, append-only triggers (migration 0008) | Evidence for incident response |
| Delivery ledger | `deliveries` (ADR 0005) | Truthful delivery status is the product promise |

## 2. Adversaries

1. Anonymous internet attacker (no account).
2. Authenticated low-privilege member of a real workspace.
3. A legitimate tenant who is hostile (the SSRF actor: chooses the destination URL).
4. A compromised destination provider or provider account.
5. A compromised Cloudflare account or our own operator (out of scope, section 6).
6. A compromised dependency or CI job.

## 3. Trust boundaries

1. Internet to Worker (every public route).
2. Public webhook route to D1 (a verified payload is still attacker-influenced content).
3. Tenant A to tenant B (every query, authorization path and queue message).
4. Our database to a third-party destination (outbound `fetch`).
5. Browser to Worker API (cookie-authenticated, same origin).
6. Static SPA host to browser (separate deployment, see `web/public/_headers`).

## 4. STRIDE per entry point

S spoofing, T tampering, R repudiation, I information disclosure, D denial of service,
E elevation of privilege. "Gap" means no control exists in `main` today.

### 4.1 Webhook ingress `POST /webhooks/github`

Code: `src/connectors/sources/github/route.ts`, `tenant.ts`, `events.ts`. Tests:
`tests/github.test.ts`, `tests/tenant-resolution.test.ts`, `tests/pipeline/delivery-path.test.ts`.

| | Threat | Control | Residual |
| --- | --- | --- | --- |
| S | Forged event | HMAC-SHA-256 over the raw body, strict `sha256=<64 hex>` shape, constant-time `crypto.subtle.verify` (`verifyGithubSignature`); size cap 1 MiB checked on header and bytes; verification precedes parsing and queueing | The secret is App-wide: any installation of our App can sign (AR-13) |
| S | Event claiming another App | `installation.app_id` must match `GITHUB_APP_ID`; lookup scoped to our App id; unconfigured App id fails closed | None known |
| T | Cross-tenant routing via attacker-chosen repository name | Tenant comes only from the verified installation (D3, ADR in slice 1); `repo` only narrows inside the tenant; repository-selection scope enforced (F67) and audited | None known; not drilled against a real App |
| R | Denied cross-scope event leaves no trace | `github.repository.out_of_scope` audit row | Unknown-installation 403s are not audited (gap, F233 asks for it) |
| I | Probing which installations exist | Unknown, foreign and missing installations share one response | Suspended/uninstalled gets a distinct message (deliberate, F68) |
| D | Flood of valid-signature events | Size cap, early rejection. **Per-installation limiter `ingressLimiter` exists (`src/security/rate-limit.ts`, unit-tested) but is not wired into the route yet (gap; see PROGRESS "Slice S follow-ups")**. Cloudflare edge absorbs volumetric attacks (out of scope) | Until wired, a signed flood costs Worker and D1 time |
| D | Lifecycle events throttled | Deliberately never rate limited: a revocation is a security signal and a 429 delays GitHub's view of it | Cost is small: lifecycle handling routes nothing |
| E | Replay | Stable idempotency key per `(org, installation, delivery id)`; GitHub provides no timestamp, so there is no replay window to enforce | Replays inside the dedup window are absorbed, outside it are treated as new (F170) |

### 4.2 GitHub install flow `/api/github/install`, `/github/callback`

Code: `src/api/github.ts`, `src/connectors/sources/github/install.ts`. ADR 0008. Tests:
`tests/github/install-flow.test.ts`.

| | Threat | Control | Residual |
| --- | --- | --- | --- |
| S | Spoofed `installation_id` in the Setup URL | Single-use `install` and `verify` states stored as SHA-256, 10 min expiry, bound to the starting user; OAuth with PKCE; the installer's token must list the installation with our `app_id`; installer authority required; token revoked and never stored | Not validated against a real GitHub App (RELEASE_GATES) |
| T | Forged or reused state (CSRF on callback) | Atomic conditional `UPDATE ... WHERE used_at IS NULL AND expires_at > now`; a state from another user is refused | None known |
| I | Token or code in logs | Only fixed-name events are logged on failure (`github_callback_failed`); static test forbids console calls that pass bodies, headers or secrets | None known |
| E | Member binds an installation they do not control | Same as spoofing: access is verified with the installer's own token | None known |

### 4.3 Dashboard API `/api/*`

Code: `src/api/*.ts`, `src/auth/*.ts`. Tests: `tests/api/*`, `tests/auth/permissions.test.ts`,
`tests/security/static-guards.test.ts`.

| | Threat | Control | Residual |
| --- | --- | --- | --- |
| S | Credential stuffing, signup abuse | Better Auth rate limits with D1 storage, per-route rules, `cf-connecting-ip` source (F22) | Per-IP; shared IPs and distributed attacks (AR-8) |
| S | Stolen session token from a D1 read | 30-day expiry with daily refresh, no cookie cache, no read path | Tokens are stored in cleartext by Better Auth (AR-1) |
| T | Cross-site request forgery | `trustedOrigins` is one exact origin; our own mutating routes require `Origin == APP_ORIGIN` and JSON content type; a static test fails if a route file with mutating verbs lacks an origin check | `SameSite` and `Secure` cookie attributes rely on Better Auth defaults, not verified for 1.7.7 (AR-14) |
| T | Browser-side script injection | Strict nonce-free CSP on the SPA (`script-src 'self'`, no inline), React escaping; a static test fails if `dangerouslySetInnerHTML` or `innerHTML` appears in `web/src` or `src` | Markup from dependencies is not scanned |
| R | Admin action disputed | Append-only `audit_events` (UPDATE refused by trigger; DELETE allowed for cascade and retention) | Not tamper-evident (stated in migration 0008) |
| I | Cross-tenant read by guessing ids | Every query is `organization_id`-scoped; non-members get 404; capability model with audited denials (`authorize`) | Staging drill not run (RELEASE_GATES) |
| D | Mutation spam | Per-user fixed-window limit, 429 with `Retry-After` (`integrations.ts`) | Limited to the integrations routes |
| E | Member performs admin action | `admin` and `member` roles with a domain capability set (F24) | None known |

### 4.4 Queue consumer and outbox

Code: `src/pipeline/*`, `src/delivery/*`. ADR 0004, 0005. Tests: `tests/pipeline/*`,
`tests/delivery/*`.

| | Threat | Control | Residual |
| --- | --- | --- | --- |
| T | Swapped ciphertext delivers to the wrong place | AES-GCM AAD binds each ciphertext to org, connection, field and purpose; the consumer refuses on tag failure | None known |
| I | Secrets in queue messages or logs | Messages carry ids and display text only; the consumer re-reads with `WHERE id=? AND organization_id=?`; every log line passes `redact()` | Display text (title, URL) is in the queue by design |
| D | Poison message loops | Bounded attempts in the ledger, exponential backoff with jitter, dead-letter queue with its own consumer, manual redelivery | At-least-once means duplicates (AR-5) |
| R | Silent loss | Terminal states are explicit (`dead_lettered`, permanent failures); stale claims swept | Not rehearsed under injected failure in a real deployment |

### 4.5 Outbound delivery

Code: `src/connectors/destinations/*` (`url-policy.ts`, `send.ts`). ADR 0006. Tests:
`tests/destinations/*`.

| | Threat | Control | Residual |
| --- | --- | --- | --- |
| S/E | SSRF to internal or arbitrary hosts via the tenant-chosen URL | One allowlist (`url-policy.ts`): https only, no userinfo, port, fragment or IP literal, documented host and path shapes, checked at write time and again before every send; `redirect: 'manual'` so 3xx is classified, never followed | Workers has no egress filter and no DNS pinning (AR-2, AR-3); Teams allows any `*.logic.azure.com` (AR-15) |
| I | Credential or payload echoed in errors | Closed reason taxonomy; `providerCode` only from our own tables, never response bodies | None known |
| D | Hanging or huge destination | Per-request timeout and body bounds in `send.ts`; per-attempt classification | Per-provider-account outbound shaping (F187) not built (gap) |
| T | Markup or mention injection in rendered text | Per-destination escaping, atomic truncation (ADR 0006) | Lark/Teams markdown escaping could not be verified against provider docs and uses fullwidth substitution |

### 4.6 Admin deletion and export

Code: `src/api/workspace-lifecycle.ts`, `src/pipeline/purge.ts`. Tests:
`tests/api/workspace-lifecycle.test.ts`.

| | Threat | Control | Residual |
| --- | --- | --- | --- |
| E | Member deletes or exports a workspace | Admin capability required; Origin and JSON checks; audited | None known |
| I | Export leaks credentials | Export excludes credentials by construction (tested) | Dead `auth_tokens` table barred from reads (AR-10) |
| R | Accidental deletion | Two phases: integrations disabled at once, purge after 7 days, cancellable | None known |
| I | Data survives deletion | DEK destruction makes sealed credentials unreadable | D1 Time Travel keeps 30 days (AR-6) |

### 4.7 Static SPA

| | Threat | Control | Residual |
| --- | --- | --- | --- |
| T | XSS, clickjacking, MIME sniffing | `web/public/_headers` (rendered from `src/security/headers.ts`, drift-tested): CSP with no inline script, no wildcard, `connect-src 'self'`, `frame-ancestors 'none'`; HSTS; `nosniff`; `Referrer-Policy`; `Permissions-Policy` | Verified only for the signed-out screens in a real browser; signed-in screens were not exercised under the CSP |
| T | Worker response rendered as a page | Worker CSP `default-src 'none'` plus the same baseline headers on every response (`securityHeaders` middleware) | None known |

## 5. Supply chain and CI (adversary 6)

Controls: committed lockfile with `npm ci`; actions pinned to commit SHAs
(asserted by `tests/security/config-guards.test.ts`); read-only workflow permissions; no
`pull_request_target`; Dependabot for npm and Actions; `npm run audit:gate` (production
dependency advisories at high or critical, with dated exceptions in `scripts/audit-gate.mjs`);
dependency-review on PRs; `verify:worker-bundle` guards the scrypt fallback.
Not done: `npm audit signatures` on release builds, `--ignore-scripts` review, OIDC deploy
(F239 marks OIDC support as unverified).

## 6. What we do not defend against

- Compromise of the Cloudflare account or of an operator with secret access.
- A malicious package that executes at install time (partly mitigated by the lockfile only).
- Volumetric DDoS (Cloudflare's edge).
- A destination that answers `2xx` to everything while dropping messages.
- Anything about real providers: no real-provider end-to-end validation has happened.

## 7. Accepted-risk register

Owners are roles because this repository has no staffing record. Reviewed 2026-10-13; the
next review is due within 180 days or at the named trigger, whichever is first (F241).
IDs AR-1 to AR-12 are the ones in spec 15 F241; AR-13 onward were added here.

| ID | Risk | Why accepted | Compensating controls | Owner | Review trigger |
| --- | --- | --- | --- | --- | --- |
| AR-1 | Better Auth stores session tokens as cleartext, usable credentials (F234) | Hand-rolled session storage would put auth correctness in our code | 30-day expiry with daily refresh (`src/auth/better-auth.ts`), no `cookieCache` (static test), no read path, session revocation on password reset; session list and revoke-others UI not built (F23, gap) | identity owner | A Better Auth release that hashes tokens, or any D1 exposure |
| AR-2 | No platform egress filtering; the destination allowlist is entirely ours (F228) | Workers `fetch()` documents no destination restriction | Single allowlist, send-time re-validation, `redirect: 'manual'`; allowlist expiry and citations (F229) not built | security owner | An allowlist bypass report |
| AR-3 | DNS rebinding cannot be prevented in Workers (F230) | No custom resolution with SNI and certificate verification preserved | Exact-host allowlist, IP literals rejected, bounded timeout and body | security owner | Workers gains a pinning-capable fetch, or an incident |
| AR-4 | Key custody depends on Worker secrets (and Secrets Store beta if adopted) (`03` F34) | No HSM at this scale | Versioned KEKs, no key in D1, rotation runbook (`docs/IMPLEMENTATION.md`), boot assertion in `/health` | platform owner | Secrets Store GA |
| AR-5 | At-least-once delivery produces duplicates (F185) | Queues has no exactly-once; Slack has no server-side dedup key | Ledger claims, dedup key per event and destination, duplicates not hidden | reliability owner | A destination gains real idempotency |
| AR-6 | Erasure cannot outrun D1 Time Travel (up to 30 days) | Platform-managed backups; documented in `docs/SECURITY.md` | DEK destruction makes sealed credentials unreadable; retention job not yet built for non-workspace data (F237, gap) | data owner | Cloudflare changes Time Travel |
| AR-7 | Email Sending platform limits (F235) | Sufficient for V1 | Quota monitoring not built (gap) | product owner | Approaching 50% of a limit |
| AR-8 | Workers Rate Limiting binding is per-location; our limits are D1 fixed windows, which allow a burst of up to twice the limit across a window boundary | D1 is the authoritative counter; fixed windows are simple | D1-backed counters (`src/security/rate-limit.ts`, `integrations.ts`, Better Auth) | platform owner | A need for exact accounting |
| AR-9 | Provider APIs change under us (F229, `07`) | We do not control third parties | Closed response taxonomy, terminal-not-retry classification, `unmapped` flag | connector owners | A provider changelog |
| AR-10 | Dead legacy tables remain in the migration chain, one with plaintext tokens (N1, F234) | Already applied to live databases | Retired-schema test (`tests/retired-schema.test.ts`), excluded from export | identity owner | A migration drops them |
| AR-11 | Outbound requests reveal our egress IP to providers, who log them | Inherent to delivery | Payload limited to the rendered notification | product owner | A provider requires static IPs |
| AR-12 | A hostile destination receives a POST with notification content | That is the product, bounded by AR-2 and AR-3 | Host allowlist, body caps, timeouts | security owner | An allowlist entry is broadened |
| AR-13 | One App-wide webhook secret signs every installation's events | GitHub Apps have a single webhook secret | Tenant derived from the installation block, `app_id` check, per-installation scope; rotate on suspicion | security owner | GitHub offers per-installation secrets, or a leak |
| AR-14 | Session cookie `SameSite` and `Secure` attributes rely on Better Auth defaults that we have not verified for 1.7.7 (F23) | Believed safe defaults; unverified | Origin check on our own mutating routes; `trustedOrigins` single origin | identity owner | Verifying against the installed version |
| AR-15 | Teams accepts any `*.logic.azure.com` host, which tenants can create (ADR 0006) | Microsoft documents the trigger URL as opaque | https-only, no IP literals, no redirects, body and timeout bounds; payload is the rendered notification | security owner | Microsoft documents a narrower form |
| AR-16 | Fixed-window abuse limiter rows in `api_rate_limits` have no scheduled pruning yet | `pruneRateLimits` exists, wiring is a one-line follow-up | Rows are tiny; keys are bounded by user and installation counts | platform owner | Table growth, or the follow-up merging |

An accepted risk whose compensating control regresses stops being accepted and becomes a
defect. Adding a row is a PR; removing one requires the control to have shipped.
