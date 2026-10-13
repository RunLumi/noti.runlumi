// @vitest-environment jsdom
import './testing/environment';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { audit, describeViolations } from './testing/axe';
import { renderApp } from './testing/render';

/**
 * Dialogs, wizard steps and error states: the screens a person only reaches by acting. Each
 * is scanned with axe, and each dialog is also held to the focus contract in F221:
 *
 *   open   -> focus lands inside (a destructive confirmation lands on its Cancel button)
 *   Tab    -> never leaves the dialog while it is open
 *   Escape -> closes it
 *   close  -> focus returns to the control that opened it
 */
afterEach(cleanup);

async function expectClean(label: string) {
  const { blocking } = await audit();
  expect(blocking, `${label}\n${describeViolations(blocking)}`).toEqual([]);
}

/**
 * Press Tab `presses` times and report whether focus ever stayed outside `container` once the
 * dialog's focus guards had run. Base UI parks focus on a guard element for a moment and moves
 * it back, so the check waits for that to settle instead of sampling mid-hop.
 */
async function tabStaysWithin(
  user: ReturnType<typeof userEvent.setup>,
  container: HTMLElement,
  presses: number,
) {
  for (let i = 0; i < presses; i += 1) {
    await user.tab();
    try {
      await waitFor(() => expect(container.contains(document.activeElement)).toBe(true), { timeout: 300 });
    } catch {
      return false;
    }
  }
  return true;
}

describe('delete integration (alert dialog)', () => {
  it('is accessible, focuses Cancel first, traps Tab, closes on Escape and restores focus', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/int_1');
    const trigger = await screen.findByRole('button', { name: 'Delete integration' });
    await user.click(trigger);

    const dialog = await screen.findByRole('alertdialog', { name: /Delete Website builds\?/ });
    await expectClean('delete dialog open');
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Keep integration' })),
    );
    expect(await tabStaysWithin(user, dialog, 8)).toBe(true);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('keeps Delete inert until the exact name is typed (aria-disabled, still focusable)', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/int_1');
    await user.click(await screen.findByRole('button', { name: 'Delete integration' }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete permanently' });
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    await user.type(within(dialog).getByLabelText(/Type Website builds to confirm/), 'Website builds');
    expect(confirm.getAttribute('aria-disabled')).toBeNull();
  });
});

describe('delete workspace (alert dialog)', () => {
  it('is accessible and follows the same focus contract', async () => {
    const user = userEvent.setup();
    await renderApp('/settings');
    const trigger = await screen.findByRole('button', { name: /Delete workspace/ });
    await user.click(trigger);
    const dialog = await screen.findByRole('alertdialog');
    await expectClean('delete workspace dialog');
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Keep workspace' })),
    );
    expect(await tabStaysWithin(user, dialog, 6)).toBe(true);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('is accessible in Vietnamese', async () => {
    const user = userEvent.setup();
    await renderApp('/settings', { locale: 'vi' });
    await user.click(await screen.findByRole('button', { name: /Xóa không gian làm việc/ }));
    await screen.findByRole('alertdialog');
    await expectClean('delete workspace dialog (vi)');
  });
});

describe('delivery detail (dialog)', () => {
  const openFailed = async (user: ReturnType<typeof userEvent.setup>) => {
    await renderApp('/activity');
    const rows = await screen.findAllByRole('row');
    const failed = rows.find((row) => within(row).queryByText('Failed'));
    expect(failed, 'no failed row in the fixture').toBeDefined();
    const trigger = within(failed as HTMLElement).getByRole('button', { name: /Details/ });
    await user.click(trigger);
    return trigger;
  };

  it('is accessible with the explanation and facts loaded', async () => {
    const user = userEvent.setup();
    await openFailed(user);
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(/What happened/);
    await expectClean('delivery detail');
  });

  it('closes on Escape and returns focus to the row button that opened it', async () => {
    const user = userEvent.setup();
    const trigger = await openFailed(user);
    const dialog = await screen.findByRole('dialog');
    expect(await tabStaysWithin(user, dialog, 8)).toBe(true);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('shows the redelivery confirmation accessibly', async () => {
    const user = userEvent.setup();
    await openFailed(user);
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Redeliver' }));
    await within(dialog).findByText(/Send this notification again\?/);
    await expectClean('redeliver confirmation');
  });
});

describe('create-integration wizard', () => {
  const next = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('button', { name: /Continue/ }));

  it('is accessible at every step, with a labelled ordered stepper and a focusable step heading', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/new');
    const stepper = await screen.findByRole('navigation', { name: 'Setup steps' });
    expect(within(stepper).getAllByRole('listitem')).toHaveLength(7);
    expect(stepper.querySelector('ol')).not.toBeNull();

    // 1 Repository
    await expectClean('wizard step 1');
    await user.selectOptions(screen.getByLabelText('GitHub repository'), 'repo:acme/website');
    await next(user);
    // 2 Destination
    await screen.findByRole('group', { name: 'Where should notifications go?' });
    expect(stepper.querySelector('[aria-current="step"]')?.textContent).toMatch(/Choose where messages go/);
    await expectClean('wizard step 2');
    await user.click(screen.getByRole('radio', { name: /Slack/ }));
    await next(user);
    // 3 Webhook
    await screen.findByLabelText('Webhook URL');
    await expectClean('wizard step 3');
    await user.type(screen.getByLabelText('Webhook URL'), 'https://hooks.slack.com/services/T000/B000/XXXX');
    await next(user);
    // 4 Updates
    await screen.findByText(/Updates to send/);
    await expectClean('wizard step 4');
    await next(user);
    // 5 Filters (optional): editors for five filters plus the "Try it" checker
    await screen.findByRole('heading', { level: 2, name: /Step 5 of 7/ });
    await expectClean('wizard step 5 (filters)');
    await next(user);
    // 6 Review
    await screen.findByRole('button', { name: /Create integration/ });
    await expectClean('wizard review');
  });

  it('puts an inline, announced, linked error beside the field and focuses it after a failed step', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/new');
    await screen.findByLabelText('GitHub repository');
    await next(user);
    const select = screen.getByLabelText('GitHub repository');
    await waitFor(() => expect(document.activeElement).toBe(select));
    expect(select.getAttribute('aria-invalid')).toBe('true');
    const describedBy = select.getAttribute('aria-describedby') ?? '';
    const error = within(document.body).getByRole('alert');
    expect(describedBy.split(' ')).toContain(error.id);
    await expectClean('wizard step 1 with error');
  });

  it('is accessible in Vietnamese through the destination step', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/new', { locale: 'vi' });
    await user.selectOptions(await screen.findByLabelText('Repository GitHub'), 'repo:acme/website');
    await user.click(screen.getByRole('button', { name: /Tiếp tục/ }));
    await screen.findByRole('group', { name: /Thông báo nên được gửi đến đâu\?/ });
    await expectClean('wizard step 2 (vi)');
  });
});

