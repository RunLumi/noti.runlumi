// @vitest-environment jsdom
import './testing/environment';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { renderApp } from './testing/render';
import { LOCALE_STORAGE_KEY } from '../i18n/locale';

/**
 * Keyboard and focus behaviour of the application shell (F221, WCAG 2.1.1, 2.1.2, 2.4.1,
 * 2.4.2, 2.4.3, 4.1.3). user-event dispatches real keyboard events against the real DOM;
 * jsdom has no layout, so "visible" focus is asserted from the stylesheet in
 * `stylesheet.test.ts`, not here.
 */
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const nameOf = (element: Element | null): string =>
  element?.getAttribute('aria-label') ??
  (element instanceof HTMLSelectElement ? element.labels?.[0]?.textContent?.trim() : undefined) ??
  element?.textContent?.trim() ??
  '';

/** Tab from the top of the document and record what receives focus, in order. */
async function tabOrder(user: ReturnType<typeof userEvent.setup>, presses: number): Promise<string[]> {
  const order: string[] = [];
  for (let i = 0; i < presses; i += 1) {
    await user.tab();
    order.push(nameOf(document.activeElement));
  }
  return order;
}

describe('skip link', () => {
  it('is the first stop in the tab order of the app shell', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations');
    await screen.findByText('Website builds');
    await user.tab();
    expect(document.activeElement?.className).toContain('skip-link');
    expect(nameOf(document.activeElement)).toBe('Skip to content');
  });

  it('moves focus to <main> and does not write a hash into the URL', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/integrations');
    await screen.findByText('Website builds');
    await user.tab();
    await user.keyboard('{Enter}');
    expect(document.activeElement?.id).toBe('main-content');
    expect(document.activeElement?.tagName).toBe('MAIN');
    expect(window.location.hash).toBe('');
    expect(router.state.location.hash).toBe('');
  });

  it('points at an element that exists, on the shell and on the sign-in screen', async () => {
    await renderApp('/integrations');
    await screen.findByText('Website builds');
    const target = document.querySelector('a.skip-link')?.getAttribute('href')?.slice(1) ?? '';
    expect(document.getElementById(target)?.tagName).toBe('MAIN');
    cleanup();
    await renderApp('/signin');
    await screen.findByRole('button', { name: 'Sign in' });
    const authTarget = document.querySelector('a.skip-link')?.getAttribute('href')?.slice(1) ?? '';
    expect(document.getElementById(authTarget)?.tagName).toBe('MAIN');
  });

  it('is first on the sign-in screen too, and reaches the form', async () => {
    const user = userEvent.setup();
    await renderApp('/signin');
    await screen.findByRole('button', { name: 'Sign in' });
    await user.tab();
    expect(nameOf(document.activeElement)).toBe('Skip to content');
    await user.keyboard('{Enter}');
    expect(document.activeElement?.id).toBe('main-content');
    await user.tab();
    // Next stop after <main> is the first control inside it: the language switcher.
    expect(within(document.getElementById('main-content') as HTMLElement).getByRole('combobox')).toBe(
      document.activeElement,
    );
  });
});

describe('tab order of the shell', () => {
  it('runs skip link, logo, navigation in visual order, language, then the page', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations');
    await screen.findByText('Website builds');
    const order = await tabOrder(user, 11);
    expect(order.slice(0, 10)).toEqual([
      'Skip to content',
      'Noti', // logo link back to the overview
      'Overview',
      'Integrations',
      'Sources',
      'Activity',
      'Team',
      'Settings',
      'Language', // switcher, in the sidebar after the navigation
      'New integration', // first control of the page itself
    ]);
  });

  it('never uses a positive tabindex (which would override the visual order)', async () => {
    await renderApp('/integrations');
    await screen.findByText('Website builds');
    const positive = [...document.querySelectorAll('[tabindex]')].filter(
      (el) => Number(el.getAttribute('tabindex')) > 0,
    );
    expect(positive).toEqual([]);
  });

  it('has no keyboard trap: Tab visits every tabbable control once and then leaves the page', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations');
    await screen.findByText('Website builds');
    const tabbable = [
      ...document.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"], [role="switch"]',
      ),
    ];
    const seen = new Set<Element>();
    for (let i = 0; i < tabbable.length + 2; i += 1) {
      await user.tab();
      seen.add(document.activeElement as Element);
    }
    for (const element of tabbable)
      expect(seen.has(element), `unreachable: ${element.outerHTML.slice(0, 80)}`).toBe(true);
    // Having walked past the last control, focus has returned to the start, not stuck.
    expect(
      document.activeElement === document.body || nameOf(document.activeElement) === 'Skip to content',
    ).toBe(true);
  });
});

