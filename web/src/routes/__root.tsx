import { HeadContent, Scripts, createRootRoute, useHydrated } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { AppShell } from '../pages';
import { RootNotFound } from '../shell/NotFound';
import { useLocale } from '../i18n/LocaleProvider';
import '@fontsource-variable/geist';
import lumiMark from '../../../brand/lumi-logo.svg?url';
import appCss from '../styles.css?url';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1.0' },
      { name: 'theme-color', content: '#f4f0e8' },
      { title: 'Lumi Noti | Notifications that matter' },
      {
        name: 'description',
        content: 'Connect events across your tools and send useful notifications to your team.',
      },
    ],
    links: [
      { rel: 'icon', type: 'image/svg+xml', href: lumiMark },
      { rel: 'stylesheet', href: appCss },
    ],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
  notFoundComponent: RootNotFound,
});

/**
 * The prerendered document (`/_shell.html`) is the same for every URL, so it must not guess
 * which page the browser wants: it renders an empty paper-coloured screen, and the real app
 * mounts right after hydration. Showing "Loading your workspace" here would flash on the
 * sign-in page, and a different tree than the client's would fail hydration.
 */
function RootComponent() {
  useLocale();
  // `useHydrated` is false on the server and on the client's first render, true afterwards, so
  // both render the same empty screen and hydration matches. (`router.isShell()` is only set
  // on the server in Start 1.168, so it cannot be used to make the client's first render match.)
  const hydrated = useHydrated();
  return hydrated ? <AppShell /> : <div className="center-screen" />;
}

function RootDocument({ children }: { readonly children: ReactNode }) {
  useLocale();
  // The locale module sets the real `lang` before hydration (F224); the shell cannot know it.
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
