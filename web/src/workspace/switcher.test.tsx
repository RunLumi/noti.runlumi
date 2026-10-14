// @vitest-environment jsdom
import '../a11y/testing/environment';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { audit, describeViolations } from '../a11y/testing/axe';
import {
  ADMIN,
  INTEGRATIONS,
  MEMBERS,
  MULTI,
  NO_WORKSPACE,
  OTHER_ORG_ID,
  ORG_ID,
} from '../a11y/testing/fixtures';
import { clearRequests, renderApp, requests, type ApiState } from '../a11y/testing/render';
import { dropOtherWorkspaces } from './switching';

/**
 * The workspace switcher (ADR 0019) against the real shell and a mock API that serves
 * different data per `?org=`: a person in two workspaces, one, or none.
 */
afterEach(cleanup);
beforeEach(clearRequests);

const BAO_INTEGRATION = { ...INTEGRATIONS[0], id: 'int_bao', name: 'Bao shop alerts' };
const orgs: NonNullable<ApiState['orgs']> = {
  [ORG_ID]: { integrations: [...INTEGRATIONS], deliveries: [], members: [...MEMBERS], audit: [] },
  [OTHER_ORG_ID]: {
    integrations: [BAO_INTEGRATION],
    deliveries: [],
    members: [{ ...MEMBERS[0], id: 'm_bao', name: 'Bao Owner', email: 'owner@bao.test' }],
    audit: [],
  },
};

const trigger = () => screen.findByRole('button', { name: /Switch workspace/ });

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await trigger());
  return screen.findByRole('menu');
}

