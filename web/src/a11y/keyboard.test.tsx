// @vitest-environment jsdom
import './testing/environment';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { focusHeadingWhenReady } from './RouteA11y';
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
    const order = await tabOrder(user, 13);
    expect(order.slice(0, 12)).toEqual([
      'Skip to content',
      'Noti', // logo link back to the overview
      'Create another workspace', // one workspace: a static label, then a way to add another
      'Overview',
      'Integrations',
      'Sources',
      'Activity',
      'Team',
      'Audit log', // admins only
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

/** Let React commit and every pending animation frame run, deterministically. */
const flushFrames = async () => {
  for (let i = 0; i < 3; i += 1)
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
};

describe('route changes (WCAG 2.4.2, 2.4.3)', () => {
  it('retitles the page and moves focus to the new <h1>, without a second announcement', async () => {
    const user = userEvent.setup();
    await renderApp('/');
    await screen.findByText(/Get started/);
    expect(document.title).toBe('Overview · Lumi Noti');

    await user.click(screen.getByRole('link', { name: 'Team' }));
    await screen.findByText('Minh Tran');
    expect(document.title).toBe('Team · Lumi Noti');
    await waitFor(() => expect(document.activeElement?.tagName).toBe('H1'));
    expect(document.activeElement?.textContent).toBe('Team');
    // The heading is the announcement; the live region stays empty for a navigation.
    const status = screen.getAllByRole('status').find((el) => el.classList.contains('visually-hidden'));
    expect(status?.textContent).toBe('');
  });

  it('does the same in Vietnamese', async () => {
    const user = userEvent.setup();
    await renderApp('/', { locale: 'vi' });
    await screen.findByText(/Bắt đầu/);
    expect(document.title).toBe('Tổng quan · Lumi Noti');
    await user.click(screen.getByRole('link', { name: 'Hoạt động' }));
    await waitFor(() => expect(document.title).toBe('Hoạt động · Lumi Noti'));
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
    await flushFrames();
    expect(document.activeElement).toBe(state);
  });

  it('does not move focus for a replace-navigation (a redirect)', async () => {
    const { router } = await renderApp('/');
    await screen.findByText(/Get started/);
    const link = screen.getByRole('link', { name: 'Team' });
    link.focus();
    await router.navigate({ to: '/team', replace: true });
    await screen.findByText('Minh Tran');
    await flushFrames();
    expect(document.activeElement).toBe(link);
  });

  it('sets document.title on first load', async () => {
    await renderApp('/signin');
    await screen.findByRole('button', { name: 'Sign in' });
    expect(document.title).toBe('Sign in · Lumi Noti');
  });
});

describe('focusHeadingWhenReady (a heading that renders after data loads)', () => {
  const mount = (html: string) => {
    document.body.innerHTML = html;
  };
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('waits for a late <h1> and focuses it', async () => {
    mount('<main id="main-content" tabindex="-1"><p>Loading…</p></main>');
    const stop = focusHeadingWhenReady(document, 1000);
    await flushFrames();
    expect(document.activeElement).toBe(document.body);
    await act(async () => {
      document.querySelector('main')?.insertAdjacentHTML('beforeend', '<h1>Late title</h1>');
      await Promise.resolve();
    });
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Late title'));
    stop();
  });

  it('falls back to <main> after the bounded wait if no heading ever appears', async () => {
    mount('<main id="main-content" tabindex="-1"><p>Loading…</p></main>');
    focusHeadingWhenReady(document, 150);
    await waitFor(() => expect(document.activeElement?.id).toBe('main-content'), { timeout: 1000 });
  });

  it('leaves focus alone if the person moved it meanwhile', async () => {
    mount('<main id="main-content" tabindex="-1"><button id="b">x</button></main>');
    focusHeadingWhenReady(document, 150);
    document.getElementById('b')?.focus();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(document.activeElement?.id).toBe('b');
  });
});

describe('language switch', () => {
  it('stays on the same page and URL, updates <html lang>, the title and the stored choice', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/team');
    await screen.findByText('Minh Tran');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'vi');
    await screen.findByRole('heading', { level: 1, name: 'Thành viên và quyền' });
    expect(router.state.location.pathname).toBe('/team');
    expect(document.documentElement.lang).toBe('vi');
    expect(document.title).toBe('Thành viên và quyền · Lumi Noti');
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

describe('a language switch changes nothing but the language (WCAG 2.4.3, 3.2.2)', () => {
  it('keeps focus on the language select', async () => {
    const user = userEvent.setup();
    await renderApp('/team');
    await screen.findByText('Minh Tran');
    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Language' });
    select.focus();
    await user.selectOptions(select, 'vi');
    await screen.findByRole('heading', { level: 1, name: 'Thành viên và quyền' });
    // The very same element, still focused: nothing was remounted.
    expect(screen.getByRole('combobox', { name: 'Ngôn ngữ' })).toBe(select);
    expect(document.activeElement).toBe(select);
    // The change is announced politely.
    const status = screen.getAllByRole('status').find((el) => el.classList.contains('visually-hidden'));
    expect(status?.textContent).toContain('Đã chuyển ngôn ngữ sang Tiếng Việt');
  });

  it('keeps an open dialog open, and its focus, while its text changes language', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/int_1');
    await user.click(await screen.findByRole('button', { name: 'Delete integration' }));
    const dialog = await screen.findByRole('alertdialog');
    const input = within(dialog).getByRole('textbox');
    await user.click(input);
    await user.type(input, 'Webs');
    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Language', hidden: true });
    await user.selectOptions(select, 'vi');
    await waitFor(() => expect(screen.getByRole('alertdialog').getAttribute('aria-labelledby')).toBeTruthy());
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    expect(dialog.textContent).toContain('Xóa Website builds?');
    expect(within(dialog).getByRole<HTMLInputElement>('textbox').value).toBe('Webs');
  });

  it('keeps unsaved form input across a switch', async () => {
    const user = userEvent.setup();
    await renderApp('/signup');
    const email = await screen.findByLabelText('Work email');
    await user.type(email, 'ada@example.test');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'vi');
    const same = await screen.findByLabelText('Email công việc');
    expect(same).toBe(email);
    expect((same as HTMLInputElement).value).toBe('ada@example.test');
  });

  it('keeps the wizard on the same step with its draft', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/new');
    await user.selectOptions(await screen.findByLabelText('GitHub repository'), 'repo:acme/website');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'vi');
    const repo = await screen.findByLabelText('Repository GitHub');
    expect((repo as HTMLSelectElement).value).toBe('repo:acme/website');
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
