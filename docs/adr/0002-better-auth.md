# ADR 0002: Better Auth identity with Cloudflare-native storage and mail

**Status:** Accepted for the PR #1 implementation, not a declaration of production readiness.

- Use Better Auth + organization and passkey plugins rather than a custom password/session protocol.
- Use Drizzle ORM with Cloudflare D1; Hono mounts the raw Better Auth handler at `/api/auth/*`.
- Use Cloudflare Email Sending, not incoming Email Routing, for transactional verification/reset/invites. The account must be enrolled.
- Enforce invariants (one active org per user and remaining admin) in D1 indexes/triggers as well as plugin validation hooks.
- Treat user membership as optional until onboarding or invitation acceptance; at most one organization at a time.
- Use database-backed rate limits and same-origin Secure HttpOnly session cookies.
- Do not migrate prototype auth credentials without explicit owner approval; legacy tables are retained but unused.
- Keep custom code for workspace-specific reads and use Better Auth plugins for all credential and member mutation endpoints.

Consequence: schema/version compatibility, Cloudflare email entitlement and full real-provider E2E tests become release gates. Initial self-service signup requires email verification before access.
