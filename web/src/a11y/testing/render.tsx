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
import { CreateWizard } from '../../integrations/wizard/CreateWizard';
import { IntegrationSettings } from '../../integrations/settings/IntegrationSettings';
import { validateActivitySearch } from '../../deliveries/search';
import { LocaleProvider } from '../../i18n/LocaleProvider';
import { setLocale, type Locale } from '../../i18n/locale';
import {
  ADMIN,
  DELIVERIES,
  INSTALLATIONS,
  INTEGRATIONS,
  MEMBERS,
  NOISE_STATUS,
  ORG_ID,
  PASSKEYS,
  ROUTING_LOG,
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
  '/sources',
  '/onboarding',
  '/invite',
  '/activity',
  '/team',
  '/settings',
  '/signin',
  '/signup',
  '/forgot-password',
  '/verify',
  '/reset',
] as const;

function buildRouter(initialPath: string) {
  const root = createRootRoute({ component: AppShell });
  const route = (path: string, component: () => ReactNode) =>
    createRoute({ getParentRoute: () => root, path, component });
  const tree = root.addChildren([
    route('/', Overview),
    route('/integrations', IntegrationsPage),
    route('/integrations/new', CreateWizard),
    route('/integrations/$id', IntegrationSettings),
    route('/sources', SourcesPage),
    route('/onboarding', OnboardingPage),
    route('/invite', InvitePage),
    createRoute({
      getParentRoute: () => root,
      path: '/activity',
      component: Activity,
      validateSearch: validateActivitySearch,
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
  deletion: unknown;
  /** `GET /api/setup/progress`; `'error'` makes it fail. */
  setup: unknown;
  /** Answer to `POST /api/integrations/:id/test`: accepted, or a failing status. */
  testSend: 'ok' | 'in_flight' | 409 | 429 | 500;
  /** The delivery a test creates, as `GET /api/deliveries/:id` reports it. */
  testDelivery: Record<string, unknown>;
}

export const defaultApi = (): ApiState => ({
  me: ADMIN,
  integrations: [...INTEGRATIONS],
  sources: [...SOURCES],
  deliveries: [...DELIVERIES],
  installations: [...INSTALLATIONS],
  githubConfigured: true,
  members: [...MEMBERS],
  passkeys: [...PASSKEYS],
  deletion: { scheduled: false },
  setup: SETUP_PROGRESS,
  testSend: 'ok',
  testDelivery: { state: 'sent' },
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

export function installFetch(state: ApiState): void {
  setFetchHandler((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://localhost',
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    if (method === 'GET') {
      if (path === '/api/workspace/me')
        return Promise.resolve(
          state.me === 'unauthenticated' ? json({ error: 'Sign in' }, 401) : json(state.me),
        );
      if (path === '/api/integrations')
        return Promise.resolve(
          state.integrations === 'error'
            ? json({ error: 'boom' }, 500)
            : json({ integrations: state.integrations, truncated: false }),
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
      if (/^\/api\/integrations\/[^/]+\/routing-log$/.test(path))
        return Promise.resolve(json({ entries: ROUTING_LOG, nextCursor: null }));
      const one = /^\/api\/integrations\/([^/]+)$/.exec(path);
      if (one && Array.isArray(state.integrations)) {
        const found = (state.integrations as { id: string }[]).find((i) => i.id === one[1]);
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
          state.deliveries === 'error'
            ? json({ error: 'boom' }, 500)
            : json({ deliveries: state.deliveries, nextCursor: null }),
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
            replays: [],
          }),
        );
      if (path === '/api/setup/progress')
        return Promise.resolve(state.setup === 'error' ? json({ error: 'boom' }, 500) : json(state.setup));
      const detail = /^\/api\/deliveries\/([^/]+)$/.exec(path);
      if (detail && Array.isArray(state.deliveries)) {
        const found = (state.deliveries as { id: string }[]).find((d) => d.id === detail[1]);
        return Promise.resolve(
          found
            ? json({
                delivery: found,
                timeline: [
                  { kind: 'created', at: '2026-10-13T08:00:00Z' },
                  { kind: 'last_attempt', at: '2026-10-13T08:01:00Z' },
                ],
                replays: [],
              })
            : json({ error: 'Not found' }, 404),
        );
      }
      if (path === '/api/workspace/team') return Promise.resolve(json({ members: state.members }));
      if (path === '/api/workspace/deletion') return Promise.resolve(json(state.deletion));
      if (path.endsWith('/passkey/list-user-passkeys')) return Promise.resolve(json(state.passkeys));
    }
    if (method === 'POST' && /^\/api\/integrations\/[^/]+\/test$/.test(path)) {
      if (state.testSend === 'ok') return Promise.resolve(json({ deliveryId: TEST_DELIVERY_ID }, 202));
      if (state.testSend === 'in_flight')
        return Promise.resolve(json({ error: 'refused', reason: 'test_in_flight' }, 409));
      return Promise.resolve(
        json({ error: 'refused' }, state.testSend, state.testSend === 429 ? { 'retry-after': '42' } : {}),
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
  installFetch({ ...defaultApi(), ...options.api });
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
  return Object.assign(result, { router });
}

export { ORG_ID };
