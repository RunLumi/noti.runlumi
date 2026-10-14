# Security policy

Lumi Noti is pre-release (engineering alpha). It is not offered as a production service and no
formal security audit has been performed. See [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md)
for what we protect and the risks we have knowingly accepted, and
[`docs/RELEASE_GATES.md`](docs/RELEASE_GATES.md) for what is still open.

## Reporting a vulnerability

The same contact is published at `/.well-known/security.txt` (RFC 9116).

Please report privately, not in a public issue or pull request.

Use GitHub private vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**
(<https://github.com/RunLumi/noti.runlumi/security/advisories/new>). If that option is not
available to you, open a public issue that says only that you have a security report and
asks for a private channel, with no technical detail.

Please include what you found, how to reproduce it, and the impact you expect. Do not include
real customer data or credentials. We handle reports on a best-effort basis; there is no
published response-time commitment yet.

## In scope

- Cross-tenant data access or routing (one workspace seeing or triggering another's events).
- Webhook signature, installation or origin-check bypasses.
- Leakage of credentials, webhook URLs or session tokens.
- SSRF through the destination allowlist.

## Out of scope

- Findings that need a compromised Cloudflare account or operator access.
- Volumetric denial of service.
- Issues already listed in the accepted-risk register in `docs/THREAT_MODEL.md`, unless you
  can show the compensating control is bypassed.
- Social engineering, and testing against infrastructure you do not own.

Please do not access data that is not yours, and give us reasonable time to fix an issue
before disclosing it.
