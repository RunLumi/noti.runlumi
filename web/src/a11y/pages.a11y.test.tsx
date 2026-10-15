// @vitest-environment jsdom
import './testing/environment';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { audit, describeViolations } from './testing/axe';
import {
  MEMBER,
  MULTI,
  NO_WORKSPACE,
  SETUP_BLOCKED,
  SETUP_DONE,
  SETUP_GITHUB_DONE,
  SETUP_PROGRESS,
} from './testing/fixtures';
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
    name: 'sign up (by invitation only)',
    path: '/signup',
    options: { api: { signupMode: 'invite_only' } },
    ready: text(/Sign-up is by invitation|Chỉ đăng ký được khi có lời mời/),
  },
  {
    name: 'sign up (from an invitation link)',
    path: '/signup?invite=inv_1',
    options: { api: { signupMode: 'invite_only' } },
    ready: text(/signing up from an invitation|đăng ký từ một lời mời/),
  },
  {
    name: 'sign up (closed)',
    path: '/signup',
    options: { api: { signupMode: 'closed' } },
    ready: text(/New accounts are not being created|Hiện không tạo tài khoản mới/),
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
    name: 'integration settings (filters and recent decisions)',
    path: '/integrations/int_5',
    ready: () => screen.findByText(/Recent decisions|Các quyết định gần đây/),
  },
  {
    name: 'integration settings (quiet hours, combining with "send at least every", summaries and waiting updates)',
    path: '/integrations/int_6',
    ready: () => screen.findByText(/3 updates are waiting|3 cập nhật đang chờ/),
  },
  {
    name: 'integration settings (routes from a source)',
    path: '/integrations/int_4',
    ready: () => screen.findByRole('heading', { level: 1, name: 'Deploy alerts' }),
  },
  { name: 'sources list', path: '/sources', ready: text('CI pipeline') },
  {
    name: 'sources empty',
    path: '/sources',
    options: { api: { sources: [] } },
    ready: () => screen.findByRole('heading', { name: /No sources yet|Chưa có nguồn nào/ }),
  },
  {
    name: 'sources error',
    path: '/sources',
    options: { api: { sources: 'error' } },
    ready: () => screen.findByRole('alert'),
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
  {
    name: 'audit log (admin)',
    path: '/audit',
    ready: () => screen.findByRole('table', { name: /Audit events|Các sự kiện kiểm toán/ }),
  },
  {
    name: 'audit log (filtered by URL)',
    path: '/audit?action=access.denied&outcome=denied&from=2026-10-01&to=2026-10-31',
    ready: () => screen.findByRole('table', { name: /Audit events|Các sự kiện kiểm toán/ }),
  },
  {
    name: 'audit log (actor, target and request filters, with a field diff)',
    path: '/audit?actor=user_9&target=int_1&targetType=integration&correlationId=req_8f3a2c91',
    ready: () => screen.findByRole('table', { name: /Audit events|Các sự kiện kiểm toán/ }),
  },
  {
    name: 'audit log empty',
    path: '/audit',
    options: { api: { audit: [] } },
    ready: () => screen.findByRole('heading', { name: /No events yet|Chưa có sự kiện nào/ }),
  },
  {
    name: 'audit log error',
    path: '/audit',
    options: { api: { audit: 'error' } },
    ready: () => screen.findByRole('alert'),
  },
  {
    name: 'audit log (member, not allowed)',
    path: '/audit',
    options: { api: { me: { user: { ...MEMBER.user, organizations: [...MULTI.user.organizations] } } } },
    ready: () => screen.findByRole('heading', { name: /Only admins can read|Chỉ quản trị viên mới đọc/ }),
  },
  {
    name: 'overview (several workspaces)',
    path: '/',
    options: { api: { me: MULTI } },
    ready: () => screen.findByRole('button', { name: /Switch workspace|Chuyển không gian làm việc/ }),
  },
  {
    name: 'create another workspace',
    path: '/onboarding',
    options: { api: { me: MULTI } },
    ready: () => screen.findByRole('heading', { name: /Create another workspace|Tạo thêm một không gian/ }),
  },
  {
    name: 'setup resumes at the step the server names',
    path: '/setup',
    ready: () => screen.findByRole('heading', { level: 1, name: /Send a test|Gửi thử/ }),
  },
  {
    name: 'setup: GitHub step, server has no GitHub App (blocked)',
    path: '/setup/github',
    options: { api: { setup: SETUP_BLOCKED, githubConfigured: false, installations: [] } },
    ready: text(/can’t be connected on this server yet|chưa kết nối được GitHub/),
  },
  {
    name: 'setup: GitHub step, connected account shown',
    path: '/setup/github',
    options: { api: { setup: SETUP_GITHUB_DONE } },
    ready: () => screen.findByText(/Connected the wrong account|Kết nối nhầm tài khoản/),
  },
  {
    name: 'setup: repository step',
    path: '/setup/repository',
    options: { api: { setup: SETUP_GITHUB_DONE } },
    ready: () => screen.findByLabelText(/GitHub repository|Repository GitHub/),
  },
  {
    name: 'setup: destination step without a repository chosen (prerequisite)',
    path: '/setup/destination',
    options: { api: { setup: SETUP_GITHUB_DONE } },
    ready: text(/comes after another one|đến sau một bước khác/),
  },
  {
    name: 'setup: destination step, integration already saved',
    path: '/setup/destination',
    ready: () => screen.findByText(/What .* can show|có thể hiển thị gì/),
  },
  {
    name: 'setup: events step',
    path: '/setup/events',
    ready: () => screen.findByRole('button', { name: /Keep these and continue|Giữ nguyên và tiếp tục/ }),
  },
  {
    name: 'setup: test step',
    path: '/setup/test',
    ready: () => screen.findByRole('button', { name: /Send a test notification|Gửi thông báo thử/ }),
  },
  {
    name: 'setup: final step (complete)',
    path: '/setup/done',
    options: { api: { setup: SETUP_DONE } },
    ready: text(/You’re set up|Bạn đã thiết lập xong/),
  },
  {
    name: 'setup: final step (unfinished)',
    path: '/setup/done',
    options: { api: { setup: SETUP_PROGRESS } },
    ready: text(/isn’t finished yet|chưa xong/),
  },
  {
    name: 'setup: progress cannot load',
    path: '/setup/test',
    options: { api: { setup: 'error' } },
    ready: () => screen.findByRole('alert'),
  },
  {
    name: 'page not found, inside the shell',
    path: '/no-such-page',
    ready: heading(/We can’t find that page|Không tìm thấy trang này/),
  },
  { name: 'team (admin)', path: '/team', ready: text('Minh Tran') },
  {
    name: 'team (admin, nothing pending)',
    path: '/team',
    options: { api: { invitations: [] } },
    ready: text(/No pending invitations|Không có lời mời đang chờ/),
  },
  {
    name: 'team (admin, pending list unavailable)',
    path: '/team',
    options: { api: { invitations: 'error' } },
    ready: text(/We couldn’t load the pending invitations\.|Chúng tôi không tải được các lời mời đang chờ\./),
  },
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
  it('mirrors the file routes in web/src/routes exactly, so a new route cannot skip the audit', () => {
    const dir = join(__dirname, '..', 'routes');
    const declared = readdirSync(dir)
      .filter((file) => file.endsWith('.tsx') && !file.startsWith('__'))
      .flatMap((file) =>
        [...readFileSync(join(dir, file), 'utf8').matchAll(/createFileRoute\('([^']+)'\)/g)].map((m) => {
          const path = m[1] ?? '';
          // `/integrations/` is the index route of a folder-less path: the URL is `/integrations`.
          return path.length > 1 ? path.replace(/\/$/, '') : path;
        }),
      );
    expect([...declared].sort()).toEqual([...ROUTE_PATHS].sort());
  });

  it('scans every route with at least one scenario', () => {
    const scanned = new Set(SCENARIOS.map((s) => s.path.split('?')[0]));
    for (const path of ROUTE_PATHS)
      expect(
        scanned.has(path.replace('$id', 'int_1').replace('$step', 'github')),
        `no axe scenario for ${path}`,
      ).toBe(true);
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
