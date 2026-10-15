import type { ReactNode } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { setFetchHandler } from './environment';
import { AppShell, Overview, Activity, Team, Settings, AuthPage, VerifyPage, ResetPage } from '../../pages';
import { OnboardingPage, InvitePage } from '../../onboarding';
import { IntegrationsPage } from '../../integrations/IntegrationsPage';
import { SourcesPage } from '../../sources/SourcesPage';
import { SetupFlow } from '../../setup/SetupFlow';
import { SetupResume } from '../../setup/SetupResume';
import { RootNotFound } from '../../shell/NotFound';
import { CreateWizard } from '../../integrations/wizard/CreateWizard';
import { IntegrationSettings } from '../../integrations/settings/IntegrationSettings';
import { validateActivitySearch } from '../../deliveries/search';
import { AuditPage } from '../../audit/AuditPage';
import { validateAuditSearch } from '../../audit/search';
import { LocaleProvider } from '../../i18n/LocaleProvider';
import { setLocale, type Locale } from '../../i18n/locale';
import {
  ADMIN,
  ATTEMPTS,
  AUDIT_EVENTS,
  DELIVERIES,
  INSTALLATIONS,
  INTEGRATIONS,
  INVITATIONS,
  MEMBERS,
  NOISE_STATUS,
  ORG_ID,
  impactFor,
  PASSKEYS,
  ROUTING_LOG,
  SESSIONS,
  SETUP_PROGRESS,
  SOURCES,
  TEST_DELIVERY_ID,
} from './fixtures';
import type { Me } from '../../lib/api';

/**
 * The application's route table, mirrored from the file routes in `web/src/routes` (the real router is built by
 * TanStack Start and needs a browser or the Worker). `pages.a11y.test.tsx` fails if the two ever
 * disagree, so a new route cannot ship without being added here and audited.
 */
export const ROUTE_PATHS = [
  '/',
  '/integrations',
  '/integrations/new',
  '/integrations/$id',
  '/setup',
  '/setup/$step',
  '/sources',
  '/onboarding',
  '/invite',
  '/activity',
  '/audit',
  '/team',
  '/settings',
  '/signin',
  '/signup',
  '/forgot-password',
  '/verify',
  '/reset',
] as const;

function buildRouter(initialPath: string) {
  const root = createRootRoute({ component: AppShell, notFoundComponent: RootNotFound });
  const route = (path: string, component: () => ReactNode) =>
    createRoute({ getParentRoute: () => root, path, component });
  const tree = root.addChildren([
    route('/', Overview),
    route('/integrations', IntegrationsPage),
    route('/integrations/new', CreateWizard),
    route('/integrations/$id', IntegrationSettings),
    route('/setup', SetupResume),
    route('/setup/$step', SetupFlow),
    route('/sources', SourcesPage),
    route('/onboarding', OnboardingPage),
    route('/invite', InvitePage),
    createRoute({
      getParentRoute: () => root,
      path: '/activity',
      component: Activity,
      validateSearch: validateActivitySearch,
    }),
    createRoute({
      getParentRoute: () => root,
      path: '/audit',
      component: AuditPage,
      validateSearch: validateAuditSearch,
    }),
    route('/team', Team),
    route('/settings', Settings),
    route('/signin', () => <AuthPage mode="signin" />),
    route('/signup', () => <AuthPage mode="signup" />),
    route('/forgot-password', () => <AuthPage mode="forgot" />),
    route('/verify', VerifyPage),
    route('/reset', ResetPage),
  ]);
  return createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    defaultPreload: false,
  });
}

type DeviceSessionRow = { id: string; current: boolean } & Record<string, unknown>;

// --- Mock API -------------------------------------------------------------------------------

