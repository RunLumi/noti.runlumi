// @vitest-environment jsdom
import '../a11y/testing/environment';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { audit, describeViolations } from '../a11y/testing/axe';
import { INVITATIONS, MEMBER } from '../a11y/testing/fixtures';
import { clearRequests, ORG_ID, renderApp, requests } from '../a11y/testing/render';
import { setLocale } from '../i18n/locale';

/**
 * Pending invitations on the Team page (docs/specs/02 F21, ADR 0045): the list an admin sees, what it shows and
 * what it does not invent, the empty and the error states, the cancel confirmation (focus starts on Keep), what
 * happens when the server says the invitation is already gone, admin-only visibility, and axe in both languages.
 */
afterEach(() => {
  cleanup();
  setLocale('en', { persist: false });
});
beforeEach(() => {
  clearRequests();
  setLocale('en', { persist: false });
});

const LIST_URL = `GET /api/workspace/invitations?org=${ORG_ID}`;
const cancelUrl = (id: string) => `POST /api/workspace/invitations/${id}/cancel?org=${ORG_ID}`;
const cancelRequests = () => requests.filter((r) => r.includes('/cancel'));

// The first page load in jsdom is slow; every wait for the list allows for it.
const WAIT = { timeout: 5000 };
const section = async () =>
  screen.findByRole('region', { name: /Pending invitations|Lời mời đang chờ/ }, WAIT);

describe('the pending list', () => {
  it('shows each invitation with its address, role, sent time and expiry, and nothing the server did not send', async () => {
    await renderApp('/team');
    const panel = within(await section());
    const rows = await panel.findAllByRole('listitem');
    const [firstRow, secondRow] = rows;
    if (!firstRow || !secondRow) throw new Error('expected two invitation rows');
    expect(rows).toHaveLength(2);

    const first = within(firstRow);
    expect(first.getByText('hoa.tran@acme.test')).toBeTruthy();
    expect(first.getByText(/Member/)).toBeTruthy();
    expect(first.getByText(/Sent /)).toBeTruthy();
    expect(first.getByText(/Expires /)).toBeTruthy();
    expect(first.queryByText('Expired')).toBeNull();

    const second = within(secondRow);
    expect(second.getByText('quang.le@acme.test')).toBeTruthy();
    expect(second.getByText(/Admin/)).toBeTruthy();
    // The server marks it expired; the screen says so, and it can still be cancelled.
    expect(second.getByText('Expired')).toBeTruthy();
    expect(second.getByText(/Expired .*2026/)).toBeTruthy();
    expect(second.getByRole('button', { name: 'Cancel invitation for quang.le@acme.test' })).toBeTruthy();
  });

  it('asks for the workspace by name, and only ever for the one selected', async () => {
    await renderApp('/team');
    await section();
    await waitFor(() => expect(requests).toContain(LIST_URL));
  });

  it('says a role is not recorded rather than guessing one', async () => {
    await renderApp('/team', {
      api: { invitations: [{ ...INVITATIONS[0], role: null }] },
    });
    expect(await screen.findByText(/Role not recorded/, {}, WAIT)).toBeTruthy();
    expect(screen.queryByText(/Member · |Admin · /)).toBeNull();
  });

  it('shows the empty state, with the shared EmptyState heading, when nothing is pending', async () => {
    await renderApp('/team', { api: { invitations: [] } });
    expect(await screen.findByRole('heading', { level: 3, name: 'No pending invitations' })).toBeTruthy();
    expect(document.querySelectorAll('.invitation-entry')).toHaveLength(0);
  });

  it('shows the four-part error panel when the list cannot load, and retries on request', async () => {
    const user = userEvent.setup();
    const app = await renderApp('/team', { api: { invitations: 'error' } });
    const panel = await waitFor(() => {
      const found = screen
        .getAllByRole('alert')
        .find((a) => a.textContent?.includes('We couldn’t load the pending invitations.'));
      if (!found) throw new Error('error panel not shown yet');
      return found;
    });
    const body = within(panel);
    expect(body.getByText('Noti hit a problem on its own side. Nothing you entered caused it.')).toBeTruthy();
    expect(body.getByText('Try again in a minute. Anything already saved is safe.')).toBeTruthy();
    expect(body.getByText('Reference: HTTP 500')).toBeTruthy();

    app.api.invitations = INVITATIONS.map((i) => ({ ...i }));
    await user.click(body.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(
        screen.getAllByRole('listitem').filter((li) => li.classList.contains('invitation-entry')),
      ).toHaveLength(2),
    );
  });

  it('is never shown to a member, who is refused by the server anyway', async () => {
    await renderApp('/team', { api: { me: MEMBER } });
    await screen.findByText('Minh Tran');
    expect(screen.queryByRole('region', { name: /Pending invitations/ })).toBeNull();
    expect(requests.some((r) => r.includes('/api/workspace/invitations'))).toBe(false);
  });
});

