// @vitest-environment jsdom
import './testing/environment';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { audit, describeViolations } from './testing/axe';
import { MEMBER, NO_WORKSPACE } from './testing/fixtures';
import { ROUTE_PATHS, renderApp, unhandled, type RenderOptions } from './testing/render';
import type { Locale } from '../i18n/locale';

/**
 * Every route, in the states a person can reach without interacting, scanned with axe-core:
 * zero serious or critical violations in English and in Vietnamese (F221). "Rendered" means a
 * real route tree against a mock API, so loading, empty, error and populated states are the
 * production components, not stand-ins. See `testing/axe.ts` for what jsdom cannot check.
 */
interface Scenario {
  readonly name: string;
  readonly path: string;
  readonly options?: RenderOptions;
  /** Resolves when the state under test is on screen, so axe never scans a spinner. */
  readonly ready: () => Promise<unknown>;
}

const heading = (name: RegExp | string) => () => screen.findByRole('heading', { level: 1, name });
const text = (value: RegExp | string) => () => screen.findByText(value);

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'sign in',
    path: '/signin',
    ready: () => screen.findByRole('button', { name: /^(Sign in|Đăng nhập)$/ }),
  },
  {
    name: 'sign up',
    path: '/signup',
    ready: () => screen.findByRole('button', { name: /Create account|Tạo tài khoản/ }),
  },
  {
    name: 'forgot password',
    path: '/forgot-password',
    ready: () => screen.findByRole('button', { name: /reset link|liên kết đặt lại/ }),
  },
  {
    name: 'verify email (no token)',
    path: '/verify',
    ready: text(/Missing verification token|Thiếu mã xác minh/),
  },
  {
    name: 'reset password',
    path: '/reset?token=abc',
    ready: () => screen.findByRole('button', { name: /Update password|Cập nhật mật khẩu/ }),
  },
  {
    name: 'invite (signed out)',
    path: '/invite?id=inv_1',
    options: { api: { me: 'unauthenticated' } },
    ready: () => screen.findByRole('link', { name: /Sign in to accept|Đăng nhập để chấp nhận/ }),
  },
  {
    name: 'invite (signed in)',
    path: '/invite?id=inv_1',
    options: { api: { me: NO_WORKSPACE } },
    ready: () => screen.findByRole('button', { name: /Accept invitation|Chấp nhận lời mời/ }),
  },
  { name: 'invite (no id)', path: '/invite', ready: text(/missing an ID|thiếu mã/) },
  {
    name: 'onboarding',
    path: '/onboarding',
    options: { api: { me: NO_WORKSPACE } },
    ready: () => screen.findByRole('button', { name: /Create workspace|Tạo không gian làm việc/ }),
  },
  { name: 'overview', path: '/', ready: () => screen.findByText(/Get started|Bắt đầu/) },
  { name: 'integrations list', path: '/integrations', ready: text('Website builds') },
  {
    name: 'integrations empty',
    path: '/integrations',
    options: { api: { integrations: [] } },
    ready: () => screen.findByRole('heading', { name: /No integrations yet|Chưa có tích hợp nào/ }),
  },
  {
    name: 'integrations error',
    path: '/integrations',
    options: { api: { integrations: 'error' } },
    ready: () => screen.findByRole('alert'),
  },
  {
    name: 'integration settings',
    path: '/integrations/int_1',
    ready: () => screen.findByRole('heading', { level: 1, name: 'Website builds' }),
  },
  {
    name: 'integration settings (credentials quarantined)',
    path: '/integrations/int_3',
    ready: () => screen.findByRole('heading', { level: 1, name: 'Mobile reviews' }),
  },
  {
    name: 'create wizard',
    path: '/integrations/new',
    ready: heading(/Set up an integration|Thiết lập một tích hợp/),
  },
  {
    name: 'create wizard (GitHub not connected)',
    path: '/integrations/new',
    options: { api: { installations: [] } },
    ready: heading(/Set up an integration|Thiết lập một tích hợp/),
  },
  { name: 'activity', path: '/activity', ready: () => screen.findByRole('table') },
  {
    name: 'activity empty',
    path: '/activity',
    options: { api: { deliveries: [] } },
    ready: () => screen.findByText(/No deliveries yet|Chưa có lượt gửi nào/),
  },
  {
    name: 'activity error',
    path: '/activity',
    options: { api: { deliveries: 'error' } },
    ready: () => screen.findByRole('alert'),
  },
  { name: 'team (admin)', path: '/team', ready: text('Minh Tran') },
  { name: 'team (member)', path: '/team', options: { api: { me: MEMBER } }, ready: text('Minh Tran') },
  { name: 'settings', path: '/settings', ready: text('Work laptop') },
];

afterEach(cleanup);
afterAll(() => expect(unhandled, 'a page requested an endpoint the mock does not serve').toEqual([]));

for (const locale of ['en', 'vi'] as const satisfies readonly Locale[]) {
  describe(`axe: no serious or critical violations (${locale})`, () => {
    for (const scenario of SCENARIOS) {
      it(scenario.name, async () => {
        await renderApp(scenario.path, { ...scenario.options, locale });
        await scenario.ready();
        const { blocking } = await audit();
        expect(blocking, describeViolations(blocking)).toEqual([]);
        expect(document.documentElement.lang).toBe(locale);
      });
    }
  });
}

describe('every scenario really shows its state', () => {
  it('has loaded past the loading screen (no "Loading your workspace" left)', async () => {
    await renderApp('/integrations');
    await screen.findByText('Website builds');
    await waitFor(() => expect(screen.queryByText(/Loading your workspace/)).toBeNull());
  });
});

describe('route coverage', () => {
  it('mirrors the routes in main.tsx exactly, so a new route cannot skip the audit', () => {
    const main = readFileSync(join(__dirname, '..', 'main.tsx'), 'utf8');
    const declared = [...main.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]);
    expect([...declared].sort()).toEqual([...ROUTE_PATHS].sort());
  });

  it('scans every route with at least one scenario', () => {
    const scanned = new Set(SCENARIOS.map((s) => s.path.split('?')[0]));
    for (const path of ROUTE_PATHS)
      expect(scanned.has(path.replace('$id', 'int_1')), `no axe scenario for ${path}`).toBe(true);
  });
});

describe('axe is live in this environment', () => {
  it('reports the classic failures on a deliberately broken page', async () => {
    document.body.innerHTML = '<img src="x.png"><button></button><input type="text">';
    const { blocking } = await audit();
    expect(blocking.map((v) => v.id).sort()).toEqual(['button-name', 'image-alt', 'label']);
    document.body.innerHTML = '';
  });
});
