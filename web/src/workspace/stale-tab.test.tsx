// @vitest-environment jsdom
import '../a11y/testing/environment';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { audit, describeViolations } from '../a11y/testing/axe';
import { INTEGRATIONS, MEMBERS, MULTI, NO_WORKSPACE, ORG_ID, OTHER_ORG_ID } from '../a11y/testing/fixtures';
import { clearRequests, renderApp, requests, type ApiState } from '../a11y/testing/render';
import type { Me } from '../lib/api';

/**
 * Another tab switches the session's active workspace while this tab sits on a form. The form
 * must not write into the workspace that is now active, and the person must be told.
 */
afterEach(cleanup);
beforeEach(clearRequests);

const orgs: NonNullable<ApiState['orgs']> = {
  [ORG_ID]: { integrations: [...INTEGRATIONS], deliveries: [], members: [...MEMBERS], audit: [] },
  [OTHER_ORG_ID]: { integrations: [], deliveries: [], members: [...MEMBERS], audit: [] },
};

/** What `me` says after another tab made `orgId` the active workspace. */
function switchedElsewhere(me: Me, orgId: string): Me {
  const target = me.user.organizations.find((o) => o.orgId === orgId);
  return {
    user: {
      ...me.user,
      org_id: orgId,
      activeOrgId: orgId,
      org_name: target?.name ?? null,
      role: target?.role === 'admin' ? 'admin' : 'member',
    },
  };
}

function otherTabSwitches(app: Awaited<ReturnType<typeof renderApp>>, orgId: string) {
  if (app.api.me === 'unauthenticated') throw new Error('signed out');
  app.api.me = switchedElsewhere(app.api.me, orgId);
  // The person comes back to this tab: it refetches `me`.
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
}

describe('a change of active workspace made in another tab', () => {
  it('tells the person, announces it as an alert, and drops the old workspace’s data', async () => {
    const app = await renderApp('/team', { api: { me: MULTI, orgs } });
    await screen.findByText('Minh Tran');
    otherTabSwitches(app, OTHER_ORG_ID);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Workspace changed in another tab');
    expect(alert.textContent).toContain('Bao Retail');
    const { blocking } = await audit();
    expect(blocking, describeViolations(blocking)).toEqual([]);
    // from here on this tab asks only for the workspace now shown
    const after = requests.slice(requests.lastIndexOf('GET /api/workspace/me') + 1);
    expect(after.filter((r) => r.includes(`org=${ORG_ID}`))).toEqual([]);
  });

  it('turns off a form bound to the old workspace and sends nothing', async () => {
    const user = userEvent.setup();
    const app = await renderApp('/sources', { api: { me: MULTI, orgs } });
    const name = await screen.findByLabelText('Source name');
    await user.type(name, 'Typed for Acme');
    otherTabSwitches(app, OTHER_ORG_ID);
    await screen.findByText('Workspace changed in another tab');
    const submit = screen.getByRole('button', { name: 'Create source' });
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    expect(
      screen.getAllByRole('alert').some((a) => /turned off to stop it saving/.test(a.textContent ?? '')),
    ).toBe(true);
    clearRequests();
    await user.click(submit);
    expect(requests.filter((r) => r.startsWith('POST'))).toEqual([]);
  });

  it('a form that was bound before the change still names its own workspace', async () => {
    const user = userEvent.setup();
    const app = await renderApp('/sources', { api: { me: MULTI, orgs } });
    await user.type(await screen.findByLabelText('Source name'), 'Valid name');
    // No change elsewhere: the write names the workspace the form was opened for.
    await user.click(screen.getByRole('button', { name: 'Create source' }));
    await waitFor(() => expect(requests.some((r) => r.startsWith('POST /api/sources?org='))).toBe(true));
    expect(requests.find((r) => r.startsWith('POST /api/sources'))).toBe(`POST /api/sources?org=${ORG_ID}`);
    expect(app.api.me).not.toBe('unauthenticated');
  });

  it('does not report this tab’s own switch as a change elsewhere', async () => {
    const user = userEvent.setup();
    await renderApp('/team', { api: { me: MULTI, orgs } });
    await screen.findByText('Minh Tran');
    await user.click(await screen.findByRole('button', { name: /Switch workspace/ }));
    await user.click(await screen.findByRole('menuitemradio', { name: /Bao Retail/ }));
    await screen.findByText('Bao Retail', { selector: 'b' });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() =>
      expect(requests.filter((r) => r === 'GET /api/workspace/me').length).toBeGreaterThan(1),
    );
    expect(screen.queryByText('Workspace changed in another tab')).toBeNull();
  });

  it('leaves a detail page that belonged to the old workspace', async () => {
    const app = await renderApp('/integrations/int_1', { api: { me: MULTI, orgs } });
    await screen.findByRole('heading', { level: 1, name: 'Website builds' });
    otherTabSwitches(app, OTHER_ORG_ID);
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/integrations'));
  });

  it('shows the alert in Vietnamese', async () => {
    const app = await renderApp('/team', { api: { me: MULTI, orgs }, locale: 'vi' });
    await screen.findByText('Minh Tran');
    otherTabSwitches(app, OTHER_ORG_ID);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Không gian làm việc đã đổi ở một tab khác',
    );
  });
});

describe('creating and joining a workspace', () => {
  it('create succeeds but activation fails: carries on, never invites a retry', async () => {
    const user = userEvent.setup();
    const app = await renderApp('/onboarding', { api: { me: NO_WORKSPACE, failActivate: true } });
    await user.type(await screen.findByLabelText('Organization name'), 'First Shop');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/'));
    expect(requests.filter((r) => r === 'POST /api/auth/organization/create')).toHaveLength(1);
    expect(requests).toContain('POST /api/workspace/active');
    expect(screen.queryByText(/Could not create workspace/)).toBeNull();
  });

  it('a person already in a workspace can accept an invitation and lands in the new one', async () => {
    const user = userEvent.setup();
    const app = await renderApp('/invite?id=inv_1', {
      api: { me: MULTI, orgs, invitation: { orgId: 'org_invited', name: 'Invited Co', role: 'member' } },
    });
    await user.click(await screen.findByRole('button', { name: 'Accept invitation' }));
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/'));
    expect(requests).toContain('POST /api/workspace/active');
    expect(await screen.findByRole('button', { name: /Invited Co, Member\. Switch workspace/ })).toBeTruthy();
    expect(screen.queryByText(/already belong to an organization/)).toBeNull();
  });
});