describe('cancelling', () => {
  it('asks first, starts on Keep, and sends nothing when kept', async () => {
    const user = userEvent.setup();
    await renderApp('/team');
    await user.click(await screen.findByRole('button', { name: 'Cancel invitation for hoa.tran@acme.test' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Cancel the invitation to hoa.tran@acme.test?');
    const keep = within(dialog).getByRole('button', { name: 'Keep invitation' });
    await waitFor(() => expect(document.activeElement).toBe(keep));
    await user.click(keep);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(cancelRequests()).toEqual([]);
    expect(screen.getByText('hoa.tran@acme.test')).toBeTruthy();
  });

  it('cancels on confirm: the row goes, the link is said to stop working, focus moves to the heading', async () => {
    const user = userEvent.setup();
    await renderApp('/team');
    await user.click(await screen.findByRole('button', { name: 'Cancel invitation for hoa.tran@acme.test' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel invitation' }));

    expect(
      await screen.findByText('Invitation to hoa.tran@acme.test cancelled. Its link no longer works.'),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('hoa.tran@acme.test')).toBeNull());
    expect(cancelRequests()).toEqual([cancelUrl('inv_1')]);
    const heading = await screen.findByRole('heading', { level: 2, name: /Pending invitations/ });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('refreshes the list and explains itself when the invitation is already gone', async () => {
    const user = userEvent.setup();
    const app = await renderApp('/team', { api: { cancelInvitationStatus: 404 } });
    await user.click(await screen.findByRole('button', { name: 'Cancel invitation for quang.le@acme.test' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel invitation' }),
    );

    const alert = await waitFor(() => {
      const found = screen
        .getAllByRole('alert')
        .find((a) => a.textContent?.includes('We couldn’t cancel this invitation.'));
      if (!found) throw new Error('no error panel yet');
      return found;
    });
    expect(within(alert).getByText(/no longer exists, or it belongs to another workspace/)).toBeTruthy();
    expect(app.api.invitations).toHaveLength(2);
  });

  it('keeps the list when the cancel fails for another reason', async () => {
    const user = userEvent.setup();
    const app = await renderApp('/team', { api: { cancelInvitationStatus: 500 } });
    await user.click(await screen.findByRole('button', { name: 'Cancel invitation for hoa.tran@acme.test' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel invitation' }),
    );
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(screen.getByText('hoa.tran@acme.test')).toBeTruthy();
    expect(app.api.invitations).toHaveLength(2);
  });
});

describe('accessibility', () => {
  it('has no serious or critical axe violation, in English and in Vietnamese, with and without invitations', async () => {
    for (const locale of ['en', 'vi'] as const) {
      await renderApp('/team', { locale });
      await section();
      const { blocking } = await audit();
      expect(blocking, `${locale} with invitations: ${describeViolations(blocking)}`).toEqual([]);
      cleanup();
      await renderApp('/team', { locale, api: { invitations: [] } });
      await section();
      const empty = await audit();
      expect(empty.blocking, `${locale} empty: ${describeViolations(empty.blocking)}`).toEqual([]);
      cleanup();
    }
  });

  it('reads correctly in Vietnamese, with diacritics intact', async () => {
    await renderApp('/team', { locale: 'vi' });
    const panel = within(await section());
    expect(panel.getByRole('heading', { name: 'Lời mời đang chờ' })).toBeTruthy();
    expect(
      await panel.findByRole('button', { name: 'Hủy lời mời gửi tới hoa.tran@acme.test' }, WAIT),
    ).toBeTruthy();
  });
});
