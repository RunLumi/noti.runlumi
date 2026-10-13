import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRouter, createRootRoute, createRoute } from '@tanstack/react-router';
import {
  AppShell,
  Overview,
  Integrations,
  Activity,
  Team,
  Settings,
  AuthPage,
  VerifyPage,
  ResetPage,
} from './pages';
import { OnboardingPage, InvitePage } from './onboarding';
import '@fontsource-variable/geist';
import './styles.css';
const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000 } } });
const root = createRootRoute({ component: AppShell });
const routes = [
  createRoute({ getParentRoute: () => root, path: '/', component: Overview }),
  createRoute({ getParentRoute: () => root, path: '/integrations', component: Integrations }),
  createRoute({ getParentRoute: () => root, path: '/onboarding', component: OnboardingPage }),
  createRoute({ getParentRoute: () => root, path: '/invite', component: InvitePage }),
  createRoute({ getParentRoute: () => root, path: '/activity', component: Activity }),
  createRoute({ getParentRoute: () => root, path: '/team', component: Team }),
  createRoute({ getParentRoute: () => root, path: '/settings', component: Settings }),
  createRoute({ getParentRoute: () => root, path: '/signin', component: () => <AuthPage mode="signin" /> }),
  createRoute({ getParentRoute: () => root, path: '/signup', component: () => <AuthPage mode="signup" /> }),
  createRoute({
    getParentRoute: () => root,
    path: '/forgot-password',
    component: () => <AuthPage mode="forgot" />,
  }),
  createRoute({ getParentRoute: () => root, path: '/verify', component: VerifyPage }),
  createRoute({ getParentRoute: () => root, path: '/reset', component: ResetPage }),
];
const tree = root.addChildren(routes);
const router = createRouter({ routeTree: tree, defaultPreload: 'intent' });
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing app root');
createRoot(rootElement).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
