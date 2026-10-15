import type { Capability } from './permissions';

/**
 * The authorisation pointer for every route the Worker registers (docs/specs/15 F232).
 *
 * This is DATA, read by tests and by docs/AUTHORIZATION.md; the Worker does not consult it at
 * runtime. Enforcement stays in the handlers (`gate` / `mutationGate` / `authorize`). What this
 * file adds is a place where an unmapped route is visible:
 *
 *  - `tests/security/route-capability.test.ts` enumerates the routes the Hono app really
 *    registers and fails when one is missing here or one listed here is not registered;
 *  - for each entry it parses the handler's source and fails unless the handler contains the
 *    guard this entry claims (the capability literal in a gate call, a session lookup, a
 *    signature verification...).
 *
 * To add a route: register it, add one entry here, and say how it is guarded. There is no
 * default: an unlisted route fails the build.
 */
export type RouteAccess =
  /** A workspace member whose ROLE holds `capability`. Cross-workspace access is a 404, audited. */
  | { readonly kind: 'capability'; readonly capability: Capability }
  /** Any member of the resolved workspace, any role; no capability is needed to read this. */
  | { readonly kind: 'member' }
  /** A signed-in user; the handler checks the specific membership itself, from the database. */
  | { readonly kind: 'session' }
  /** Acts only on the caller's OWN account; the user id comes from the verified session, no workspace is named. */
  | { readonly kind: 'self' }
  /** Authenticates by verifying a signature over the raw body; the tenant comes from our own row. */
  | { readonly kind: 'signed-webhook'; readonly verifiedBy: string }
  /** Better Auth owns authentication, sessions, CSRF and rate limits for everything under it. */
  | { readonly kind: 'auth-handler' }
  /** Intentionally unauthenticated. Every entry needs a reason; the list is meant to stay tiny. */
  | { readonly kind: 'public'; readonly reason: string };

export interface RoutePolicy {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'ALL';
  /** Full path as the app registers it, with the mount prefix. */
  readonly path: string;
  /** File that defines the handler. */
  readonly file: string;
  /** Registration path inside that file's router (`'/'`, `'/:id'`), or a handler function name. */
  readonly handler: { readonly local: string } | { readonly name: string };
  readonly access: RouteAccess;
}

const cap = (capability: Capability): RouteAccess => ({ kind: 'capability', capability });
const local = (path: string): { local: string } => ({ local: path });

