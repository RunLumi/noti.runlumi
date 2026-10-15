// @vitest-environment jsdom
import './a11y/testing/environment';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { audit, describeViolations } from './a11y/testing/axe';
import { clearRequests, renderApp, requests } from './a11y/testing/render';
import { invitationIdFrom } from './lib/api';
import { setLocale } from './i18n/locale';

/**
 * The sign-up page says up front when sign-up is limited (ADR 0048). Better Auth answers a refused sign-up with
 * the same 200 as an accepted one, so the page reads the deployment's mode from `GET /api/public/signup-mode`:
 * `invite_only` explains that an invited person uses their invitation link, `closed` disables the form, and an
 * invitation link (`/invite?id=...`) still reaches a working sign-up form.
 */
afterEach(() => {
  cleanup();
  setLocale('en', { persist: false });
});
beforeEach(() => clearRequests());

const WAIT = { timeout: 5000 };
const submit = () => screen.getByRole('button', { name: /Create account/ });

async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Your name'), 'Ada');
  await user.type(screen.getByLabelText('Work email'), 'ada@example.test');
  await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
}

async function expectClean(label: string) {
  const { blocking } = await audit();
  expect(blocking, `${label}\n${describeViolations(blocking)}`).toEqual([]);
}

describe('the sign-up page reads the deployment mode', () => {
  it('asks the public endpoint once, and shows no notice when sign-up is open', async () => {
    await renderApp('/signup');
    await screen.findByRole('button', { name: /Create account/ }, WAIT);
    await waitFor(() => expect(requests).toContain('GET /api/public/signup-mode'));
    expect(screen.queryByText(/by invitation/)).toBeNull();
    expect(screen.queryByText(/not being created/)).toBeNull();
    expect((submit() as HTMLButtonElement).disabled).toBe(false);
  });

  it('invite only: says sign-up is by invitation and that an invited person uses their invitation link', async () => {
    await renderApp('/signup', { api: { signupMode: 'invite_only' } });
    const notice = (await screen.findByText('Sign-up is by invitation', {}, WAIT)).closest('.notice');
    if (!(notice instanceof HTMLElement)) throw new Error('expected the notice container');
    expect(notice.textContent).toMatch(/open the link in your invitation email/);
    expect(notice.textContent).toMatch(/no account is created and no email is sent/);
    // The form stays usable: an invited or allowlisted address signs up here, and the server decides.
    expect((submit() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByLabelText<HTMLInputElement>('Work email').disabled).toBe(false);
    await expectClean('sign up, invite only');
  });

  it('invite only: after submitting, says what happens with and without an invitation', async () => {
    const user = userEvent.setup();
    await renderApp('/signup', { api: { signupMode: 'invite_only' } });
    await screen.findByText('Sign-up is by invitation', {}, WAIT);
    await fill(user);
    await user.click(submit());
    // The refused case returns the same 200 as the accepted one, so the page claims no more than either allows.
    expect(
      await screen.findByText(/If this address has an invitation, check your email/, {}, WAIT),
    ).toBeTruthy();
  });

  it('closed: says new accounts are not being created and disables the form', async () => {
    await renderApp('/signup', { api: { signupMode: 'closed' } });
    const title = await screen.findByText('New accounts are not being created', {}, WAIT);
    const notice = title.closest('.notice');
    expect(notice?.textContent).toMatch(/If you already have an account, sign in/);
    for (const label of ['Your name', 'Work email', 'Password'])
      expect(screen.getByLabelText<HTMLInputElement>(label).disabled, label).toBe(true);
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
    // Signing in is still offered.
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeTruthy();
    await expectClean('sign up, closed');
  });

  it('closed: Enter in the form sends nothing', async () => {
    await renderApp('/signup', { api: { signupMode: 'closed' } });
    await screen.findByText('New accounts are not being created', {}, WAIT);
    const form = screen.getByLabelText('Work email').closest('form');
    form?.requestSubmit();
    await new Promise((r) => setTimeout(r, 50));
    expect(requests.some((r) => r.includes('/sign-up/'))).toBe(false);
  });

  it('shows no notice when the mode cannot be read, and leaves the decision to the server', async () => {
    await renderApp('/signup', { api: { signupMode: 'error' } });
    await waitFor(() => expect(requests).toContain('GET /api/public/signup-mode'));
    await screen.findByRole('button', { name: /Create account/ }, WAIT);
    expect(document.querySelector('.signup-mode-notice')).toBeNull();
    expect((submit() as HTMLButtonElement).disabled).toBe(false);
  });

  it('is translated: the Vietnamese notice keeps its diacritics', async () => {
    await renderApp('/signup', { api: { signupMode: 'closed' }, locale: 'vi' });
    expect(await screen.findByText('Hiện không tạo tài khoản mới', {}, WAIT)).toBeTruthy();
    await expectClean('sign up, closed, vi');
  });
});

describe('an invitation link still reaches sign-up', () => {
  it('the signed-out invitation page links to sign-up carrying the invitation', async () => {
    await renderApp('/invite?id=inv_1', { api: { me: 'unauthenticated', signupMode: 'invite_only' } });
    const link = await screen.findByRole('link', { name: /Create an account/ }, WAIT);
    expect(link.getAttribute('href')).toBe('/signup?invite=inv_1');
  });

  it('invite only, from the link: a working form, a notice for the invited person, and a way back to the invitation', async () => {
    await renderApp('/signup?invite=inv_1', { api: { signupMode: 'invite_only' } });
    const title = await screen.findByText('You’re signing up from an invitation', {}, WAIT);
    expect(title.closest('.notice')?.textContent).toMatch(/address the invitation was sent to/);
    expect(screen.queryByText('Sign-up is by invitation')).toBeNull();
    expect((submit() as HTMLButtonElement).disabled).toBe(false);
    const signin = within(screen.getByText(/Already have an account/)).getByRole('link', { name: 'Sign in' });
    expect(signin.getAttribute('href')).toBe('/signin?returnTo=' + encodeURIComponent('/invite?id=inv_1'));
    await expectClean('sign up from an invitation');
  });

  it('sends the verification link back through sign-in to the invitation', async () => {
    const user = userEvent.setup();
    const app = await renderApp('/signup?invite=inv_1', { api: { signupMode: 'invite_only' } });
    await screen.findByText('You’re signing up from an invitation', {}, WAIT);
    await fill(user);
    await user.click(submit());
    await waitFor(() => expect(app.api.lastSignUp?.callbackURL).toBeTruthy());
    const callback = new URL(String(app.api.lastSignUp?.callbackURL));
    expect(callback.pathname).toBe('/signin');
    expect(callback.searchParams.get('verified')).toBe('1');
    expect(callback.searchParams.get('returnTo')).toBe('/invite?id=inv_1');
    // The invited person is told to check their email, not the stranger's "if this address has an invitation".
    expect(await screen.findByText(/Check your email for a verification link/, {}, WAIT)).toBeTruthy();
  });

  it('without an invitation, the verification link goes to plain sign-in', async () => {
    const user = userEvent.setup();
    const app = await renderApp('/signup', { api: { signupMode: 'open' } });
    await screen.findByRole('button', { name: /Create account/ }, WAIT);
    await fill(user);
    await user.click(submit());
    await waitFor(() => expect(app.api.lastSignUp?.callbackURL).toBeTruthy());
    expect(new URL(String(app.api.lastSignUp?.callbackURL)).search).toBe('?verified=1');
  });

  it('closed: an invitation cannot create an account either, so the form is disabled there too', async () => {
    await renderApp('/signup?invite=inv_1', { api: { signupMode: 'closed' } });
    await screen.findByText('New accounts are not being created', {}, WAIT);
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
  });

  it('ignores a malformed invitation id rather than carrying it anywhere', () => {
    expect(invitationIdFrom('?invite=inv_1')).toBe('inv_1');
    expect(invitationIdFrom('?invite=' + encodeURIComponent('//evil.example'))).toBeNull();
    expect(invitationIdFrom('?invite=' + encodeURIComponent('a b'))).toBeNull();
    expect(invitationIdFrom('?invite=' + 'x'.repeat(129))).toBeNull();
    expect(invitationIdFrom('')).toBeNull();
  });
});
