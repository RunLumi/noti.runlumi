// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatNumber, t, tp } from './index';
import { formatDate, formatRelative } from './format';
import { LocaleProvider, useLocale } from './LocaleProvider';
import { LocaleSwitcher } from './LocaleSwitcher';
import { LOCALE_STORAGE_KEY, detectLocale, getLocale, initialLocale, matchLocale, setLocale } from './locale';

function setBrowserLanguages(languages: string[]) {
  Object.defineProperty(window.navigator, 'languages', { value: languages, configurable: true });
  Object.defineProperty(window.navigator, 'language', { value: languages[0] ?? 'en', configurable: true });
}

beforeEach(() => {
  localStorage.clear();
  setBrowserLanguages(['en-US']);
  setLocale('en', { persist: false });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('locale detection', () => {
  it('matches region and case variants to a shipped language', () => {
    expect(matchLocale('vi')).toBe('vi');
    expect(matchLocale('vi-VN')).toBe('vi');
    expect(matchLocale('VI_vn')).toBe('vi');
    expect(matchLocale('en-GB')).toBe('en');
    expect(matchLocale('fr-FR')).toBeNull();
    expect(matchLocale('')).toBeNull();
    expect(matchLocale(undefined)).toBeNull();
  });

  it('takes the first supported language in the browser preference order', () => {
    expect(detectLocale(['fr-FR', 'vi-VN', 'en'])).toBe('vi');
    expect(detectLocale(['de', 'fr'])).toBe('en');
    expect(detectLocale([])).toBe('en');
  });

  it('defaults from navigator.languages when nothing is stored', () => {
    setBrowserLanguages(['vi-VN', 'en-US']);
    expect(initialLocale()).toBe('vi');
  });

  it('prefers the stored choice over the browser language', () => {
    setBrowserLanguages(['vi-VN']);
    localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    expect(initialLocale()).toBe('en');
  });

  it('ignores a stored value that is not a shipped locale', () => {
    setBrowserLanguages(['vi']);
    localStorage.setItem(LOCALE_STORAGE_KEY, 'klingon');
    expect(initialLocale()).toBe('vi');
  });

  it('survives storage that throws on read', () => {
    setBrowserLanguages(['vi']);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(initialLocale()).toBe('vi');
  });

  it('survives storage that throws on write, and still switches for this page view', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(() => setLocale('vi')).not.toThrow();
    expect(getLocale()).toBe('vi');
  });
});

describe('setLocale', () => {
  it('updates <html lang>, persists the choice, and changes t()', () => {
    expect(document.documentElement.lang).toBe('en');
    expect(t('nav.team')).toBe('Team');
    setLocale('vi');
    expect(document.documentElement.lang).toBe('vi');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('vi');
    expect(t('nav.team')).toBe('Thành viên');
  });

  it('does not persist when asked not to', () => {
    setLocale('vi', { persist: false });
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull();
  });
});

describe('formatting follows the active locale', () => {
  it('formats numbers with the locale’s separators', () => {
    expect(formatNumber(1234.5, 'en')).toBe('1,234.5');
    expect(formatNumber(1234.5, 'vi')).toBe('1.234,5');
    setLocale('vi', { persist: false });
    expect(tp('integrations.count', 1200)).toBe('1.200 tích hợp');
  });

  it('chooses plural forms by the active locale’s rules', () => {
    expect(tp('integrations.count', 1)).toBe('1 integration');
    expect(tp('integrations.count', 2)).toBe('2 integrations');
    setLocale('vi', { persist: false });
    expect(tp('integrations.count', 1)).toBe('1 tích hợp');
    expect(tp('integrations.count', 2)).toBe('2 tích hợp');
  });

  it('formats dates and relative times in the active language', () => {
    const iso = '2026-10-13T14:30:00Z';
    expect(formatDate(iso, 'en')).toMatch(/Oct/);
    expect(formatDate(iso, 'vi')).toMatch(/thg 10/);
    expect(formatRelative(-3, 'hour', 'en')).toBe('3 hours ago');
    expect(formatRelative(-3, 'hour', 'vi')).toBe('3 giờ trước');
    expect(formatDate('not a date', 'vi')).toBe('not a date');
  });
});

describe('language switcher', () => {
  // Strings are looked up while a component renders, as in the app, not when the test builds
  // its elements.
  const Page = () => {
    useLocale();
    return <nav aria-label={t('shell.navLabel')}>{t('nav.team')}</nav>;
  };
  const renderSwitcher = () =>
    render(
      <LocaleProvider>
        <Page />
        <LocaleSwitcher />
      </LocaleProvider>,
    );

  it('is a labelled control whose options name their own language and carry lang', () => {
    renderSwitcher();
    const select = screen.getByRole('combobox', { name: 'Language' });
    const options = within(select).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['English', 'Tiếng Việt']);
    expect(options.map((o) => o.getAttribute('lang'))).toEqual(['en', 'vi']);
  });

  it('switches the whole interface, <html lang> and the stored preference by keyboard', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    expect(screen.getByRole('navigation', { name: 'Main navigation' }).textContent).toBe('Team');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'vi');
    expect(document.documentElement.lang).toBe('vi');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('vi');
    // The label of the switcher and the rest of the page re-render in Vietnamese.
    expect(screen.getByRole('navigation', { name: 'Điều hướng chính' }).textContent).toBe('Thành viên');
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Ngôn ngữ' }).value).toBe('vi');
  });
});
