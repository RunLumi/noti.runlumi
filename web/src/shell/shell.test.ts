import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '../i18n';
import { crumbsFor } from './crumbs';
import { NAV_ENTRIES, ROUTE_RULES, accessFor, isShellRoute, mayOpen, visibleNav } from './route-guard';
import { returnToFor, safeReturnTo } from './return-to';

const ORIGIN = 'https://noti.test';

describe('route guard list', () => {
  it('classifies public, authenticated and admin pages', () => {
    expect(accessFor('/signin')).toBe('public');
    expect(accessFor('/invite')).toBe('public');
    expect(accessFor('/')).toBe('authenticated');
    expect(accessFor('/integrations/int_1')).toBe('authenticated');
    expect(accessFor('/setup/destination')).toBe('authenticated');
    expect(accessFor('/audit')).toBe('admin');
    expect(accessFor('/audit/')).toBe('admin');
  });

  it('answers unknown addresses with null (the 404), not a guess', () => {
    expect(accessFor('/nope')).toBeNull();
    expect(accessFor('/integrationsfoo')).toBeNull();
    expect(accessFor('/team/extra')).toBeNull();
    expect(isShellRoute('/nope')).toBe(false);
  });

  it('has a rule for every file route, so a new route cannot skip the guard', () => {
    const dir = join(__dirname, '..', 'routes');
    const paths = readdirSync(dir)
      .filter((f) => f.endsWith('.tsx') && !f.startsWith('__'))
      .flatMap((f) =>
        [...readFileSync(join(dir, f), 'utf8').matchAll(/createFileRoute\('([^']+)'\)/g)].map((m) =>
          (m[1] ?? '')
            .replace('$id', 'x')
            .replace('$step', 'x')
            .replace(/(.)\/$/, '$1'),
        ),
      );
    expect(paths.length).toBeGreaterThan(10);
    for (const path of paths) expect(accessFor(path), path).not.toBeNull();
  });

  it('keeps rules unique', () => {
    expect(new Set(ROUTE_RULES.map((r) => r.path)).size).toBe(ROUTE_RULES.length);
  });

  it('every navigation item resolves to a declared route with a label', () => {
    for (const entry of NAV_ENTRIES) {
      expect(accessFor(entry.to), entry.to).not.toBeNull();
      expect(en[entry.label]).toBeTruthy();
    }
  });

  it('hides admin-only entries from members and offers them to admins', () => {
    expect(visibleNav('member').map((e) => e.to)).not.toContain('/audit');
    expect(visibleNav(null).map((e) => e.to)).not.toContain('/audit');
    expect(visibleNav('admin').map((e) => e.to)).toContain('/audit');
    expect(mayOpen('admin', 'member')).toBe(false);
    expect(mayOpen('authenticated', 'member')).toBe(true);
  });
});

describe('returnTo is open-redirect safe', () => {
  it.each([
    ['/integrations/int_1', '/integrations/int_1'],
    ['/activity?state=dead_lettered&integration=i1', '/activity?state=dead_lettered&integration=i1'],
    ['/invite?id=inv_1', '/invite?id=inv_1'],
    ['/setup/test#x', '/setup/test#x'],
  ])('follows %s', (input, expected) => expect(safeReturnTo(input, ORIGIN)).toBe(expected));

  it.each([
    ['//evil.example', 'protocol-relative'],
    ['https://evil.example/', 'absolute'],
    ['http://noti.test/', 'absolute even to the same host'],
    ['javascript:alert(1)', 'a script URL'],
    ['/\\evil.example', 'a backslash spelling'],
    ['\\\\evil.example', 'backslashes'],
    ['/\t/evil.example', 'a tab the parser would strip'],
    ['/%0d%0a', 'fine path but encoded control is kept inert'],
    ['', 'empty'],
    ['evil', 'not rooted'],
    ['/signin', 'a sign-in loop'],
    ['/signin?returnTo=/x', 'a sign-in loop with query'],
    [`/${'a'.repeat(3000)}`, 'too long'],
  ])('refuses %s (%s)', (input, why) => {
    const out = safeReturnTo(input, ORIGIN);
    if (why.startsWith('fine path')) expect(out).toBe('/%0d%0a');
    else expect(out, why).toBeNull();
  });

  it('refuses non-strings and never returns the raw input', () => {
    expect(safeReturnTo(null, ORIGIN)).toBeNull();
    expect(safeReturnTo(['/x'], ORIGIN)).toBeNull();
    expect(safeReturnTo('/a/../b', ORIGIN)).toBe('/b');
  });

  it('builds a returnTo from the page the visitor was on, and none for the Overview', () => {
    expect(returnToFor({ pathname: '/integrations/i1', search: '?created=true' })).toBe(
      '/integrations/i1?created=true',
    );
    expect(returnToFor({ pathname: '/', search: '' })).toBeNull();
  });
});

describe('breadcrumbs', () => {
  it('has one crumb for a top-level page', () => {
    expect(crumbsFor('/activity')).toEqual([{ label: 'route.title.activity', to: null }]);
  });
  it('links the section on nested pages and marks the page current', () => {
    expect(crumbsFor('/integrations/new')).toEqual([
      { label: 'route.title.integrations', to: '/integrations' },
      { label: 'route.title.integrationNew', to: null },
    ]);
    const integration = crumbsFor('/integrations/int_9');
    expect(integration[0]?.to).toBe('/integrations');
    expect(integration[1]).toMatchObject({ to: null, integrationId: 'int_9' });
    expect(crumbsFor('/setup/destination')[0]).toEqual({ label: 'route.title.setup', to: '/setup' });
  });
});
