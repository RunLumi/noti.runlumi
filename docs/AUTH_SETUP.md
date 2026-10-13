# Identity and organization implementation

The auth foundation is Cloudflare Workers + Hono + D1. Password-based signup and recovery are being implemented in this branch. **Passkeys, invitations, full role management and the authenticated UI are not yet production-ready.**

## Required environment
- D1 migration 0004_identity.sql
- Cloudflare Email Routing + Send Email binding named AUTH_EMAIL. Configure a verified sender address; the sending destination restrictions of the Cloudflare Email Workers product must be checked for your account. **Do not assume Send Email can send to arbitrary new customer addresses.** For unrestricted transactional email, a dedicated outbound email provider may be required.
- APP_ORIGIN and AUTH_FROM_EMAIL as non-secret vars, rate-limit binding or WAF rules, HTTPS custom domain.

## Identity invariants
- Email is canonicalized to lower-case and verified before sessions grant application access.
- No user belongs to more than one organization. Signup creates a private organization by default; invite acceptance must be a separate signup path to avoid creating an extra org.
- Roles: admin and member. Only admin can invite, remove or change roles.
- An organization cannot lose its final admin. Use a transactionally enforced operation and test simultaneous admin departures.
- Invite tokens, verification tokens, reset tokens and sessions are random, stored hashed, expiring, one-time where appropriate.
- Never reveal whether an email exists in forgot-password response.
- Rotate sessions on password reset, and set HttpOnly Secure SameSite cookies. Rate limit by IP and normalized email using durable shared state.
- WebAuthn requires verified origin/RP ID, challenge expiry and replay prevention, sign counter handling, and proper server-side attestation/assertion verification. Use a maintained WebAuthn library; do not implement WebAuthn crypto ad hoc.
- All login methods require verified email before issuing active sessions. Existing passkey credentials are not proof of ownership of a newly entered email address.

## Mandatory acceptance tests
signup -> email -> verify -> sign in; wrong/expired/reused token; forgot -> reset -> old session revoked; resend cooldown; login rate limit; invite member -> verify -> join; admin transfer -> last admin leaves; simultaneous last-admin departures; session theft/CSRF; WebAuthn registration/authentication/replay; inaccessible cross-org records.

## Status
Do not deploy as public multi-tenant auth until Cloudflare email sending constraints, full E2E tests, shared rate limiting, passkeys and membership flows are complete.