export interface ApiState {
  me: Me | 'unauthenticated';
  integrations: unknown[] | 'error';
  sources: unknown[] | 'error';
  deliveries: unknown[] | 'error';
  installations: unknown[];
  githubConfigured: boolean;
  members: unknown[];
  passkeys: unknown[];
  /** `GET /api/workspace/me/sessions`; the revoke routes remove rows from it. `'error'` makes the list fail. */
  sessions: DeviceSessionRow[] | 'error';
  /** Make `POST .../sessions/:id/revoke` answer with this status. */
  revokeStatus?: 404 | 429 | 500;
  deletion: unknown;
  /** Make `GET /api/workspace/export` fail; by default it answers a small file. */
  exportFails?: boolean;
  /** `GET /api/setup/progress`; `'error'` makes it fail. */
  setup: unknown;
  /** Answer to `POST /api/integrations/:id/test`: accepted, or a failing status. */
  testSend: 'ok' | 'in_flight' | 409 | 429 | 500;
  /** The delivery a test creates, as `GET /api/deliveries/:id` reports it. */
  testDelivery: Record<string, unknown>;
  audit: unknown[] | 'error';
  /**
   * Answer to `DELETE /api/workspace/me`: `ok`, `reauth_once` (403 `reauth_required` until the person
   * signs in again, then ok), `sole_admin` (409), or `wrong` (422).
   */
  eraseAccount?: 'ok' | 'reauth_once' | 'sole_admin' | 'wrong';
  /** Make `POST /api/workspace/active` fail (a network or server fault). */
  failActivate?: boolean;
  /** The workspace a pending invitation would add the person to. */
  invitation?: { orgId: string; name: string; role: string };
  /** `GET /api/workspace/invitations`: the pending list, or `'error'` to make it fail. Cancels remove rows. */
  invitations: Record<string, unknown>[] | 'error';
  /** Make `POST .../invitations/:id/cancel` answer with this status instead (404 = already finished). */
  cancelInvitationStatus?: 404 | 500;
  /** `GET /api/public/signup-mode` (ADR 0048): the deployment's mode, or `'error'` to make it fail. */
  signupMode: 'open' | 'invite_only' | 'closed' | 'error';
  /** Make Better Auth's `POST /api/auth/organization/remove-member` refuse with this status and message. */
  removeMemberStatus?: 400 | 403 | 500;
  /** The body of the last `POST /api/auth/sign-up/email`, answered with Better Auth's uniform 200. */
  lastSignUp?: Record<string, unknown>;
  /**
   * How `POST /api/auth/sign-in/email` answers: `ok`, or `invalid` (Better Auth's 401 for a wrong address or
   * password). Unset leaves the route unmocked, as before.
   */
  signIn?: 'ok' | 'invalid';
  /**
   * Request paths (prefixes) that never answer, so a test can see the loading state a person sees
   * while a list is still on its way. Everything else answers at once, as before.
   */
  pending?: readonly string[];
  /**
   * Per-workspace data, selected by the `?org=` the page asked for. When present it overrides
   * `integrations`, `deliveries`, `members` and `audit`, so a test can prove that workspace A's
   * rows are never shown under workspace B.
   */
  /** Make `GET /api/integrations/:id/impact` fail; `pending` above makes it never answer. */
  impact?: 'error';
  orgs?: Readonly<
    Record<string, { integrations: unknown[]; deliveries: unknown[]; members: unknown[]; audit: unknown[] }>
  >;
}

export const defaultApi = (): ApiState => ({
  me: ADMIN,
  integrations: [...INTEGRATIONS],
  sources: [...SOURCES],
  deliveries: [...DELIVERIES],
  installations: [...INSTALLATIONS],
  githubConfigured: true,
  members: [...MEMBERS],
  invitations: INVITATIONS.map((i) => ({ ...i })),
  passkeys: [...PASSKEYS],
  sessions: SESSIONS.map((s) => ({ ...s })),
  deletion: { scheduled: false },
  setup: SETUP_PROGRESS,
  testSend: 'ok',
  testDelivery: { state: 'sent' },
  audit: [...AUDIT_EVENTS],
  signupMode: 'open',
});

