// @vitest-environment jsdom
import '../a11y/testing/environment';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audit, describeViolations } from '../a11y/testing/axe';
import { ADMIN } from '../a11y/testing/fixtures';
import { clearRequests, renderApp, requests } from '../a11y/testing/render';
import { setLocale } from '../i18n/locale';
import { authApi } from '../lib/api';

/**
 * Account erasure on Settings (docs/DSAR.md): the typed email is a misclick guard; the server's
 * `403 reauth_required` is the security control, and the dialog answers it with a re-sign-in
 * (password or passkey) followed by an automatic retry.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLocale('en', { persist: false });
});
beforeEach(() => {
  clearRequests();
  setLocale('en', { persist: false });
});

const EMAIL = ADMIN.user.email;
const eraseRequests = () => requests.filter((r) => r === 'DELETE /api/workspace/me');

async function openDialog(user: ReturnType<typeof userEvent.setup>, button = /Delete my account…/) {
  await user.click(await screen.findByRole('button', { name: button }));
  return screen.findByRole('alertdialog');
}

describe('delete account', () => {
  it('shows what it does and is accessible, and does nothing until the email is typed', async () => {
    const user = userEvent.setup();
    await renderApp('/settings', { api: { eraseAccount: 'ok' } });
    expect(await screen.findByText(/There is no undo and no waiting period/)).toBeTruthy();
    const dialog = await openDialog(user);
    const { blocking } = await audit();
    expect(blocking, describeViolations(blocking)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Delete my account' }));
    expect(eraseRequests()).toEqual([]);
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
  });

  it('deletes after the typed email and leaves for the sign-in page', async () => {
    const user = userEvent.setup();
    const app = await renderApp('/settings', { api: { eraseAccount: 'ok' } });
    await openDialog(user);
    await user.type(screen.getByLabelText(`Type ${EMAIL} to confirm`), EMAIL);
    await user.click(screen.getByRole('button', { name: 'Delete my account' }));
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/signin'));
    expect(eraseRequests()).toHaveLength(1);
  });

  it('asks the person to sign in again on reauth_required, then retries by itself', async () => {
    const user = userEvent.setup();
    const app = await renderApp('/settings', { api: { eraseAccount: 'reauth_once' } });
    const signin = vi.spyOn(authApi, 'signin').mockImplementation(() => {
      app.api.eraseAccount = 'ok'; // the new session is fresh
      return Promise.resolve({ authenticated: true });
    });
    await openDialog(user);
    await user.type(screen.getByLabelText(`Type ${EMAIL} to confirm`), EMAIL);
    await user.click(screen.getByRole('button', { name: 'Delete my account' }));

    expect(await screen.findByText('Sign in again to continue')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use a passkey instead' })).toBeTruthy();
    const { blocking } = await audit();
    expect(blocking, describeViolations(blocking)).toEqual([]);
    expect(app.router.state.location.pathname).toBe('/settings');

    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Sign in and delete' }));
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/signin'));
    expect(signin).toHaveBeenCalledWith(EMAIL, 'correct horse battery staple');
    expect(eraseRequests()).toHaveLength(2);
  });

  it('offers a passkey for the re-sign-in', async () => {
    const user = userEvent.setup();
    const app = await renderApp('/settings', { api: { eraseAccount: 'reauth_once' } });
    const passkey = vi.spyOn(authApi, 'signinPasskey').mockImplementation(() => {
      app.api.eraseAccount = 'ok';
      return Promise.resolve({ authenticated: true });
    });
    await openDialog(user);
    await user.type(screen.getByLabelText(`Type ${EMAIL} to confirm`), EMAIL);
    await user.click(screen.getByRole('button', { name: 'Delete my account' }));
    await user.click(await screen.findByRole('button', { name: 'Use a passkey instead' }));
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/signin'));
    expect(passkey).toHaveBeenCalledOnce();
  });

  it('says so, and deletes nothing, when the re-sign-in fails', async () => {
    const user = userEvent.setup();
    await renderApp('/settings', { api: { eraseAccount: 'reauth_once' } });
    vi.spyOn(authApi, 'signin').mockRejectedValue(new Error('bad password'));
    await openDialog(user);
    await user.type(screen.getByLabelText(`Type ${EMAIL} to confirm`), EMAIL);
    await user.click(screen.getByRole('button', { name: 'Delete my account' }));
    await user.type(await screen.findByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in and delete' }));
    expect(await screen.findByText(/That sign-in did not work/)).toBeTruthy();
    expect(eraseRequests()).toHaveLength(1);
  });

  it('explains a sole admin in plain words', async () => {
    const user = userEvent.setup();
    await renderApp('/settings', { api: { eraseAccount: 'sole_admin' } });
    await openDialog(user);
    await user.type(screen.getByLabelText(`Type ${EMAIL} to confirm`), EMAIL);
    await user.click(screen.getByRole('button', { name: 'Delete my account' }));
    expect(await screen.findByText(/You are the only admin of a workspace/)).toBeTruthy();
  });

  it('is fully translated, including the re-sign-in step', async () => {
    const user = userEvent.setup();
    await renderApp('/settings', { api: { eraseAccount: 'reauth_once' }, locale: 'vi' });
    await user.click(await screen.findByRole('button', { name: /Xóa tài khoản của tôi…/ }));
    await user.type(await screen.findByLabelText(`Nhập ${EMAIL} để xác nhận`), EMAIL);
    await user.click(screen.getByRole('button', { name: 'Xóa tài khoản của tôi' }));
    expect(await screen.findByText('Đăng nhập lại để tiếp tục')).toBeTruthy();
    expect(screen.getByLabelText('Mật khẩu')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dùng passkey thay thế' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Đăng nhập và xóa' })).toBeTruthy();
  });
});
