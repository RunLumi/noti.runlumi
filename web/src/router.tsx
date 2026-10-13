import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { LocaleProvider } from './i18n/LocaleProvider';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000 } } });
  return createRouter({
    routeTree,
    defaultPreload: 'intent',
    scrollRestoration: true,
    Wrap: function Wrap({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={qc}>
          <LocaleProvider>{children}</LocaleProvider>
        </QueryClientProvider>
      );
    },
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