/** A made-up value in the real `whsec_` shape; built at runtime so no literal looks like a credential. */
const fixtureSecret = () => ['whsec', btoa('fixture-not-a-real-value')].join('_');

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** Requests a test made that no handler answered; asserted empty by the route-coverage test. */
export const unhandled: string[] = [];
export const clearUnhandled = () => unhandled.splice(0, unhandled.length);

/** Every request the mock saw, as `METHOD path?query`, for tests that assert what was asked. */
export const requests: string[] = [];
export const clearRequests = () => requests.splice(0, requests.length);

export function installFetch(state: ApiState): void {
  setFetchHandler((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://localhost',
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    requests.push(`${method} ${path}${url.search}`);
    if (state.pending?.some((prefix) => path.startsWith(prefix))) return new Promise<Response>(() => {});
    const org = url.searchParams.get('org');
    const scoped = org && state.orgs ? state.orgs[org] : undefined;
    // With per-workspace data, a request for a workspace the mock does not know is a 404.
    if (state.orgs && org && !scoped && path !== '/api/workspace/me')
      return Promise.resolve(json({ error: 'Not found' }, 404));
    const integrations = scoped?.integrations ?? state.integrations;
    const deliveries = scoped?.deliveries ?? state.deliveries;
    const members = scoped?.members ?? state.members;
    const auditRows = scoped?.audit ?? state.audit;
    if (method === 'DELETE' && path === '/api/workspace/me') {
      const mode = state.eraseAccount ?? 'ok';
      if (mode === 'reauth_once') return Promise.resolve(json({ error: 'reauth_required' }, 403));
      if (mode === 'sole_admin')
        return Promise.resolve(json({ error: 'You are the only admin', blockers: [] }, 409));
      if (mode === 'wrong') return Promise.resolve(json({ error: 'wrong email' }, 422));
      return Promise.resolve(json({ deleted: true }));
    }
    // Pending invitations: admin only, as the server enforces it (a member is refused, never shown an empty list).
    const cancelInvitation = /^\/api\/workspace\/invitations\/([^/]+)\/cancel$/.exec(path);
    if (path === '/api/workspace/invitations' && method === 'GET') {
      if (state.me !== 'unauthenticated' && state.me.user.role !== 'admin')
        return Promise.resolve(json({ error: 'Missing capability: invitation.read' }, 403));
      const pending = state.invitations;
      return Promise.resolve(
        pending === 'error'
          ? json({ error: 'boom' }, 500)
          : json({ organizationId: org, invitations: pending, truncated: false }),
      );
    }
    if (cancelInvitation && method === 'POST') {
      if (state.me !== 'unauthenticated' && state.me.user.role !== 'admin')
        return Promise.resolve(json({ error: 'Missing capability: invitation.cancel' }, 403));
      if (state.cancelInvitationStatus)
        return Promise.resolve(json({ error: 'nope' }, state.cancelInvitationStatus));
      const pending = state.invitations;
      if (pending === 'error') return Promise.resolve(json({ error: 'boom' }, 500));
      const remaining = pending.filter((i) => i.id !== cancelInvitation[1]);
      if (remaining.length === pending.length) return Promise.resolve(json({ error: 'Not found' }, 404));
      state.invitations = remaining;
      return Promise.resolve(json({ cancelled: true, id: cancelInvitation[1] }));
    }
    if (path === '/api/workspace/me/sessions' && method === 'GET')
      return Promise.resolve(
        state.sessions === 'error' ? json({ error: 'boom' }, 500) : json({ sessions: state.sessions }),
      );
    if (
      path === '/api/workspace/me/sessions/revoke-others' &&
      method === 'POST' &&
      state.sessions !== 'error'
    ) {
      const others = state.sessions.filter((s) => !s.current);
      state.sessions = state.sessions.filter((s) => s.current);
      return Promise.resolve(json({ revoked: others.length }));
    }
    const revokeOne = /^\/api\/workspace\/me\/sessions\/([^/]+)\/revoke$/.exec(path);
    if (revokeOne && method === 'POST' && state.sessions !== 'error') {
      if (state.revokeStatus) return Promise.resolve(json({ error: 'nope' }, state.revokeStatus));
      const before = state.sessions.length;
      state.sessions = state.sessions.filter((s) => s.id !== revokeOne[1] || s.current);
      return Promise.resolve(
        state.sessions.length < before ? json({ revoked: 1 }) : json({ error: 'Not found' }, 404),
      );
    }
    if (method === 'GET' && path === '/api/public/signup-mode')
      return Promise.resolve(
        state.signupMode === 'error' ? json({ error: 'boom' }, 500) : json({ mode: state.signupMode }),
      );
    if (method === 'POST' && path === '/api/auth/sign-up/email') {
      // Better Auth answers an accepted and a refused sign-up alike while verification is required (ADR 0047).
      state.lastSignUp = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        unknown
      >;
      return Promise.resolve(json({ token: null, user: { id: 'user_new', email: state.lastSignUp.email } }));
    }
    if (method === 'POST' && path === '/api/auth/sign-in/email' && state.signIn) {
      if (state.signIn === 'invalid')
        return Promise.resolve(
          json({ code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' }, 401),
        );
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { email?: string };
      return Promise.resolve(
        json({ redirect: false, token: 'session-fixture', user: { id: 'user_1', email: body.email } }),
      );
    }
    if (method === 'POST' && path === '/api/auth/organization/remove-member') {
      if (state.removeMemberStatus)
        return Promise.resolve(
          json(
            { message: 'You are not allowed to remove this member', code: 'FORBIDDEN' },
            state.removeMemberStatus,
          ),
        );
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        memberIdOrEmail?: string;
      };
      const removed = (state.members as { id: string }[]).find((m) => m.id === body.memberIdOrEmail);
      if (!removed) return Promise.resolve(json({ message: 'Member not found', code: 'NOT_FOUND' }, 400));
      state.members = (state.members as { id: string }[]).filter((m) => m.id !== removed.id);
      return Promise.resolve(json({ member: removed }));
    }
    if (method === 'POST' && path === '/api/workspace/active' && state.failActivate)
      return Promise.resolve(json({ error: 'boom' }, 500));
    if (
      method === 'POST' &&
      path === '/api/auth/organization/accept-invitation' &&
      state.me !== 'unauthenticated' &&
      state.invitation
    ) {
      const joined = {
        orgId: state.invitation.orgId,
        role: state.invitation.role,
        name: state.invitation.name,
      };
      state.me = { user: { ...state.me.user, organizations: [...state.me.user.organizations, joined] } };
      return Promise.resolve(
        json({ invitation: { organizationId: joined.orgId }, member: { organizationId: joined.orgId } }),
      );
    }
    if (method === 'POST' && path === '/api/workspace/active' && state.me !== 'unauthenticated') {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        organizationId?: string;
      };
      const target = state.me.user.organizations.find((o) => o.orgId === body.organizationId);
      if (!target) return Promise.resolve(json({ error: 'Not found' }, 404));
      state.me = {
        user: {
          ...state.me.user,
          org_id: target.orgId,
          activeOrgId: target.orgId,
          org_name: target.name,
          role: target.role === 'admin' ? 'admin' : 'member',
        },
      };
      return Promise.resolve(json({ activeOrgId: target.orgId, orgName: target.name, role: target.role }));
    }
    if (method === 'POST' && path === '/api/auth/organization/create' && state.me !== 'unauthenticated') {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        name?: string;
        slug?: string;
      };
      const created = {
        orgId: `org_created_${state.me.user.organizations.length + 1}`,
        role: 'admin',
        name: body.name ?? '',
      };
      // Better Auth makes a new organization the session's active one.
      state.me = {
        user: {
          ...state.me.user,
          org_id: created.orgId,
          activeOrgId: created.orgId,
          org_name: created.name,
          role: 'admin',
          organizations: [...state.me.user.organizations, created],
        },
      };
      return Promise.resolve(json({ id: created.orgId, name: created.name, slug: body.slug }));
    }
    if (method === 'GET' && path === '/api/audit') {
      if (state.me !== 'unauthenticated' && state.me.user.role !== 'admin')
        return Promise.resolve(json({ error: 'Missing capability: audit.read' }, 403));
      return Promise.resolve(
        auditRows === 'error'
          ? json({ error: 'boom' }, 500)
          : json({
              organizationId: org,
              events: auditRows,
              nextCursor: null,
              total: auditRows.length,
              totalCapped: false,
              retentionDays: 365,
            }),
      );
    }
    if (method === 'GET') {
      if (path === '/api/workspace/me')
        return Promise.resolve(
          state.me === 'unauthenticated' ? json({ error: 'Sign in' }, 401) : json(state.me),
        );
      if (path === '/api/integrations')
        return Promise.resolve(
          integrations === 'error' ? json({ error: 'boom' }, 500) : json({ integrations, truncated: false }),
        );
      if (path === '/api/sources')
        return Promise.resolve(
          state.sources === 'error' ? json({ error: 'boom' }, 500) : json({ sources: state.sources }),
        );
      const noise = /^\/api\/integrations\/([^/]+)\/noise-status$/.exec(path);
      // Only the quiet-hours fixture has updates waiting.
      if (noise)
        return Promise.resolve(
          json(noise[1] === 'int_6' ? NOISE_STATUS : { held: { count: 0, nextReleaseAt: null }, failed: 0 }),
        );
      const impact = /^\/api\/integrations\/([^/]+)\/impact$/.exec(path);
      if (impact) {
        return Promise.resolve(
          state.impact === 'error' ? json({ error: 'boom' }, 500) : json(impactFor(impact[1] ?? '')),
        );
      }
      if (/^\/api\/integrations\/[^/]+\/routing-log$/.test(path))
        return Promise.resolve(json({ entries: ROUTING_LOG, nextCursor: null }));
      const one = /^\/api\/integrations\/([^/]+)$/.exec(path);
      if (one && Array.isArray(integrations)) {
        const found = (integrations as { id: string }[]).find((i) => i.id === one[1]);
        return Promise.resolve(found ? json({ integration: found }) : json({ error: 'Not found' }, 404));
      }
      if (path === '/api/github/installations')
        return Promise.resolve(
          json({ configured: state.githubConfigured, installations: state.installations }),
        );
      if (path === '/api/deliveries/summary')
        return Promise.resolve(
          json({
            counts: {
              pending: 0,
              claimed: 0,
              sent: 12,
              accepted: 3,
              retrying: 1,
              dead_lettered: 2,
              suppressed: 0,
            },
          }),
        );
      if (path === '/api/deliveries')
        return Promise.resolve(
          deliveries === 'error' ? json({ error: 'boom' }, 500) : json({ deliveries, nextCursor: null }),
        );
      if (path === `/api/deliveries/${TEST_DELIVERY_ID}`)
        return Promise.resolve(
          json({
            delivery: {
              ...(DELIVERIES[0] as object),
              id: TEST_DELIVERY_ID,
              isTest: true,
              ...state.testDelivery,
            },
            timeline: [],
            attemptDetail: 'summary',
            attempts: [],
            replays: [],
          }),
        );
      if (path === '/api/setup/progress')
        return Promise.resolve(state.setup === 'error' ? json({ error: 'boom' }, 500) : json(state.setup));
      const detail = /^\/api\/deliveries\/([^/]+)$/.exec(path);
      if (detail && Array.isArray(deliveries)) {
        const found = (deliveries as { id: string }[]).find((d) => d.id === detail[1]);
        return Promise.resolve(
          found
            ? json({
                delivery: found,
                timeline: [
                  { kind: 'created', at: '2026-10-13T08:00:00Z' },
                  { kind: 'last_attempt', at: '2026-10-13T08:01:00Z' },
                ],
                attemptDetail: 'full',
                attempts: ATTEMPTS,
                replays: [],
              })
            : json({ error: 'Not found' }, 404),
        );
      }
      if (path === '/api/workspace/team') return Promise.resolve(json({ members }));
      if (path === '/api/workspace/deletion') return Promise.resolve(json(state.deletion));
      if (path === '/api/workspace/export')
        return Promise.resolve(
          state.exportFails
            ? json({ error: 'boom' }, 500)
            : json({ format: 'lumi-noti-export/v1', truncated: { deliveries: false } }, 200, {
                'content-disposition': `attachment; filename="lumi-noti-export-${org ?? ORG_ID}.json"`,
              }),
        );
      if (path.endsWith('/passkey/list-user-passkeys')) return Promise.resolve(json(state.passkeys));
    }
    if (method === 'POST' && path === '/api/workspace/deletion') {
      // Like the server: scheduled for seven days from now; nothing is purged yet.
      state.deletion = {
        scheduled: true,
        requestedAt: '2026-10-15T09:00:00.000Z',
        purgeAfter: '2026-10-22T09:00:00.000Z',
        purgeStarted: false,
      };
      return Promise.resolve(json(state.deletion, 202));
    }
    if (method === 'POST' && path === '/api/deliveries/replay-plan')
      return Promise.resolve(
        json({
          plan: {
            eligible: 25,
            total: 30,
            totalCapped: false,
            remaining: 5,
            bound: 200,
            token: 'a'.repeat(64),
            typedConfirmationAbove: 20,
          },
        }),
      );
    if (method === 'POST' && path === '/api/deliveries/replay')
      return Promise.resolve(
        json({ result: { requested: 25, replayed: 24, alreadyInFlight: 1, refused: 0, remaining: 5 } }, 202),
      );
    if (method === 'POST' && /^\/api\/integrations\/[^/]+\/test$/.test(path)) {
      if (state.testSend === 'ok') return Promise.resolve(json({ deliveryId: TEST_DELIVERY_ID }, 202));
      if (state.testSend === 'in_flight')
        return Promise.resolve(json({ error: 'refused', reason: 'test_in_flight' }, 409));
      return Promise.resolve(
        json({ error: 'refused' }, state.testSend, state.testSend === 429 ? { 'retry-after': '42' } : {}),
      );
    }
    const patch = /^\/api\/integrations\/([^/]+)$/.exec(path);
    if (method === 'PATCH' && patch && Array.isArray(state.integrations)) {
      const current = (state.integrations as { id: string }[]).find((i) => i.id === patch[1]);
      if (!current) return Promise.resolve(json({ error: 'Not found' }, 404));
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
      const updated = { ...current, ...body };
      state.integrations = (state.integrations as { id: string }[]).map((i) =>
        i.id === patch[1] ? updated : i,
      );
      return Promise.resolve(json({ integration: updated }));
    }
    const revoke = /^\/api\/integrations\/([^/]+)\/revoke-credentials$/.exec(path);
    if (method === 'POST' && revoke) {
      const current = (state.integrations as { id: string }[]).find((i) => i.id === revoke[1]);
      if (!current) return Promise.resolve(json({ error: 'Not found' }, 404));
      // Like the server: stopped at once, the encrypted copy destroyed, the fingerprint kept.
      const revoked = { ...current, credentials: 'quarantined', revoked: true, keyDestroyed: true };
      state.integrations = (state.integrations as { id: string }[]).map((i) =>
        i.id === revoke[1] ? revoked : i,
      );
      return Promise.resolve(json({ integration: revoked }));
    }
    const revokeSource = /^\/api\/sources\/([^/]+)\/revoke-credentials$/.exec(path);
    if (method === 'POST' && revokeSource) {
      // Admin only, as the server enforces it.
      if (state.me !== 'unauthenticated' && state.me.user.role !== 'admin')
        return Promise.resolve(json({ error: 'Missing capability: source.revoke' }, 403));
      if (state.sources === 'error') return Promise.resolve(json({ error: 'boom' }, 500));
      const current = (state.sources as { id: string }[]).find((s) => s.id === revokeSource[1]);
      if (!current) return Promise.resolve(json({ error: 'Not found' }, 404));
      // Like the server: switched off at once and marked revoked; the key is destroyed after the drain window
      // by the credential sweep, so the response still says it is being destroyed. The fingerprint is kept.
      const revoked = { ...current, enabled: false, revoked: true, keyDestroyed: false };
      state.sources = (state.sources as { id: string }[]).map((s) =>
        s.id === revokeSource[1] ? revoked : s,
      );
      return Promise.resolve(json({ source: revoked }));
    }
    const rotateSource = /^\/api\/sources\/([^/]+)\/rotate$/.exec(path);
    if (method === 'POST' && rotateSource && Array.isArray(state.sources)) {
      const current = (state.sources as { id: string; kind: string }[]).find((s) => s.id === rotateSource[1]);
      if (!current) return Promise.resolve(json({ error: 'Not found' }, 404));
      // A new secret lifts a revoke and turns the source back on (ADR 0036).
      const rotated = { ...current, enabled: true, revoked: false, keyDestroyed: false };
      state.sources = (state.sources as { id: string }[]).map((s) =>
        s.id === rotateSource[1] ? rotated : s,
      );
      // Only a generic source gets a generated secret back; a provider's pasted credential is never returned.
      return Promise.resolve(
        json(current.kind === 'generic' ? { source: rotated, secret: fixtureSecret() } : { source: rotated }),
      );
    }
    if (method === 'POST' && path === '/api/integrations') {
      const created = { ...INTEGRATIONS[0], id: 'int_new', name: 'New integration' };
      // Later reads of the new id find it, as they would against the real API.
      if (Array.isArray(state.integrations)) state.integrations = [created, ...state.integrations];
      return Promise.resolve(json({ integration: created }, 201));
    }
    if (method === 'POST' && path === '/api/sources')
      return Promise.resolve(
        json(
          {
            source: { ...SOURCES[1], id: 'src_new', name: 'New source', enabled: true },
            secret: fixtureSecret(),
          },
          201,
        ),
      );
    unhandled.push(`${method} ${path}`);
    return Promise.resolve(json({ error: 'not mocked' }, 404));
  });
}

// --- Rendering ------------------------------------------------------------------------------

export interface RenderedApp extends RenderResult {
  readonly router: ReturnType<typeof buildRouter>;
  /** The mock server's live state: a test changes it to play "another tab" or a server fault. */
  readonly api: ApiState;
}

export interface RenderOptions {
  readonly api?: Partial<ApiState>;
  readonly locale?: Locale;
}

/** Mount the real routes at `path` against the mock API and wait for the first route to load. */
export async function renderApp(path: string, options: RenderOptions = {}): Promise<RenderedApp> {
  setLocale(options.locale ?? 'en', { persist: false });
  // Pages such as /invite and /verify read the query string from `window.location`.
  window.history.replaceState(null, '', path);
  const api: ApiState = { ...defaultApi(), ...options.api };
  installFetch(api);
  const router = buildRouter(path);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await router.load();
  const result = render(
    <QueryClientProvider client={client}>
      <LocaleProvider>
        <RouterProvider router={router} />
      </LocaleProvider>
    </QueryClientProvider>,
  );
  return Object.assign(result, { router, api });
}

export { ORG_ID };
