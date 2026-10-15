// @vitest-environment jsdom
import '../a11y/testing/environment';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audit, describeViolations } from '../a11y/testing/axe';
import { MEMBER } from '../a11y/testing/fixtures';
import { clearRequests, renderApp, requests } from '../a11y/testing/render';
import { setLocale } from '../i18n/locale';

/**
 * "Remove member" on the Team page (ADR 0048) asks in the repository's alert-dialog pattern, not with
 * `window.confirm`: a four-part message (who, from which workspace; what they lose; what is kept; how to undo),
 * focus starting on "Keep member", Escape to close, focus back on the trigger, a refusal shown inside the dialog,
 * and nothing sent until the explicit confirm. Axe in both languages.
 */
afterEach(() => {
  cleanup();
  setLocale('en', { persist: false });
  vi.restoreAllMocks();
});
beforeEach(() => clearRequests());

const WAIT = { timeout: 5000 };
const REMOVE = 'POST /api/auth/organization/remove-member';
const removeRequests = () => requests.filter((r) => r.startsWith(REMOVE));
const trigger = () =>
  screen.findByRole('button', { name: 'Remove minh@acme.test from your organization' }, WAIT);

async function expectClean(label: string) {
  const { blocking } = await audit();
  expect(blocking, `${label}\n${describeViolations(blocking)}`).toEqual([]);
}

describe('remove member confirmation', () => {
  it('never uses window.confirm', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    const user = userEvent.setup();
    await renderApp('/team');
    await user.click(await trigger());
    await screen.findByRole('alertdialog');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('states the four parts, focuses Keep first, closes on Escape and restores focus, sending nothing', async () => {
    const user = userEvent.setup();
    await renderApp('/team');
    const open = await trigger();
    await user.click(open);
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove Minh Tran from Acme Studio?' });
    const text = dialog.textContent ?? '';
    expect(text).toMatch(/minh@acme\.test loses access to this workspace at once/);
    expect(text).toMatch(
      /account is not deleted, and the integrations and sources in this workspace keep running/,
    );
    expect(text).toMatch(/send a new invitation/);
    expect(text).toMatch(/recorded in the audit log/);
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Keep member' })),
    );
    await expectClean('remove member dialog open');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(open));
    expect(removeRequests()).toEqual([]);
  });

  it('Keep member closes without removing anyone', async () => {
    const user = userEvent.setup();
    await renderApp('/team');
    await user.click(await trigger());
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Keep member' }),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(removeRequests()).toEqual([]);
    expect(screen.getByText('Minh Tran')).toBeTruthy();
  });

  it('removes on the explicit confirm, announces it, and moves focus to the member list heading', async () => {
    const user = userEvent.setup();
    await renderApp('/team');
    await user.click(await trigger());
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove member' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(removeRequests()).toHaveLength(1);
    expect(await screen.findByText('minh@acme.test was removed from this workspace.', {}, WAIT)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Minh Tran')).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Members' })),
    );
  });

  it('keeps the dialog open with the refusal when the server says no, and the member stays', async () => {
    const user = userEvent.setup();
    await renderApp('/team', { api: { removeMemberStatus: 403 } });
    await user.click(await trigger());
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove member' }));
    expect(
      await within(dialog).findByText('You are not allowed to remove this member', {}, WAIT),
    ).toBeTruthy();
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    expect(screen.getByText('Minh Tran')).toBeTruthy();
    await expectClean('remove member dialog with an error');
  });

  it('is offered to admins only, and never for themselves', async () => {
    await renderApp('/team');
    await trigger();
    expect(screen.queryByRole('button', { name: /Remove linh@acme\.test/ })).toBeNull();
    cleanup();
    await renderApp('/team', { api: { me: MEMBER } });
    await screen.findByText('Minh Tran', {}, WAIT);
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
  });

  it('is translated: the Vietnamese dialog keeps its diacritics and passes axe', async () => {
    const user = userEvent.setup();
    await renderApp('/team', { locale: 'vi' });
    await user.click(
      await screen.findByRole('button', { name: 'Xóa minh@acme.test khỏi tổ chức của bạn' }, WAIT),
    );
    const dialog = await screen.findByRole('alertdialog', { name: 'Xóa Minh Tran khỏi Acme Studio?' });
    expect(dialog.textContent).toMatch(/mất quyền truy cập không gian làm việc này ngay lập tức/);
    expect(within(dialog).getByRole('button', { name: 'Giữ thành viên' })).toBeTruthy();
    await expectClean('remove member dialog open, vi');
  });
});