describe('error and validation states', () => {
  it('integration settings: a cleared name shows a linked error', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/int_1');
    const name = await screen.findByLabelText(/^Name/);
    await user.clear(name);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(name.getAttribute('aria-invalid')).toBe('true'));
    await expectClean('settings with validation error');
  });

  it('integration settings: equal quiet-hours times show a linked, announced error', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/int_1');
    await user.click(await screen.findByLabelText('Save updates during quiet hours'));
    const end = await screen.findByLabelText('Quiet hours end');
    fireEvent.change(end, { target: { value: '22:00' } });
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(end.getAttribute('aria-invalid')).toBe('true'));
    expect(await screen.findByText('Start and end must be different times.')).toBeTruthy();
    await expectClean('settings with a quiet-hours validation error');
  });

  it('integration settings: the noise section is accessible in Vietnamese with a validation error', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/int_1', { locale: 'vi' });
    await user.click(await screen.findByLabelText('Lưu cập nhật trong giờ yên tĩnh'));
    const end = await screen.findByLabelText('Giờ yên tĩnh kết thúc');
    fireEvent.change(end, { target: { value: '22:00' } });
    await user.click(screen.getByRole('button', { name: 'Lưu cài đặt' }));
    await waitFor(() => expect(end.getAttribute('aria-invalid')).toBe('true'));
    await expectClean('settings with a quiet-hours validation error (vi)');
  });

  it('sign in: a failed sign-in is announced as an alert', async () => {
    const user = userEvent.setup();
    await renderApp('/signin');
    await user.type(await screen.findByLabelText(/Work email/), 'x@y.test');
    await user.type(screen.getByLabelText('Password'), 'wrong-password-123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('alert');
    await expectClean('sign in with error');
  });
});

describe('sources', () => {
  it('create: shows the one-time secret in an accessible reveal, and the form validates inline', async () => {
    const user = userEvent.setup();
    await renderApp('/sources');
    await screen.findByText('CI pipeline');
    // Empty name: inline, linked error with focus on the field.
    await user.click(screen.getByRole('button', { name: 'Create source' }));
    const field = await screen.findByLabelText('Source name');
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(field.getAttribute('aria-invalid')).toBe('true');
    await expectClean('source create with validation error');
    // Valid name: the secret is revealed once.
    await user.type(field, 'New source');
    await user.click(screen.getByRole('button', { name: 'Create source' }));
    await screen.findByText(/Signing secret for New source/);
    await expectClean('one-time secret reveal');
  });

  it('rotate and delete dialogs follow the focus contract and are accessible', async () => {
    const user = userEvent.setup();
    await renderApp('/sources');
    await screen.findByText('CI pipeline');

    const rotate = screen.getAllByRole('button', { name: /Rotate secret/ })[0];
    await user.click(rotate);
    const rotateDialog = await screen.findByRole('alertdialog');
    await expectClean('rotate dialog');
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(rotateDialog).getByRole('button', { name: 'Keep current secret' }),
      ),
    );
    expect(await tabStaysWithin(user, rotateDialog, 6)).toBe(true);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(rotate));

    const remove = screen.getAllByRole('button', { name: /Delete source/ })[0];
    await user.click(remove);
    const deleteDialog = await screen.findByRole('alertdialog');
    await expectClean('delete source dialog');
    await waitFor(() =>
      expect(document.activeElement).toBe(within(deleteDialog).getByRole('button', { name: 'Keep source' })),
    );
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(remove));
  });

  it('is accessible in Vietnamese with the guidance and chat sections open', async () => {
    const user = userEvent.setup();
    await renderApp('/sources', { locale: 'vi' });
    await screen.findByText('CI pipeline');
    for (const summary of screen.getAllByText(/Gửi một sự kiện thử|Gửi các sự kiện này đến một chat/))
      await user.click(summary);
    await expectClean('sources with guidance open (vi)');
  });
});