export const ROUTE_POLICY: readonly RoutePolicy[] = [
  // --- identity (Better Auth) ------------------------------------------------------------------
  {
    method: 'ALL',
    path: '/api/auth/*',
    file: 'src/index.ts',
    handler: local('/api/auth/*'),
    access: { kind: 'auth-handler' },
  },

  // --- workspace -------------------------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/workspace/me',
    file: 'src/auth/workspace.ts',
    handler: local('/me'),
    access: { kind: 'session' },
  },
  {
    method: 'POST',
    path: '/api/workspace/active',
    file: 'src/auth/workspace.ts',
    handler: local('/active'),
    access: { kind: 'session' },
  },
  {
    method: 'GET',
    path: '/api/workspace/team',
    file: 'src/auth/workspace.ts',
    handler: local('/team'),
    access: { kind: 'member' },
  },
  {
    method: 'GET',
    path: '/api/workspace/invitations',
    file: 'src/api/invitations.ts',
    handler: local('/'),
    access: cap('invitation.read'),
  },
  {
    method: 'POST',
    path: '/api/workspace/invitations/:id/cancel',
    file: 'src/api/invitations.ts',
    handler: local('/:id/cancel'),
    access: cap('invitation.cancel'),
  },
  {
    method: 'GET',
    path: '/api/workspace/deletion',
    file: 'src/api/workspace-lifecycle.ts',
    handler: local('/deletion'),
    access: cap('workspace.delete'),
  },
  {
    method: 'POST',
    path: '/api/workspace/deletion',
    file: 'src/api/workspace-lifecycle.ts',
    handler: local('/deletion'),
    access: cap('workspace.delete'),
  },
  {
    method: 'DELETE',
    path: '/api/workspace/deletion',
    file: 'src/api/workspace-lifecycle.ts',
    handler: local('/deletion'),
    access: cap('workspace.delete'),
  },
  {
    method: 'GET',
    path: '/api/workspace/export',
    file: 'src/api/workspace-lifecycle.ts',
    handler: local('/export'),
    access: cap('workspace.export'),
  },

  {
    method: 'GET',
    path: '/api/workspace/me/data-export',
    file: 'src/api/account.ts',
    handler: local('/data-export'),
    access: { kind: 'self' },
  },
  {
    method: 'GET',
    path: '/api/workspace/me/sessions',
    file: 'src/api/sessions.ts',
    handler: local('/'),
    access: { kind: 'self' },
  },
  {
    method: 'POST',
    path: '/api/workspace/me/sessions/revoke-others',
    file: 'src/api/sessions.ts',
    handler: local('/revoke-others'),
    access: { kind: 'self' },
  },
  {
    method: 'POST',
    path: '/api/workspace/me/sessions/:id/revoke',
    file: 'src/api/sessions.ts',
    handler: local('/:id/revoke'),
    access: { kind: 'self' },
  },
  {
    method: 'DELETE',
    path: '/api/workspace/me',
    file: 'src/api/account.ts',
    handler: local('/'),
    access: { kind: 'self' },
  },

  // --- integrations ----------------------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/integrations',
    file: 'src/api/integrations.ts',
    handler: local('/'),
    access: cap('integration.read'),
  },
  {
    method: 'GET',
    path: '/api/integrations/:id',
    file: 'src/api/integrations.ts',
    handler: local('/:id'),
    access: cap('integration.read'),
  },
  {
    method: 'POST',
    path: '/api/integrations',
    file: 'src/api/integrations.ts',
    handler: local('/'),
    access: cap('integration.create'),
  },
  {
    method: 'PATCH',
    path: '/api/integrations/:id',
    file: 'src/api/integrations.ts',
    handler: local('/:id'),
    access: cap('integration.update'),
  },
  {
    method: 'DELETE',
    path: '/api/integrations/:id',
    file: 'src/api/integrations.ts',
    handler: local('/:id'),
    access: cap('integration.delete'),
  },
  {
    method: 'GET',
    path: '/api/integrations/:id/routing-log',
    file: 'src/api/routing.ts',
    handler: local('/:id/routing-log'),
    access: cap('integration.read'),
  },
  {
    method: 'GET',
    path: '/api/integrations/:id/noise-status',
    file: 'src/api/routing.ts',
    handler: local('/:id/noise-status'),
    access: cap('integration.read'),
  },
  {
    method: 'POST',
    path: '/api/integrations/:id/filters/preview',
    file: 'src/api/routing.ts',
    handler: local('/:id/filters/preview'),
    access: cap('integration.read'),
  },
  {
    method: 'POST',
    path: '/api/integrations/:id/revoke-credentials',
    file: 'src/api/integrations.ts',
    handler: local('/:id/revoke-credentials'),
    access: cap('integration.revoke'),
  },
  {
    method: 'POST',
    path: '/api/integrations/:id/test',
    file: 'src/api/test-send.ts',
    handler: local('/:id/test'),
    access: cap('integration.update'),
  },

  // --- sources ---------------------------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/sources',
    file: 'src/api/sources.ts',
    handler: local('/'),
    access: cap('source.read'),
  },
  {
    method: 'GET',
    path: '/api/sources/:id',
    file: 'src/api/sources.ts',
    handler: local('/:id'),
    access: cap('source.read'),
  },
  {
    method: 'POST',
    path: '/api/sources',
    file: 'src/api/sources.ts',
    handler: local('/'),
    access: cap('source.create'),
  },
  {
    method: 'PATCH',
    path: '/api/sources/:id',
    file: 'src/api/sources.ts',
    handler: local('/:id'),
    access: cap('source.update'),
  },
  {
    method: 'POST',
    path: '/api/sources/:id/rotate',
    file: 'src/api/sources.ts',
    handler: local('/:id/rotate'),
    access: cap('source.rotate'),
  },
  {
    method: 'POST',
    path: '/api/sources/:id/revoke-credentials',
    file: 'src/api/sources.ts',
    handler: local('/:id/revoke-credentials'),
    access: cap('source.revoke'),
  },
  {
    method: 'DELETE',
    path: '/api/sources/:id',
    file: 'src/api/sources.ts',
    handler: local('/:id'),
    access: cap('source.delete'),
  },

  // --- deliveries, observability, audit, setup ---------------------------------------------------
  {
    method: 'GET',
    path: '/api/deliveries',
    file: 'src/api/deliveries.ts',
    handler: local('/'),
    access: cap('delivery.read'),
  },
  {
    method: 'GET',
    path: '/api/deliveries/summary',
    file: 'src/api/deliveries.ts',
    handler: local('/summary'),
    access: cap('delivery.read'),
  },
  {
    method: 'GET',
    path: '/api/observability/readiness',
    file: 'src/api/observability.ts',
    handler: local('/readiness'),
    // Names no workspace: the caller's own user id from the verified session must be on the secret
    // PLATFORM_OPERATOR_USER_IDS (src/observability/operator.ts); anyone else gets a 404.
    access: { kind: 'self' },
  },
  {
    method: 'GET',
    path: '/api/deliveries/:id',
    file: 'src/api/deliveries.ts',
    handler: local('/:id'),
    access: cap('delivery.read'),
  },
  {
    method: 'POST',
    path: '/api/deliveries/replay-plan',
    file: 'src/api/deliveries.ts',
    handler: local('/replay-plan'),
    access: cap('delivery.replay'),
  },
  {
    method: 'POST',
    path: '/api/deliveries/replay',
    file: 'src/api/deliveries.ts',
    handler: local('/replay'),
    access: cap('delivery.replay'),
  },
  {
    method: 'POST',
    path: '/api/deliveries/:id/replay',
    file: 'src/api/deliveries.ts',
    handler: local('/:id/replay'),
    access: cap('delivery.replay'),
  },
  {
    method: 'GET',
    path: '/api/observability/summary',
    file: 'src/api/observability.ts',
    handler: local('/summary'),
    access: cap('delivery.read'),
  },
  {
    method: 'GET',
    path: '/api/audit',
    file: 'src/api/audit.ts',
    handler: local('/'),
    access: cap('audit.read'),
  },
  {
    method: 'GET',
    path: '/api/setup/progress',
    file: 'src/api/setup-progress.ts',
    handler: local('/progress'),
    access: cap('delivery.read'),
  },

  // --- GitHub App install flow -------------------------------------------------------------------
  {
    method: 'POST',
    path: '/api/github/install',
    file: 'src/api/github.ts',
    handler: local('/install'),
    access: cap('integration.create'),
  },
  {
    method: 'GET',
    path: '/api/github/installations',
    file: 'src/api/github.ts',
    handler: local('/installations'),
    access: cap('integration.read'),
  },
  // Browser redirects: the user's own session is required; the single-use state row then binds
  // the flow to one user and one workspace, and membership is re-checked before binding.
  {
    method: 'GET',
    path: '/github/setup',
    file: 'src/api/github.ts',
    handler: local('/setup'),
    access: { kind: 'session' },
  },
  {
    method: 'GET',
    path: '/github/callback',
    file: 'src/api/github.ts',
    handler: local('/callback'),
    access: { kind: 'session' },
  },

  // --- ingress: signed webhooks; the tenant is read from OUR row, never from the request --------
  {
    method: 'POST',
    path: '/webhooks/github',
    file: 'src/connectors/sources/github/route.ts',
    handler: { name: 'githubWebhook' },
    access: { kind: 'signed-webhook', verifiedBy: 'verifyGithubSignature' },
  },
  {
    method: 'POST',
    path: '/webhooks/generic/:endpointId',
    file: 'src/connectors/sources/generic/route.ts',
    handler: { name: 'genericWebhook' },
    access: { kind: 'signed-webhook', verifiedBy: 'verifyStandardWebhook' },
  },
  {
    method: 'POST',
    path: '/webhooks/gitlab/:endpointId',
    file: 'src/connectors/sources/provider-route.ts',
    handler: { name: 'providerWebhook' },
    access: { kind: 'signed-webhook', verifiedBy: 'verify' },
  },
  {
    method: 'POST',
    path: '/webhooks/stripe/:endpointId',
    file: 'src/connectors/sources/provider-route.ts',
    handler: { name: 'providerWebhook' },
    access: { kind: 'signed-webhook', verifiedBy: 'verify' },
  },

  // --- public ------------------------------------------------------------------------------------
  {
    method: 'GET',
    path: '/health',
    file: 'src/index.ts',
    handler: local('/health'),
    access: {
      kind: 'public',
      reason:
        'Liveness probe for the platform; returns only whether the keyring is configured, never a value.',
    },
  },
  {
    method: 'GET',
    path: '/health/ready',
    file: 'src/index.ts',
    handler: local('/health/ready'),
    access: {
      kind: 'public',
      reason:
        'Readiness probe: reports only that D1 and the queue answer, cached for seconds; never a value, name or count.',
    },
  },
];

/**
 * Entries of `app.routes` that are middleware, not handlers: `app.use('*', ...)` and
 * `app.use('/api/*', requireSameOrigin)` and `app.use('/webhooks/*', ingressErrorBodies)`. They are asserted
 * present, not listed as routes.
 */
export const MIDDLEWARE_PATHS: readonly string[] = ['/*', '/api/*', '/webhooks/*'];
