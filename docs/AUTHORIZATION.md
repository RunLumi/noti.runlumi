# Authorisation: where each decision lives

> The pointer page required by [spec 15 F232](specs/15-security-and-compliance.md). It points; it
> does not restate policy. The two tables below are **generated from the code that enforces
> them** (`src/auth/permissions.ts`, `src/auth/route-policy.ts`) and a test fails when they drift.
> Refresh them with `npm run docs:authorization`.

## The four things nobody may assume

1. The organization plugin is a **membership registry**, not a data-isolation boundary. Isolation
   is `organization_id` on every tenant row (NOT NULL, foreign key, migration 0026) plus a
   predicate on every query (`tests/security/tenant-query-scope.test.ts`).
2. Authorization comes from the **verified credential**, never from the payload. A webhook's
   tenant is read from our own installation or source row after its signature verified; a
   request body or URL naming an organization is never an authority.
3. Cross-tenant access is **404, not 403**: a 403 confirms the workspace exists. The denial is
   audited by the authorisation layer (`authorize()`), not by individual routes.
4. **Client-side** button hiding is never a control. Every route below is enforced on the server.

## Who decides what

| Question | Owner | Where it is enforced | Evidence |
| --- | --- | --- | --- |
| Who is the user, how sessions are stored | spec 02 F16, F20 | Better Auth, mounted at `/api/auth/*` | Better Auth schema migrated; session expiry configured |
| Roles and capabilities | spec 02 F24 | `src/auth/permissions.ts` (`can()`) | `tests/auth/permissions.test.ts`, and the generated table below |
| Which organization a request acts on | spec 02 F15, F26 | `authorize()` in `src/auth/workspace.ts`: membership resolved server-side, non-member is 404 | `tests/api/integrations.test.ts`, `tests/api/workspace-active.test.ts`, `tests/drill/` |
| Session lifetime and revocation | spec 02 F18, F20, F23 | Better Auth | `src/api/sessions.ts` (list, revoke one, revoke others, own sessions only), `tests/api/sessions.test.ts`; ADR 0030 |
| CSRF and origin policy | spec 02 F23 | `requireSameOrigin` on every `/api/*` mutation, repeated in handlers | `tests/security/static-guards.test.ts` |
| Webhook ingress authentication | spec 05 F58, F59, F64 | signature over the raw bytes, then tenant from our row | provider route tests; `tests/tenant-resolution.test.ts` |
| Domain data isolation | spec 02 F25, F26; spec 15 F233 | schema contract + query predicates + the route policy below | `tests/migration-0026.test.ts`, `tests/security/`, `tests/drill/` |

## Roles and capabilities (generated)

<!-- BEGIN GENERATED: capabilities -->

| Capability | admin | member | Required by |
| --- | --- | --- | --- |
| `integration.read` | yes | yes | `GET /api/integrations`<br>`GET /api/integrations/:id`<br>`GET /api/integrations/:id/routing-log`<br>`GET /api/integrations/:id/noise-status`<br>`POST /api/integrations/:id/filters/preview`<br>`GET /api/github/installations` |
| `integration.create` | yes | yes | `POST /api/integrations`<br>`POST /api/github/install` |
| `integration.update` | yes | yes | `PATCH /api/integrations/:id`<br>`POST /api/integrations/:id/test` |
| `integration.delete` | yes | yes | `DELETE /api/integrations/:id` |
| `integration.revoke` | yes | no | `POST /api/integrations/:id/revoke-credentials` |
| `source.read` | yes | yes | `GET /api/sources`<br>`GET /api/sources/:id` |
| `source.create` | yes | yes | `POST /api/sources` |
| `source.update` | yes | yes | `PATCH /api/sources/:id` |
| `source.delete` | yes | no | `DELETE /api/sources/:id` |
| `source.rotate` | yes | no | `POST /api/sources/:id/rotate` |
| `source.revoke` | yes | no | `POST /api/sources/:id/revoke-credentials` |
| `delivery.read` | yes | yes | `GET /api/deliveries`<br>`GET /api/deliveries/summary`<br>`GET /api/deliveries/:id`<br>`GET /api/observability/summary`<br>`GET /api/setup/progress` |
| `delivery.replay` | yes | no | `POST /api/deliveries/replay-plan`<br>`POST /api/deliveries/replay`<br>`POST /api/deliveries/:id/replay` |
| `audit.read` | yes | no | `GET /api/audit` |
| `workspace.export` | yes | no | `GET /api/workspace/export` |
| `workspace.delete` | yes | no | `GET /api/workspace/deletion`<br>`POST /api/workspace/deletion`<br>`DELETE /api/workspace/deletion` |

