// @vitest-environment jsdom
import '../a11y/testing/environment';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INTEGRATIONS, MEMBER, ORG_ID } from '../a11y/testing/fixtures';
import { clearRequests, renderApp, requests } from '../a11y/testing/render';

/**
 * The deep-linkable detail pages and the Destinations health page (ADR 0056): each loads cold at its own address
 * (a reload), is behind the declarative guard, answers an id the workspace does not hold with the shell's 404
 * (the server's 404 is the same for "deleted" and "another workspace's", and the page never says which), and keeps
 * its breadcrumb. The axe scans of these routes are in `a11y/pages.a11y.test.tsx`, in English and Vietnamese.
 */
afterEach(cleanup);
beforeEach(clearRequests);

const notFound = () => screen.findByRole('heading', { level: 1, name: 'We can’t find that page' });
const crumbs = () => screen.getByRole('navigation', { name: 'Breadcrumb' });

describe('delivery page /activity/:deliveryId', () => {
  it('loads cold from the URL alone, with the dialog’s content and a breadcrumb back to Activity', async () => {
    const app = await renderApp('/activity/del_3');
    await screen.findByRole('heading', { level: 1, name: 'Delivery to Website builds' });
    // From `GET /api/deliveries/:id` for this workspace, not from a list that happened to be loaded.
    expect(requests).toContain(`GET /api/deliveries/del_3?org=${ORG_ID}`);
    expect(requests.some((r) => r.startsWith('GET /api/deliveries?'))).toBe(false);
    // The same body as the dialog: sections under the page heading, one level down.
    expect(screen.getByRole('heading', { level: 2, name: 'What happened' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Redelivery' })).toBeTruthy();
    expect(screen.getByText('req_7Hq2mX9pLk')).toBeTruthy();
    const trail = within(crumbs());
    expect(trail.getByRole('link', { name: 'Activity' }).getAttribute('href')).toBe('/activity');
    expect(trail.getByText('Delivery').getAttribute('aria-current')).toBe('page');
    expect(document.title).toBe('Delivery · Lumi Noti');
    // The Activity item stays the selected section in the navigation.
    const nav = within(screen.getByRole('navigation', { name: 'Main navigation' }));
    expect(nav.getByRole('link', { name: 'Activity' }).className).toContain('selected');
    expect(app.router.state.location.pathname).toBe('/activity/del_3');
  });

  it('answers an id this workspace does not hold with the shell 404, revealing nothing about it', async () => {
    await renderApp('/activity/del_elsewhere');
    await notFound();
    expect(requests).toContain(`GET /api/deliveries/del_elsewhere?org=${ORG_ID}`);
    // Still inside the shell, so the person can get out; the id is not echoed back.
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('del_elsewhere');
  });

  it('sends a signed-out visitor to sign in and brings them back to the same delivery', async () => {
    const app = await renderApp('/activity/del_3', { api: { me: 'unauthenticated' } });
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/signin'));
    expect(new URLSearchParams(app.router.state.location.searchStr).get('returnTo')).toBe('/activity/del_3');
    expect(requests.some((r) => r.startsWith('GET /api/deliveries/'))).toBe(false);
  });

  it('is reached from the Activity dialog through a real link', async () => {
    const user = userEvent.setup();
    const app = await renderApp('/activity');
    const table = await screen.findByRole('table');
    await user.click(
      within(table).getByRole('button', { name: /Details for the delivery to Website builds, Failed/ }),
    );
    const dialog = await screen.findByRole('dialog');
    const link = within(dialog).getByRole('link', { name: 'Open as a page' });
    expect(link.getAttribute('href')).toBe('/activity/del_3');
    await user.click(link);
    await screen.findByRole('heading', { level: 1, name: 'Delivery to Website builds' });
    expect(app.router.state.location.pathname).toBe('/activity/del_3');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('moves to the first delivery’s own page when a repeat links to it', async () => {
    const user = userEvent.setup();
    const app = await renderApp('/activity/del_6');
    await screen.findByRole('heading', { level: 1, name: 'Delivery to Website builds' });
    await user.click(screen.getByRole('button', { name: 'Show the first delivery' }));
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/activity/del_3'));
    await screen.findByText('req_7Hq2mX9pLk');
  });
});

describe('source page /sources/:sourceId', () => {
  it('loads cold, names the source in the heading and the breadcrumb, and shows the same card', async () => {
    await renderApp('/sources/src_1');
    await screen.findByRole('heading', { level: 1, name: 'CI pipeline' });
    expect(requests).toContain(`GET /api/sources/src_1?org=${ORG_ID}`);
    const trail = within(crumbs());
    expect(trail.getByRole('link', { name: 'Sources' }).getAttribute('href')).toBe('/sources');
    await waitFor(() => expect(trail.getByText('CI pipeline').getAttribute('aria-current')).toBe('page'));
    const card = screen.getByRole('article', { name: 'CI pipeline' });
    expect(within(card).getByRole('button', { name: /Copy URL: CI pipeline/ })).toBeTruthy();
    // On its own page the card does not link to itself.
    expect(within(card).queryByRole('link', { name: 'Open the page for CI pipeline' })).toBeNull();
    expect(document.title).toBe('Source · Lumi Noti');
  });

  it('is linked from each card on the list', async () => {
    await renderApp('/sources');
    const link = await screen.findByRole('link', { name: 'Open the page for CI pipeline' });
    expect(link.getAttribute('href')).toBe('/sources/src_1');
  });

  it('answers an id this workspace does not hold with the shell 404', async () => {
    await renderApp('/sources/src_elsewhere');
    await notFound();
    expect(requests).toContain(`GET /api/sources/src_elsewhere?org=${ORG_ID}`);
    // The breadcrumb never shows another workspace's name: it keeps the generic label.
    expect(within(crumbs()).getByText('Source')).toBeTruthy();
  });

  it('goes back to the list after a delete, without showing "not found" for the deleted source', async () => {
    const user = userEvent.setup();
    const app = await renderApp('/sources/src_1');
    await screen.findByRole('heading', { level: 1, name: 'CI pipeline' });
    await user.click(screen.getByRole('button', { name: 'Delete source…' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByLabelText('Type CI pipeline to confirm'), 'CI pipeline');
    await user.click(within(dialog).getByRole('button', { name: 'Delete source' }));
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/sources'));
    await screen.findByRole('heading', { level: 1, name: 'Sources' });
    expect(screen.queryByRole('heading', { name: 'We can’t find that page' })).toBeNull();
    // The deleted source's own address is not fetched again on the way out.
    expect(requests.filter((r) => r.startsWith('GET /api/sources/src_1')).length).toBe(1);
  });

  it('is linked from an integration that routes from it', async () => {
    await renderApp('/integrations');
    const card = (await screen.findByText('Deploy alerts')).closest('article');
    expect(card).not.toBeNull();
    const link = within(card as HTMLElement).getByRole('link', { name: 'Events from your own system' });
    expect(link.getAttribute('href')).toMatch(/^\/sources\/src_/);
  });
});

describe('Destinations health /destinations', () => {
  it('lists each integration’s destination with the health the API reports, linked to the integration', async () => {
    await renderApp('/destinations', { api: { me: MEMBER } });
    const table = await screen.findByRole('table', { name: 'Destinations and their health' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(INTEGRATIONS.length);

    const open = rows.find((r) => within(r).queryByRole('link', { name: 'Website builds' }));
    expect(open).toBeDefined();
    const openRow = within(open as HTMLElement);
    expect(openRow.getByRole('link', { name: 'Website builds' }).getAttribute('href')).toBe(
      '/integrations/int_1',
    );
    expect(openRow.getByText('Paused automatically')).toBeTruthy();
    expect(openRow.getByText(/^Tries again /)).toBeTruthy();
    // The fixture's reported figures, not computed ones.
    expect(openRow.getByRole('cell', { name: /^5$/ })).toBeTruthy();
    expect(openRow.getByText('Paused automatically 1 time so far')).toBeTruthy();

    // An integration the server sends no health record for says so in words; no zero is shown.
    const unreported = INTEGRATIONS.filter((i) => !i.health);
    expect(unreported.length).toBeGreaterThan(0);
    for (const integration of unreported) {
      const row = rows.find((r) => within(r).queryByRole('link', { name: integration.name }));
      expect(within(row as HTMLElement).getAllByText('Not reported')).toHaveLength(2);
    }
    expect(screen.getByText(/“Not reported” means the server has no health record/)).toBeTruthy();
  });

  it('is in the navigation for a member, as the selected item on its page', async () => {
    await renderApp('/destinations', { api: { me: MEMBER } });
    await screen.findByRole('table');
    const nav = within(screen.getByRole('navigation', { name: 'Main navigation' }));
    const item = nav.getByRole('link', { name: 'Destinations health' });
    expect(item.getAttribute('aria-current')).toBe('page');
    expect(document.title).toBe('Destinations health · Lumi Noti');
  });

  it('shows an error, never an empty list, when the integrations cannot be read', async () => {
    await renderApp('/destinations', { api: { integrations: 'error' } });
    await screen.findByText('We couldn’t load your destinations.');
    expect(screen.queryByText('No destinations yet')).toBeNull();
  });
});
