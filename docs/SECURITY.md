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
