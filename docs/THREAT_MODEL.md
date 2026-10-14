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
| Tenant boundary (`organization_id`) | every tenant table: NOT NULL plus a foreign key with cascade (migration 0026; exceptions `audit_events` and the `workspace_deletions` ledger), triggers, scoped queries proved by a static test (ADR 0004, 0021) | Cross-tenant disclosure is the worst outcome |
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
6. Dashboard to browser: the SPA shell and static assets, now served by the same Worker (ADR 0017; `src/web/shell.ts`, `web/public/_headers`).

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
| R | Denied cross-scope event leaves no trace | `github.repository.out_of_scope` audit row; a signed event for an unknown or suspended installation is audited as `github.webhook.refused`, once an hour per installation and at most 30 a minute platform-wide (ADR 0028) | An unknown installation has no workspace, so its row is read by an operator from D1 and no tenant sees it |
| I | Probing which installations exist | Unknown, foreign and missing installations share one response | Suspended/uninstalled gets a distinct message (deliberate, F68) |
| D | Flood of valid-signature events | Size cap, early rejection; a content type other than `application/json` is 415 before the body is read. The per-installation limiter `ingressLimiter` (`src/security/rate-limit.ts`) runs after verification and answers 429 with `Retry-After`, pinned through the whole route (`tests/github/ingress-codes.test.ts`); it fails open. Cloudflare edge absorbs volumetric attacks (out of scope) | A signed flood below 600 events a minute per installation still costs Worker and D1 time |
| D | Lifecycle events throttled | Deliberately never rate limited: a revocation is a security signal and a 429 delays GitHub's view of it | Cost is small: lifecycle handling routes nothing |
| E | Replay | Stable idempotency key per `(org, installation, delivery id)`; GitHub provides no timestamp, so there is no replay window to enforce | Replays inside the dedup window are absorbed, outside it are treated as new (F170) |

### 4.1b Generic webhook ingress `POST /webhooks/generic/:endpointId` (slice 10a, ADR 0012)

