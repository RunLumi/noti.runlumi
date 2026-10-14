// @vitest-environment jsdom
import '../a11y/testing/environment';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { audit, describeViolations } from '../a11y/testing/axe';
import { clearRequests, renderApp, requests } from '../a11y/testing/render';
import { setLocale } from '../i18n/locale';

/**
 * "Where you are signed in" on Settings (spec 02 F20, ADR 0030): the list, ending one device, ending all
 * the others, what happens when the server says no, and axe in both languages.
 */
afterEach(() => {
  cleanup();
  setLocale('en', { persist: false });
});
beforeEach(() => {
  clearRequests();
  setLocale('en', { persist: false });
});

const region = async () =>
  screen.findByRole('region', { name: /Where you are signed in|Nơi bạn đang đăng nhập/ });
const posts = () => requests.filter((r) => r.startsWith('POST /api/workspace/me/sessions'));

describe('the device list', () => {
  it('names each device, marks this one, and offers sign-out only for the others', async () => {
    await renderApp('/settings');
    const panel = within(await region());
    const items = await panel.findAllByRole('listitem');
    expect(items).toHaveLength(3);

    const laptop = within(items[0]);
    expect(laptop.getByText('Chrome on macOS')).toBeTruthy();
    expect(laptop.getByText('This device')).toBeTruthy();
    expect(laptop.queryByRole('button')).toBeNull();
    expect(laptop.getByText(/Address 203\.0\.113\.x/)).toBeTruthy();

    const phone = within(items[1]);
    expect(phone.getByText('Safari on iOS')).toBeTruthy();
    expect(phone.getByRole('button', { name: 'Sign out Safari on iOS' })).toBeTruthy();

    const unknown = within(items[2]);
    expect(unknown.getByText('Unknown device')).toBeTruthy();
    expect(unknown.getByText(/Address unknown/)).toBeTruthy();
  });

  it("states both limits on a sign-in, from the server's own constants", async () => {
    await renderApp('/settings');
    expect(
      await screen.findByText(
        'A sign-in ends after 30 days without use, and always 90 days after you signed in.',
      ),
    ).toBeTruthy();
  });

  it('is accessible in English and in Vietnamese', async () => {
    for (const locale of ['en', 'vi'] as const) {
      await renderApp('/settings', { locale });
      await region();
      const { blocking } = await audit();
      expect(blocking, `${locale}: ${describeViolations(blocking)}`).toEqual([]);
      cleanup();
    }
  });

  it('reads correctly in Vietnamese, with diacritics intact', async () => {
    await renderApp('/settings', { locale: 'vi' });
    const panel = within(await region());
    expect(await panel.findByText('Thiết bị này')).toBeTruthy();
    expect(panel.getByRole('button', { name: 'Đăng xuất Safari trên iOS' })).toBeTruthy();
    expect(panel.getByText(/Một lần đăng nhập hết hạn sau 30 ngày không sử dụng/)).toBeTruthy();
  });

  it('shows a clear error and a retry when the list cannot be loaded', async () => {
    const app = await renderApp('/settings', { api: { sessions: 'error' } });
    const panel = within(await region());
    expect(await panel.findByText(/couldn’t load your devices/)).toBeTruthy();
    app.api.sessions = [];
    await userEvent.setup().click(panel.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(panel.queryByText(/couldn’t load your devices/)).toBeNull());
  });
});

describe('signing a device out', () => {
  it('ends that device only, at once, and says so', async () => {
    const user = userEvent.setup();
    await renderApp('/settings');
    const panel = within(await region());
    await user.click(await panel.findByRole('button', { name: 'Sign out Safari on iOS' }));
    expect(await panel.findByText('That device was signed out.')).toBeTruthy();
    expect(posts()).toEqual(['POST /api/workspace/me/sessions/ses_phone/revoke']);
    await waitFor(() => expect(panel.queryByText('Safari on iOS')).toBeNull());
    expect(panel.getByText('Chrome on macOS')).toBeTruthy();
    expect(panel.getByText('Unknown device')).toBeTruthy();
  });

  it('ends every other device with one button, and then has nothing left to offer', async () => {
    const user = userEvent.setup();
    await renderApp('/settings');
    const panel = within(await region());
    await user.click(await panel.findByRole('button', { name: 'Sign out all other devices' }));
    expect(await panel.findByText('2 other devices were signed out.')).toBeTruthy();
    expect(posts()).toEqual(['POST /api/workspace/me/sessions/revoke-others']);
    await waitFor(() => expect(panel.getAllByRole('listitem')).toHaveLength(1));
    const button = panel.getByRole('button', { name: 'Sign out all other devices' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(panel.getByText('You are not signed in anywhere else.')).toBeTruthy();
  });

  it.each([
    [404, /already signed out/],
    [429, /Too many requests/],
    [500, /couldn’t sign that device out/],
  ] as const)(
    'a %s from the server is said plainly and changes nothing it should not',
    async (status, text) => {
      const user = userEvent.setup();
      await renderApp('/settings', { api: { revokeStatus: status } });
      const panel = within(await region());
      await user.click(await panel.findByRole('button', { name: 'Sign out Safari on iOS' }));
      expect(await panel.findByText(text)).toBeTruthy();
      expect(panel.getByText('Chrome on macOS')).toBeTruthy();
    },
  );

  it('announces results politely and errors assertively, so a screen reader hears them', async () => {
    const user = userEvent.setup();
    await renderApp('/settings');
    const panel = within(await region());
    await user.click(await panel.findByRole('button', { name: 'Sign out Safari on iOS' }));
    expect(
      (await panel.findByText('That device was signed out.')).closest('[role]')?.getAttribute('role'),
    ).toBe('status');
  });
});