describe('route changes (WCAG 2.4.2, 2.4.3, 4.1.3)', () => {
  it('retitles the page, announces it, and moves focus to the new <h1>', async () => {
    const user = userEvent.setup();
    await renderApp('/');
    await screen.findByText(/Get started/);
    expect(document.title).toBe('Overview · Lumi Noti');

    await user.click(screen.getByRole('link', { name: 'Team' }));
    await screen.findByText('Minh Tran');
    expect(document.title).toBe('Team · Lumi Noti');
    const status = screen.getAllByRole('status').find((el) => el.classList.contains('visually-hidden'));
    await waitFor(() => expect(status?.textContent).toBe('Team page opened'));
    await waitFor(() => expect(document.activeElement?.tagName).toBe('H1'));
    expect(document.activeElement?.textContent).toBe('Team');
  });

  it('does the same in Vietnamese', async () => {
    const user = userEvent.setup();
    await renderApp('/', { locale: 'vi' });
    await screen.findByText(/Bắt đầu/);
    expect(document.title).toBe('Tổng quan · Lumi Noti');
    await user.click(screen.getByRole('link', { name: 'Hoạt động' }));
    await waitFor(() => expect(document.title).toBe('Hoạt động · Lumi Noti'));
    const status = screen.getAllByRole('status').find((el) => el.classList.contains('visually-hidden'));
    await waitFor(() => expect(status?.textContent).toBe('Đã mở trang Hoạt động'));
    await waitFor(() => expect(document.activeElement?.tagName).toBe('H1'));
  });

  it('keeps the heading out of the tab order (tabindex -1, not 0)', async () => {
    const user = userEvent.setup();
    await renderApp('/');
    await screen.findByText(/Get started/);
    await user.click(screen.getByRole('link', { name: 'Team' }));
    await waitFor(() => expect(document.activeElement?.tagName).toBe('H1'));
    expect(document.activeElement?.getAttribute('tabindex')).toBe('-1');
  });

  it('does not steal focus on first load, or when only the query string changes', async () => {
    const { router } = await renderApp('/activity');
    await screen.findByRole('table');
    expect(document.activeElement).toBe(document.body);
    const state = screen.getByLabelText<HTMLSelectElement>('Outcome');
    state.focus();
    await router.navigate({ to: '/activity', search: { state: 'dead_lettered' } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(document.activeElement).toBe(state);
  });

  it('sets document.title on first load', async () => {
    await renderApp('/signin');
    await screen.findByRole('button', { name: 'Sign in' });
    expect(document.title).toBe('Sign in · Lumi Noti');
  });
});

describe('language switch', () => {
  it('stays on the same page and URL, updates <html lang>, the title and the stored choice', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/team');
    await screen.findByText('Minh Tran');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'vi');
    await screen.findByRole('heading', { level: 1, name: 'Nhóm' });
    expect(router.state.location.pathname).toBe('/team');
    expect(document.documentElement.lang).toBe('vi');
    expect(document.title).toBe('Nhóm · Lumi Noti');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('vi');
    // The switcher keeps working after the interface re-rendered.
    await user.selectOptions(screen.getByRole('combobox', { name: 'Ngôn ngữ' }), 'en');
    await screen.findByRole('heading', { level: 1, name: 'Team' });
    expect(document.documentElement.lang).toBe('en');
  });

  it('is a native select that Tab reaches on the sign-in screen, and it switches the screen', async () => {
    const user = userEvent.setup();
    await renderApp('/signin');
    await screen.findByRole('button', { name: 'Sign in' });
    await user.tab(); // skip link
    await user.tab(); // language switcher: first control in <main>
    const select = screen.getByRole('combobox', { name: 'Language' });
    expect(document.activeElement).toBe(select);
    expect(select.tagName).toBe('SELECT');
    await user.selectOptions(select, 'vi');
    await screen.findByRole('button', { name: 'Đăng nhập' });
    expect(document.documentElement.lang).toBe('vi');
  });
});

describe('the focus-trap helper itself', () => {
  it('would notice focus leaving a container', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <div data-testid="box">
          <button>one</button>
        </div>
        <button>outside</button>
      </div>,
    );
    const box = screen.getByTestId('box');
    await user.tab();
    await user.tab();
    expect(box.contains(document.activeElement)).toBe(false);
  });
});