| STRIDE | Threat | Control | Residual |
| --- | --- | --- | --- |
| S | Forged event | Standard Webhooks `v1` HMAC over the raw bytes with a per-source secret, constant-time `crypto.subtle.verify`, every candidate checked, other schemes ignored; verification precedes parsing and queueing | A leaked secret signs anything until it is rotated (cutover, no overlap) |
| T | Tampering, shifting bytes across the signed fields | A `.` in `webhook-id` and a non-digit timestamp are rejected before any HMAC | None known |
| R | Replay | Timestamp within 5 minutes; stable idempotency key per `(org, source, webhook-id)`; a reused id with a different body is refused (409) and counted | A replay with a fresh signature needs the secret |
| I | Probing which endpoints exist | Unknown and malformed endpoints share one 404 (status, body shape, headers tested); a disabled one is 410 Gone, answered BEFORE any signature check, so a holder of an old or leaked URL can tell enabled from disabled and the identical-404 property is intentionally dropped for that case (ADR 0028; the URL is the capability); a decoy HMAC runs for bodies up to 16 KiB | Timing is best effort and not measured (AR-18) |
| D | Unauthenticated body flood | Content type and size checked first; the body is read through a counting reader that stops at the cap; before authentication the cost is **one indexed D1 read plus one HMAC over at most 256 KiB** (no HMAC for a dead endpoint above 16 KiB); the per-source limiter (600 per minute) runs only after verification | The pre-authentication cost cannot be limited per source without an oracle: it needs an edge rule (AR-18, RUNBOOK) |
| E | Cross-tenant routing | Tenant comes only from the source row the endpoint selects; routing reads `organization_id` AND `source_id`; triggers refuse a cross-organization or re-pointed `source_id` | None known |

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
| T | Browser-side script injection | Strict CSP on the SPA (`script-src 'self'` plus the SHA-256 hash of each of Start's two inline bootstrap scripts, added per response by the Worker; no `'unsafe-inline'`, no nonce), React escaping; a static test fails if `dangerouslySetInnerHTML` or `innerHTML` appears in `web/src` or `src` | Markup from dependencies is not scanned |
| R | Admin action disputed | Append-only `audit_events` (UPDATE refused by trigger; DELETE allowed for cascade and retention) | Not tamper-evident (stated in migration 0008) |
| I | Cross-tenant read by guessing ids | `organization_id` is NOT NULL with a foreign key on every tenant table (0026); every query on a tenant table has an `organization_id` comparison, checked statically over `src/` with a reviewed allowlist (`tests/security/tenant-query-scope.test.ts`); every route is in a registry and its handler is checked for the guard it claims (`tests/security/route-capability.test.ts`, `docs/AUTHORIZATION.md`); non-members get 404; capability model with audited denials (`authorize`); a drill over every route in both directions on a fake D1 (`tests/drill/`) | The scanner cannot see dynamically built SQL and proves a predicate exists, not whose value it holds; **the staging drill has not been run** (`scripts/tenant-isolation-drill.mjs`, RELEASE_GATES); probe auditing is capped at 20 a minute per user |
| I | Reading another workspace by switching to it, or learning which workspace ids exist | `POST /api/workspace/active` checks membership in the database for the caller, answers a non-member and an unknown id identically (404), writes only the caller's own session row; the dashboard drops the old workspace's cache on a switch and every query names its workspace (ADR 0019) | The 30-per-minute limiter is per user, not per source IP |
| I | The observability summary now lists platform job names and times to any workspace member (`jobs`); alert messages and `job_runs` hold ids, counts and closed codes only, and the alert webhook is operator-set, policy-checked (four chat hosts), 10 s, never echoed (ADR 0024) | Job names and freshness are visible to every tenant; the webhook URL is a bearer secret held as a Worker secret |
| T | A stale tab writes into the wrong workspace after another tab switched the session's active workspace | `resolveWorkspace` refuses a write without `?org=` from a person with more than one membership (400); every dashboard write names its workspace (static scan); forms bind the workspace they opened for and disable themselves on a change; the tab alerts the person (ADR 0019) | A person who deliberately names another of their own workspaces writes there (they are a member) |
| I | Audit log discloses members' personal data | `GET /api/audit` is admin-only; actor is a name, only for a current member; no email, IP or user agent; metadata through a per-action allow-list, truncated and stripped of control and bidi characters | The workspace export still includes raw `metadata_json`; names of members are visible to admins |
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
| S/E | SSRF through a **customer-chosen** host (`generic_webhook`, ADR 0014): metadata endpoint, RFC 1918, loopback, our own ingress | Shape policy in the same single function (https, 443, no userinfo or fragment, no IP literal in any notation, no single-label, trailing-dot or internal-suffix name, no wildcard-DNS names, not `runlumi.app`), applied at write time and before every send; save-time DNS-over-HTTPS check of A and AAAA against a private-range table (fails closed); `redirect: 'manual'`; response body never read; request always signed | **DNS rebinding is not defeated** and nothing inspects the connected address at send time; no workspace host allowlist; no periodic re-resolution; metadata/RFC 1918 reachability from Workers egress untested and assumed reachable (AR-30). The destination is **off by default** (`GENERIC_WEBHOOK_ENABLED`) in the API and in the consumer until those are addressed; own hosts (`APP_ORIGIN`), `workers.dev`, `pages.dev` and `cfargotunnel.com` are blocked; CNAME targets are checked; connection failures are shown to tenants as one reason; at most 10 per workspace |
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

### 4.6b Account export and erasure `GET /api/workspace/me/data-export`, `DELETE /api/workspace/me`

Code: `src/api/account.ts`, `src/pipeline/expired-records.ts`, `src/compliance/`. Tests:
`tests/api/account.test.ts`, `tests/pipeline/expired-records.test.ts`,
`tests/compliance/retention.test.ts`. Decisions and limits: [`DSAR.md`](DSAR.md).

| | Threat | Control | Residual |
| --- | --- | --- | --- |
| I | Export used to read another person's or another workspace's data | The user id comes only from the verified session; every statement is bound to it; no member list, no invitee address, and audit rows are returned without subject or metadata (tested for foreign ids, addresses and IPs) | The caller's own audit rows include IP address and user agent by design |
| I | Export leaks a credential | Explicit column lists; session token and row id, password hash, OAuth tokens, passkey key material are never selected (tested with planted values) | None known |
| D | Export or erasure used as an enumeration or load vector | Authentication required, 5 per hour per person, audited, `no-store` | The limiter is per person, not per source IP |
| E | Cross-site request erases an account | Central and local Origin check, JSON content type | None known beyond AR-41. The typed account email is a misclick guard, **not** a security control |
| E | A stolen session cookie erases the account | Step-up: the session must be under 10 minutes old (`created_at`), else `403 reauth_required`; the person signs in again (password or passkey); an email notice goes to the address on file before the delete; sole-admin refusal; 5 attempts an hour; audit | A recent sign-in is not a second factor: whoever holds the password or a passkey, or a session fresh enough, can still erase (AR-41) |
| T | An erased admin takes other people's pending invitations with them | Pending invitations are reassigned to another admin of the same workspace in the same transaction (tested); sent invitations that are not pending go with the cascade | A workspace with no other admin cannot occur (last-admin trigger) |
| I | Export requested by a cross-site page | No CORS headers; `Sec-Fetch-Site` other than same-origin or none is refused (403) | A client that sends no `Sec-Fetch-Site` header is not refused, but still needs the session and cannot be read cross-origin |
| T | Erasure leaves a workspace without an admin or deletes tenant data | Refuses (409) for a sole admin; a database trigger is the backstop; only the person's own rows and cascades are deleted, never workspace tables | None known |
| I | Personal data lingers after erasure | Cascade from `user`, explicit deletes of install states and invitations addressed to the person | Audit rows keep actor id, IP and user agent (AR-40); Time Travel (AR-6) |
| I | Expired authentication records accumulate | Hourly `expired_auth_purge` for sessions, verification records, install states and Better Auth rate-limit rows; a sanity guard aborts the pass (`expired_purge_aborted`) if an expiry looks like seconds or most of a large session table would go | Full-table scans for `session`, `verification` and `rate_limit` (`github_auth_states` is indexed); invitations and never-verified accounts are not purged (gaps in `DATA_RETENTION.md`) |

### 4.7 Static SPA

| | Threat | Control | Residual |
| --- | --- | --- | --- |
| T | XSS, clickjacking, MIME sniffing | The shell is served by the Worker with `SPA_HEADERS` (`src/security/headers.ts`); its CSP adds only the hashes of the document's own inline scripts, computed from the served bytes as the browser parses them (`src/web/shell.ts`, `tests/web/shell.test.ts`). Static files use `web/public/_headers` (same source, drift-tested). No wildcard, `connect-src 'self'`, `frame-ancestors 'none'`; HSTS; `nosniff`; `Referrer-Policy`; `Permissions-Policy` | Verified in a real browser for sign-in, onboarding, overview and integrations on the production build; other signed-in screens were not exercised under the CSP. A hash allows a script with exactly that text, so a future Start release that changes its bootstrap script changes the hash automatically and is not a gap |
| T/E | A TanStack Start server function, server route or middleware is reached in production and bypasses the central CSRF check (`src/security/csrf.ts`), or exploits a Start advisory (GHSA-qx66-fv34-fjm8, reflected XSS via server-function responses) | `src/worker.ts` sends only `/api`, `/webhooks`, `/github`, `/health` to Hono and answers everything else from the built shell. Start's renderer is callable only by `vite dev` or by the build's prerender request: header `X-TSS_SHELL: true` exactly, a loopback host, **and** no `/_shell.html` yet. A deployment always has the shell and a real hostname, so no path or header reaches it (`tests/web/worker.test.ts`: `/_serverFn/x`, `//x`, encoded paths, with and without the header). `@tanstack/react-start` is 1.168.60 (patched). `tests/web/start-boundary.test.ts` fails if `web/src` imports Start or defines server handlers. Rule: state-changing work goes through the Hono API | If the shell were ever missing from a deployment the Worker answers 503 and still does not render (loopback host required). Start's server bundle and an RC `h3` are inside the deployed Worker, unreachable but present (ADR 0017); not exercised on a real deployment (RELEASE_GATES section 3) |
| D/T/E | Abuse of "send a test": flooding a customer's chat or one destination host from many workspaces, probing another workspace's ids, using a custom webhook as a status oracle, or a sender naming its event `test` to dodge filters | `POST /api/integrations/:id/test` needs `integration.update`, our Origin and JSON (central CSRF plus the route check); per-minute limits of 5 per integration, 20 per user, 30 per workspace and 10 per destination host across all tenants (`429`, `Retry-After`); an atomic `test_in_flight` guard (one test per integration per 15 minutes can be pending or retrying); refused while deletion is pending or for a paused/quarantined integration; the integration is looked up per workspace before any budget is spent (a foreign id is a 404 identical to a missing one). It goes through the real outbox, consumer, URL policy and adapters, so it cannot reach a host the allowlist refuses. Test results to a custom webhook are reduced to two buckets, not HTTP status classes. There is no event-type bypass of noise or filters; `test` and `noti.*` are reserved at generic ingress (ADR 0018, `tests/api/test-send.test.ts`) | Fixed one-minute windows allow up to twice a limit across a boundary (bounded by the in-flight guard and the host limit); a member with edit rights can still post one labelled test message per click into the chat they were given the integration for |
| I | A non-API path answered with HTML by mistake (a missing script served as the app) | Only known static extensions go to the assets layer; a miss is a 404 with the SPA baseline headers and `Cache-Control: no-store`; other dotted paths are client routes and get the shell | None known |
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
IDs AR-1 to AR-12 are the ones in spec 15 F241; AR-13 onward were added here (AR-40 and AR-41 by the compliance slice S3).

| ID | Risk | Why accepted | Compensating controls | Owner | Review trigger |
| --- | --- | --- | --- | --- | --- |
| AR-1 | Better Auth stores session tokens as cleartext, usable credentials (F234) | Hand-rolled session storage would put auth correctness in our code | 30-day expiry with daily refresh (`src/auth/better-auth.ts`), no `cookieCache` (static test), no read path, session revocation on password reset; session list and revoke-others UI not built (F23, gap) | identity owner | A Better Auth release that hashes tokens, or any D1 exposure |
| AR-2 | No platform egress filtering; the destination allowlist is entirely ours (F228) | Workers `fetch()` documents no destination restriction | Single allowlist, send-time re-validation, `redirect: 'manual'`; registry with citations, a weekly 180-day staleness check, and an AST regression guard (not a proof) on which modules make outbound-capable calls (ADR 0026) | security owner | An allowlist bypass report |
| AR-3 | DNS rebinding cannot be prevented in Workers (F230) | No custom resolution with SNI and certificate verification preserved | Exact-host allowlist, IP literals rejected, bounded timeout and body | security owner | Workers gains a pinning-capable fetch, or an incident |
| AR-4 | Key custody depends on Worker secrets (and Secrets Store beta if adopted) (`03` F34) | No HSM at this scale | Versioned KEKs, no key in D1 (a test scans every column of every table, the queue messages and the logs for the configured KEKs and secrets), rotation runbook (`docs/IMPLEMENTATION.md`), boot assertion at every entrypoint, and a per-environment KEK check value so a Worker holding another environment's KEK refuses to serve (ADR 0022). Destroying a KEK version is blocked while any row is wrapped under it and leaves an audited `key.destroy` event | platform owner | Secrets Store GA |
| AR-5 | At-least-once delivery produces duplicates (F185) | Queues has no exactly-once; Slack has no server-side dedup key | Ledger claims, dedup key per event and destination, duplicates not hidden | reliability owner | A destination gains real idempotency |
| AR-6 | Erasure cannot outrun D1 Time Travel (up to 30 days) | Platform-managed backups; documented in `docs/SECURITY.md` and `docs/DSAR.md` | Deleting a connection deletes its wrapped key, which makes its sealed credentials unreadable even to a holder of the KEK (tested, ADR 0022), and an admin can revoke a credential to stop all use at once; the retention matrix (`docs/DATA_RETENTION.md`) and its jobs now cover every table, with the remaining gaps named there (F237) | data owner | Cloudflare changes Time Travel |
| AR-7 | Email Sending platform limits (F235) | Sufficient for V1 | Quota monitoring not built (gap) | product owner | Approaching 50% of a limit |
| AR-8 | Workers Rate Limiting binding is per-location; our limits are D1 fixed windows, which allow a burst of up to twice the limit across a window boundary | D1 is the authoritative counter; fixed windows are simple | D1-backed counters (`src/security/rate-limit.ts`, `integrations.ts`, Better Auth) | platform owner | A need for exact accounting |
| AR-9 | Provider APIs change under us (F229, `07`) | We do not control third parties | Closed response taxonomy, terminal-not-retry classification, `unmapped` flag | connector owners | A provider changelog |
| AR-10 | Dead legacy tables remain in the migration chain, one with plaintext tokens (N1, F234) | Already applied to live databases | Retired-schema test (`tests/retired-schema.test.ts`), excluded from export; listed as `not_enforced` in the retention matrix because whether a live database still holds rows is unknown to the repository | identity owner | A migration drops them |
| AR-11 | Outbound requests reveal our egress IP to providers, who log them | Inherent to delivery | Payload limited to the rendered notification | product owner | A provider requires static IPs |
| AR-12 | A hostile destination receives a POST with notification content | That is the product, bounded by AR-2 and AR-3 | Host allowlist, body caps, timeouts | security owner | An allowlist entry is broadened |
| AR-13 | One App-wide webhook secret signs every installation's events | GitHub Apps have a single webhook secret | Tenant derived from the installation block, `app_id` check, per-installation scope; rotate on suspicion | security owner | GitHub offers per-installation secrets, or a leak |
| AR-14 | Session cookie `SameSite` and `Secure` attributes rely on Better Auth defaults that we have not verified for 1.7.7 (F23) | Believed safe defaults; unverified | Origin check on our own mutating routes; `trustedOrigins` single origin | identity owner | Verifying against the installed version |
| AR-15 | Teams accepts any `*.logic.azure.com` host, which tenants can create (ADR 0006) | Microsoft documents the trigger URL as opaque | https-only, no IP literals, no redirects, body and timeout bounds; payload is the rendered notification | security owner | Microsoft documents a narrower form |
| AR-16 | Ingress flood control is a fixed window (600 events per installation per minute) | Applied after signature verification and tenant resolution; lifecycle events and pings are never limited; a limiter fault fails open and logs `rate_limit_error` | A runaway installation is bounded; a window boundary allows up to 2× (AR-8); GitHub does not retry a 429, so an operator redelivers | platform owner | A legitimate burst above 600 per minute |
| AR-17 | Rate-limit counters (one row per key per minute) | Pruned from `scheduled()` (older than 1 h, up to 5,000 rows per tick) and indexed on `window_start` (migration 0014) | Counters are tiny; bursts of up to 2× the limit are possible at a window boundary (AR-8) | platform owner | Growth outpacing 5,000 rows per minute |
| AR-18 | Pre-authentication cost of `/webhooks/generic/*`: one D1 read and one HMAC over up to 256 KiB per request, with no per-source limit possible before the signature is known | A per-source limit before verification would let anyone burn a source's budget, and an unknown endpoint has no source to limit | Counting body reader (cap at 256 KiB); decoy HMAC skipped above 16 KiB; per-source limiter after verification; the edge rule in docs/RUNBOOK.md ("Generic source: edge rate rule") must be configured on the zone | platform owner | An abuse spike, or the zone rule being absent in production |
| AR-19 | A sender that reuses `webhook-id` for different events loses them (409) | The producer owns id uniqueness; the alternative, silently dropping or double-sending, is worse | 409 `webhook_id_reused`, a redacted warning, and a visible per-source counter on the Sources page | product owner | Support reports of rejected events |
| AR-20 | A GitLab source in `secret_token` mode authenticates the sender but not the body, and a captured request can be replayed (no timestamp) | GitLab offers the plain token for webhooks created before the signing token (GA 19.1); customers cannot always recreate them | Idempotency absorbs a replayed delivery id; the card and guidance state the weakness; rotate to a signing token is one step | product owner | A customer reports a forged or replayed GitLab event |
| AR-21 | Provider sources (GitLab, Stripe) have only fixtures built from documentation, never a real delivery; GitLab floods are dropped with a 2xx rather than a 4xx | A 4xx makes GitLab disable the webhook (spec 06 F82) | Dropped floods are logged with the source id; verification is tested against independently built signatures | security owner | First real-provider acceptance test, or a report of missing events |
| AR-22 | Provider endpoints have a coarse pre-authentication limiter (1200 a minute per endpoint id) so an unauthenticated flood cannot force unbounded secret unwraps; anyone who knows the public endpoint id can fill it and delay the real sender | The id is public by design and a per-source limit before verification would be an oracle; the post-auth limit (600 a minute) stays the control for honest traffic | `ingress:endpoint:<id>` counter, 429 with `Retry-After`, fails open on a limiter fault; an edge rate rule (RUNBOOK) is still the control for volume | security owner | A sender reports 429 it did not cause |
| AR-23 | Timing parity of the dead-endpoint path is best effort: a live endpoint does a single-row read, a DEK unwrap and a secret open that a dead one does not (a decoy HMAC narrows, not removes, the difference); not measured | The endpoint id has 144 bits of entropy, so enumeration is not the realistic threat | Identical status, body and headers (tested) | security owner | A timing oracle is demonstrated |
| AR-30 | A customer-chosen webhook host can resolve to a private address after it passed the save-time check (DNS rebinding), and Workers `fetch` cannot be pinned to the address we checked (slice 8a, ADR 0014) | The feature is a customer's right to receive their own events; without a host choice there is no feature | Shape policy and the DNS check at save time, no redirects, port 443, signed requests, response body never read, 10 s timeout, 64 KB body, the destination only receives the rendered notification, never credentials or internal ids beyond an opaque workspace id | security owner | The destination is disabled in production by default; the criteria to enable it are in ADR 0014 decision 18 (host allowlist, periodic re-resolution, Worker egress canary). Or: a pinning-capable fetch; or an incident |
| AR-31 | Discord's invalid-request budget (401, 403, 429 count; 404 triggers a "temporary restriction") is shared by every workspace on our egress, and the persistent cross-workspace breaker is not built (slice 8a) | Discord documents it; the spec's remedy needs a shared persisted breaker | 404/410 (and 401/403 with Discord's own dead-webhook codes) are permanent with zero retries and pause the integration after the first failure, other 401/403 retry at most once more; `429` is never retried before `retry_after` | reliability owner | A Discord restriction incident, or the breaker being built |

| AR-40 | Erasing an account does not erase the person's audit rows: they keep the opaque actor id, IP address and user agent until `AUDIT_RETENTION_DAYS` (default 365). A database trigger refuses every UPDATE of `audit_events` (migration 0008), so a scrub would need a deliberate migration (F236, F238, `docs/DSAR.md`) | The audit log is the evidence for incident response and append-only is its point; whether this retention satisfies an erasure obligation is a legal decision that is not made here | The actor id no longer resolves to a person once the user row is deleted (the dashboard shows a former member); the retention is configurable down to 30 days; IP and user agent are not in the workspace audit view; the erasure row itself carries no IP or user agent | data owner | The operator's legal decision on erasure versus security logging, or a regulator or customer request |
| AR-41 | Account erasure is protected by a recent sign-in (session under 10 minutes old, then a re-sign-in by password or passkey), an email notice and a typed email, **not** by a second factor or an undo window. The typed email is an anti-misclick control only: it is not a CSRF or a security control (`DELETE /api/workspace/me`) | A second factor and a soft-delete grace need a Better Auth freshness and suspend design that is not built | Step-up on `session.created_at`, notice email before the delete, sole-admin refusal, 5 attempts an hour, audit row per workspace, same-origin and JSON checks, `Clear-Site-Data`; the person's workspaces survive | identity owner | A report of an erased account, or adding a second factor or soft-delete |

An accepted risk whose compensating control regresses stops being accepted and becomes a
defect. Adding a row is a PR; removing one requires the control to have shipped.
