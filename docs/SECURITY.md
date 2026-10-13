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
