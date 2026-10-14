# Security baseline

## Threat model
Untrusted incoming events, forged signatures, cross-tenant routing, compromised credentials, webhook SSRF, event replay, delivery floods, provider API changes, and accidental disclosure in logs or previews.

## Minimum controls
- Verify raw webhook body signatures before parsing or queueing.
- Restrict source installations and destination configuration to authorized workspace members.
- Encrypt destination secrets at rest with keys stored outside D1; support rotation and deletion.
- For arbitrary webhook destinations, verify ownership and prevent SSRF including redirect and DNS rebinding bypasses.
- Do not expose raw private event payloads to other tenants, analytics, AI providers or error trackers.
- Apply size/rate limits, quotas, redaction, least privilege, audit events and retention policy.
- Document and test retries, duplicate sends, dead letters and manual replay.
- Perform abuse/security review before public multi-tenant launch.

No formal security audit has been performed.

The full model (assets, trust boundaries, STRIDE per entry point) and the accepted-risk
register are in [`THREAT_MODEL.md`](THREAT_MODEL.md). Release status is in
[`RELEASE_GATES.md`](RELEASE_GATES.md). Where each authentication and authorization decision lives, and the
route-by-guard table, is in [`AUTHORIZATION.md`](AUTHORIZATION.md). Vulnerability reports: see the root `SECURITY.md`.

## Response headers

- Every Worker response carries HSTS, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options: DENY`, COOP and a
  `default-src 'none'` CSP (`src/security/headers.ts`, mounted first in `src/index.ts`).
- The SPA is a separate static deployment. Its headers are in `web/public/_headers`, rendered
  from the same module, with a nonce-free CSP: `script-src 'self'`, `style-src 'self'`,
  `connect-src 'self'`, self-hosted fonts, `frame-ancestors 'none'`. A test fails if the file
  drifts. The static host must honour a Cloudflare-format `_headers` file; that deployment is
  not confirmed.

## Rate limits

Better Auth limits `/api/auth/*`; the integrations API limits mutations per user. Webhook
ingress flood control per installation (`ingressLimiter`, `src/security/rate-limit.ts`) is
implemented and tested but **not yet wired into the route**. It is never applied to GitHub
lifecycle events, because delaying a revocation is worse than absorbing a cheap request.

## Dependency audit exceptions

CI runs `npm run audit:gate`, which fails on high or critical advisories in production
dependencies. The exception list in `scripts/audit-gate.mjs` is currently **empty**. The two
`tinypool` advisories (GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr) that were excepted until the
test runner moved to vitest 4 (no `tinypool` dependency) are gone. A new exception is a PR with
a reason and an expiry of at most 90 days, listed here with the advisory, package, why it does
not affect the Worker, and the expiry.

## Data deletion

An admin can schedule a workspace for deletion (`POST /api/workspace/deletion`).

- Integrations are disabled immediately, so nothing more is routed or delivered.
- After 7 days, a cron purge deletes every tenant row and the organization itself.
- Deleting an integration row destroys its wrapped data key. Every credential sealed under
  that key is unrecoverable from then on (crypto-shredding).
- **Backups:** Cloudflare D1 Time Travel can restore a database to any point in the last 30
  days. Data is therefore not unrecoverable from Cloudflare's point-in-time history until
  that window has passed, and we do not promise faster erasure than that. See
  https://developers.cloudflare.com/d1/reference/time-travel/ (read 2026-10-13).

Admins can export their workspace (`GET /api/workspace/export`) as JSON. The export never
includes credentials.

A signed-in person can export their own data (`GET /api/workspace/me/data-export`) and erase
their account (`DELETE /api/workspace/me`). Erasure refuses while the person is the only admin
of a workspace and never deletes a workspace or another member's data. Audit rows keep the opaque
actor id, IP address and user agent until the audit retention (AR-40). Scope, decisions and limits:
[`DSAR.md`](DSAR.md).

What is stored, for how long and how it is removed is generated from code in
[`DATA_RETENTION.md`](DATA_RETENTION.md); who receives data is in
[`SUBPROCESSORS.md`](SUBPROCESSORS.md); incident handling is in
[`INCIDENT_RESPONSE.md`](INCIDENT_RESPONSE.md). None of these is a legal document, and the legal
basis, roles, contracts and deadlines are for the operator to decide.