<!-- END GENERATED: capabilities -->

Better Auth's own statements (`organization`, `member`, `invitation`) are managed by its
organization plugin with the same two roles; they are not routed through our handlers.

## Routes (generated)

Every route the Hono app registers has exactly one entry in `src/auth/route-policy.ts`.

<!-- BEGIN GENERATED: routes -->

| Route | Guard | Handler |
| --- | --- | --- |
| `ALL /api/auth/*` | Better Auth | `src/index.ts` |
| `GET /api/workspace/me` | signed-in session; membership checked in the handler | `src/auth/workspace.ts` |
| `POST /api/workspace/active` | signed-in session; membership checked in the handler | `src/auth/workspace.ts` |
| `GET /api/workspace/team` | any member of the resolved workspace | `src/auth/workspace.ts` |
| `GET /api/workspace/deletion` | capability `workspace.delete` | `src/api/workspace-lifecycle.ts` |
| `POST /api/workspace/deletion` | capability `workspace.delete` | `src/api/workspace-lifecycle.ts` |
| `DELETE /api/workspace/deletion` | capability `workspace.delete` | `src/api/workspace-lifecycle.ts` |
| `GET /api/workspace/export` | capability `workspace.export` | `src/api/workspace-lifecycle.ts` |
| `GET /api/workspace/me/data-export` | the caller's own account (user id from the verified session) | `src/api/account.ts` |
| `GET /api/workspace/me/sessions` | the caller's own account (user id from the verified session) | `src/api/sessions.ts` |
| `POST /api/workspace/me/sessions/revoke-others` | the caller's own account (user id from the verified session) | `src/api/sessions.ts` |
| `POST /api/workspace/me/sessions/:id/revoke` | the caller's own account (user id from the verified session) | `src/api/sessions.ts` |
| `DELETE /api/workspace/me` | the caller's own account (user id from the verified session) | `src/api/account.ts` |
| `GET /api/integrations` | capability `integration.read` | `src/api/integrations.ts` |
| `GET /api/integrations/:id` | capability `integration.read` | `src/api/integrations.ts` |
| `POST /api/integrations` | capability `integration.create` | `src/api/integrations.ts` |
| `PATCH /api/integrations/:id` | capability `integration.update` | `src/api/integrations.ts` |
| `DELETE /api/integrations/:id` | capability `integration.delete` | `src/api/integrations.ts` |
| `GET /api/integrations/:id/routing-log` | capability `integration.read` | `src/api/routing.ts` |
| `GET /api/integrations/:id/noise-status` | capability `integration.read` | `src/api/routing.ts` |
| `POST /api/integrations/:id/filters/preview` | capability `integration.read` | `src/api/routing.ts` |
| `POST /api/integrations/:id/revoke-credentials` | capability `integration.revoke` | `src/api/integrations.ts` |
| `POST /api/integrations/:id/test` | capability `integration.update` | `src/api/test-send.ts` |
| `GET /api/sources` | capability `source.read` | `src/api/sources.ts` |
| `GET /api/sources/:id` | capability `source.read` | `src/api/sources.ts` |
| `POST /api/sources` | capability `source.create` | `src/api/sources.ts` |
| `PATCH /api/sources/:id` | capability `source.update` | `src/api/sources.ts` |
| `POST /api/sources/:id/rotate` | capability `source.rotate` | `src/api/sources.ts` |
| `POST /api/sources/:id/revoke-credentials` | capability `source.revoke` | `src/api/sources.ts` |
| `DELETE /api/sources/:id` | capability `source.delete` | `src/api/sources.ts` |
| `GET /api/deliveries` | capability `delivery.read` | `src/api/deliveries.ts` |
| `GET /api/deliveries/summary` | capability `delivery.read` | `src/api/deliveries.ts` |
| `GET /api/deliveries/:id` | capability `delivery.read` | `src/api/deliveries.ts` |
| `POST /api/deliveries/replay-plan` | capability `delivery.replay` | `src/api/deliveries.ts` |
| `POST /api/deliveries/replay` | capability `delivery.replay` | `src/api/deliveries.ts` |
| `POST /api/deliveries/:id/replay` | capability `delivery.replay` | `src/api/deliveries.ts` |
| `GET /api/observability/summary` | capability `delivery.read` | `src/api/observability.ts` |
| `GET /api/audit` | capability `audit.read` | `src/api/audit.ts` |
| `GET /api/setup/progress` | capability `delivery.read` | `src/api/setup-progress.ts` |
| `POST /api/github/install` | capability `integration.create` | `src/api/github.ts` |
| `GET /api/github/installations` | capability `integration.read` | `src/api/github.ts` |
| `GET /github/setup` | signed-in session; membership checked in the handler | `src/api/github.ts` |
| `GET /github/callback` | signed-in session; membership checked in the handler | `src/api/github.ts` |
| `POST /webhooks/github` | signed webhook (`verifyGithubSignature`) | `src/connectors/sources/github/route.ts` |
| `POST /webhooks/generic/:endpointId` | signed webhook (`verifyStandardWebhook`) | `src/connectors/sources/generic/route.ts` |
| `POST /webhooks/gitlab/:endpointId` | signed webhook (`verify`) | `src/connectors/sources/provider-route.ts` |
| `POST /webhooks/stripe/:endpointId` | signed webhook (`verify`) | `src/connectors/sources/provider-route.ts` |
| `GET /health` | public | `src/index.ts` |
| `GET /health/ready` | public | `src/index.ts` |