describe('with several workspaces', () => {
  it('names the current workspace and role on the control and lists every membership', async () => {
    const user = userEvent.setup();
    await renderApp('/', { api: { me: MULTI } });
    const button = await trigger();
    expect(button.getAttribute('aria-label')).toBe('Workspace: Acme Studio, Admin. Switch workspace');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');

    const menu = await openMenu(user);
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual(['Acme StudioAdmin', 'Bao RetailMember']);
    expect(items[0]?.getAttribute('aria-checked')).toBe('true');
    expect(items[1]?.getAttribute('aria-checked')).toBe('false');
    expect(within(menu).getByRole('menuitem', { name: 'Create workspace' })).toBeTruthy();
    const { blocking } = await audit();
    expect(blocking, describeViolations(blocking)).toEqual([]);
  });

  it('is operable from the keyboard and returns focus to the control on Escape', async () => {
    const user = userEvent.setup();
    await renderApp('/', { api: { me: MULTI } });
    const button = await trigger();
    button.focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it('switches with the keyboard, persists it, announces it, and shows the new workspace', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations', { api: { me: MULTI, orgs } });
    await screen.findByText('Website builds');
    const button = await trigger();
    button.focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');
    await user.keyboard('{ArrowDown}{Enter}');

    await screen.findByText('Bao shop alerts');
    expect(screen.queryByText('Website builds')).toBeNull();
    expect(requests).toContain('POST /api/workspace/active');
    expect((await screen.findByRole('button', { name: /Switch workspace/ })).getAttribute('aria-label')).toBe(
      'Workspace: Bao Retail, Member. Switch workspace',
    );
    const status = screen.getAllByRole('status').find((el) => /Switched to/.test(el.textContent ?? ''));
    expect(status?.textContent).toContain('Switched to Bao Retail. Your role here: Member.');
  });

  it('never asks for, or shows, the old workspace’s data after a switch', async () => {
    const user = userEvent.setup();
    await renderApp('/team', { api: { me: MULTI, orgs } });
    await screen.findByText('Minh Tran');
    await openMenu(user);
    await user.click(screen.getByRole('menuitemradio', { name: /Bao Retail/ }));
    await screen.findByText('Bao Owner');
    expect(screen.queryByText('Minh Tran')).toBeNull();

    const afterSwitch = requests.slice(requests.indexOf('POST /api/workspace/active') + 1);
    expect(afterSwitch.length).toBeGreaterThan(0);
    expect(afterSwitch.filter((r) => r.includes(`org=${ORG_ID}`))).toEqual([]);
    expect(afterSwitch.some((r) => r === `GET /api/workspace/team?org=${OTHER_ORG_ID}`)).toBe(true);
  });

  it('leaves a detail page that belongs to the old workspace', async () => {
    const user = userEvent.setup();
    const rendered = await renderApp('/integrations/int_1', { api: { me: MULTI, orgs } });
    await screen.findByRole('heading', { level: 1, name: 'Website builds' });
    await openMenu(user);
    await user.click(screen.getByRole('menuitemradio', { name: /Bao Retail/ }));
    await screen.findByText('Bao shop alerts');
    expect(rendered.router.state.location.pathname).toBe('/integrations');
  });

  it('opens the create-workspace page from the menu', async () => {
    const user = userEvent.setup();
    const rendered = await renderApp('/', { api: { me: MULTI } });
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Create workspace' }));
    await waitFor(() => expect(rendered.router.state.location.pathname).toBe('/onboarding'));
    // A person who already has a workspace is offered a way back, not a first-run page.
    expect(await screen.findByRole('heading', { name: 'Create another workspace' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to your workspace' })).toBeTruthy();
  });

  it('shows the switcher in Vietnamese', async () => {
    await renderApp('/', { api: { me: MULTI }, locale: 'vi' });
    const button = await screen.findByRole('button', { name: /Chuyển không gian làm việc/ });
    expect(button.getAttribute('aria-label')).toBe(
      'Không gian làm việc: Acme Studio, Quản trị viên. Chuyển không gian làm việc',
    );
  });
});

describe('creating another workspace', () => {
  it('creates it, makes it active through the server, and lands on it', async () => {
    const user = userEvent.setup();
    const rendered = await renderApp('/onboarding', { api: { me: MULTI } });
    await user.type(await screen.findByLabelText('Organization name'), 'Cua Hang Moi');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));
    await waitFor(() => expect(rendered.router.state.location.pathname).toBe('/'));
    const button = await screen.findByRole('button', { name: /Cua Hang Moi, Admin\. Switch workspace/ });
    expect(button).toBeTruthy();
    const create = requests.indexOf('POST /api/auth/organization/create');
    const active = requests.indexOf('POST /api/workspace/active');
    expect(create).toBeGreaterThan(-1);
    expect(active).toBeGreaterThan(create);
  });
});

describe('with one workspace', () => {
  it('collapses to a static label, with a way to create another', async () => {
    await renderApp('/', { api: { me: ADMIN } });
    await screen.findByText('Get started');
    expect(screen.queryByRole('button', { name: /Switch workspace/ })).toBeNull();
    expect(screen.getByText('Acme Studio')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Create another workspace' }).getAttribute('href')).toBe(
      '/onboarding',
    );
  });
});

describe('with no workspace', () => {
  it('has no switcher; the person is creating their first workspace', async () => {
    await renderApp('/onboarding', { api: { me: NO_WORKSPACE } });
    await screen.findByRole('heading', { name: 'Create your workspace' });
    expect(screen.queryByRole('button', { name: /Switch workspace/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Create another workspace' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Back to your workspace' })).toBeNull();
  });
});

describe('dropOtherWorkspaces', () => {
  it('keeps only the person’s own queries and the new workspace’s, and removes everything else', () => {
    const qc = new QueryClient();
    const keys = [
      ['me'],
      ['passkeys'],
      ['integrations', 'a', 'list'],
      ['deliveries', 'a', 'list', { state: 'sent' }],
      ['team', 'a'],
      ['audit', 'a', 'list', {}],
      ['github', 'a', 'connection'],
      ['workspace', 'a', 'deletion'],
      ['integrations', 'b', 'list'],
      ['unknown-shape'],
    ];
    for (const key of keys) qc.setQueryData(key, { rows: key.length });
    dropOtherWorkspaces(qc, 'b');
    expect(
      qc
        .getQueryCache()
        .getAll()
        .map((q) => q.queryKey),
    ).toEqual([['me'], ['passkeys'], ['integrations', 'b', 'list']]);
  });
});
