import type { MessageId } from '../i18n';

/**
 * Who may open which page, as data (spec 14 F205). The shell reads this list instead of an
 * array of exact paths, so adding a route means adding one row here; a test fails if a file
 * route has no row, and if a navigation item points at an undeclared route.
 *
 *  - `public`: reachable signed out (sign-in, sign-up, password reset, invitations, which handle
 *    their own sign-in step).
 *  - `authenticated`: needs a session; a signed-out visitor is sent to sign in and brought back.
 *  - `admin`: authenticated, and only admins are offered it. The server enforces the capability
 *    on every call; this list decides what the navigation shows and which pages explain
 *    themselves to a member.
 *
 * A path that matches no row is not an error page the server made: it is "unknown", and the
 * shell answers it with its own 404 instead of redirecting somewhere unrelated.
 */
export type Access = 'public' | 'authenticated' | 'admin';

export interface RouteRule {
  /** Path of the route, without a trailing slash (the root is `/`). */
  readonly path: string;
  /** `prefix` also matches everything beneath the path (`/integrations/int_1`). */
  readonly match: 'exact' | 'prefix';
  readonly access: Access;
}

export const ROUTE_RULES: readonly RouteRule[] = [
  { path: '/signin', match: 'exact', access: 'public' },
  { path: '/signup', match: 'exact', access: 'public' },
  { path: '/forgot-password', match: 'exact', access: 'public' },
  { path: '/verify', match: 'exact', access: 'public' },
  { path: '/reset', match: 'exact', access: 'public' },
  { path: '/invite', match: 'exact', access: 'public' },
  { path: '/onboarding', match: 'exact', access: 'authenticated' },
  { path: '/', match: 'exact', access: 'authenticated' },
  { path: '/setup', match: 'prefix', access: 'authenticated' },
  { path: '/integrations', match: 'prefix', access: 'authenticated' },
  { path: '/sources', match: 'exact', access: 'authenticated' },
  { path: '/activity', match: 'exact', access: 'authenticated' },
  { path: '/team', match: 'exact', access: 'authenticated' },
  { path: '/audit', match: 'exact', access: 'admin' },
  { path: '/settings', match: 'exact', access: 'authenticated' },
];

const trimmed = (pathname: string): string => (pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname);

/** The access class of `pathname`, or `null` when no route is declared for it. */
export function accessFor(pathname: string): Access | null {
  const path = trimmed(pathname);
  const rule = ROUTE_RULES.find((r) =>
    r.match === 'exact' ? r.path === path : path === r.path || path.startsWith(`${r.path}/`),
  );
  return rule?.access ?? null;
}

/** True for pages drawn inside the application shell (sidebar, breadcrumbs). */
export function isShellRoute(pathname: string): boolean {
  const access = accessFor(pathname);
  return access === 'authenticated' || access === 'admin';
}

export type Role = 'admin' | 'member' | null;

/** Whether a person with `role` is offered a page of this access class. */
export function mayOpen(access: Access, role: Role): boolean {
  return access !== 'admin' || role === 'admin';
}

export interface NavEntry {
  readonly to: '/' | '/integrations' | '/sources' | '/activity' | '/team' | '/audit' | '/settings';
  readonly label: MessageId;
}

/** The primary navigation, in order. Each entry's access class comes from `ROUTE_RULES`. */
export const NAV_ENTRIES: readonly NavEntry[] = [
  { to: '/', label: 'nav.overview' },
  { to: '/integrations', label: 'nav.integrations' },
  { to: '/sources', label: 'sources.nav' },
  { to: '/activity', label: 'nav.activity' },
  { to: '/team', label: 'nav.team' },
  { to: '/audit', label: 'nav.audit' },
  { to: '/settings', label: 'nav.settings' },
];

/** What a person with `role` sees in the navigation; admin-only entries are left out for a member. */
export function visibleNav(role: Role): readonly NavEntry[] {
  return NAV_ENTRIES.filter((entry) => mayOpen(accessFor(entry.to) ?? 'authenticated', role));
}