<!-- END GENERATED: routes -->

Guard kinds: **capability** (a workspace member whose role holds it), **any member**, **signed-in
session** (the handler then checks the specific membership from the database), **signed webhook**
(signature over the raw body, tenant from our row), **Better Auth**, and **public** (`/health`
only, which returns whether the keyring is configured and never a value).

## Adding a route

1. Write the handler. Resolve the caller with `gate(c, '<capability>')` (reads) or
   `mutationGate(c, '<capability>')` (writes, which adds the Origin check, the deletion-pending
   block and the per-user rate limit). Every SQL statement on a tenant table must compare
   `organization_id` to `who.orgId`.
2. Add one entry to `ROUTE_POLICY` in `src/auth/route-policy.ts`.
3. Run `npm run docs:authorization` and commit the regenerated tables.
4. If a new capability is needed, add it to `statements` and to each role in
   `src/auth/permissions.ts`, and to the table in `tests/auth/permissions.test.ts`.

Skipping step 2 fails `tests/security/route-capability.test.ts`. A handler that does not contain the
guard its entry claims fails the same file.

## What the checks can and cannot see

- `tests/security/route-capability.test.ts` compares the routes the running app registers with the
  policy, and parses each handler's source for the claimed guard. It does not execute handlers, so
  it cannot catch a gate that is present but ordered after a read. The cross-workspace tests and
  the isolation drill (`tests/drill/`) cover behaviour.
- `tests/security/tenant-query-scope.test.ts` reads SQL written as literals in `src/`. It cannot
  see SQL assembled dynamically, and it proves an `organization_id` comparison exists, not that
  the bound value is the caller's organization. The few Drizzle queries (membership resolution in
  `src/auth/workspace.ts`) are not scanned; they are keyed by the session's user id and are the
  mechanism that resolves the tenant, so they are covered by `tests/workspace.test.ts` and
  `tests/tenant-resolution.test.ts`.
- Neither check replaces the staging drill (`docs/RELEASE_GATES.md`): it has not been run.
