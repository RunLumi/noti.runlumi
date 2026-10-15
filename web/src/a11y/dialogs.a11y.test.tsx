// @vitest-environment jsdom
import './testing/environment';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { audit, describeViolations } from './testing/axe';
import { renderApp, requests, clearRequests } from './testing/render';
import { MEMBER, ORG_ID, SOURCES } from './testing/fixtures';

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

describe('revoke webhook URL (alert dialog)', () => {
  it('is accessible, focuses Cancel first, traps Tab, closes on Escape and restores focus', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/int_1');
    const trigger = await screen.findByRole('button', { name: 'Revoke webhook URL' });
    await user.click(trigger);

    const dialog = await screen.findByRole('alertdialog', { name: /Revoke the webhook URL for/ });
    await expectClean('revoke dialog open');
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' })),
    );
    expect(within(dialog).getByRole('radio', { name: 'It may have been leaked or misused' })).toBeTruthy();
    expect(await tabStaysWithin(user, dialog, 8)).toBe(true);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('revokes with the chosen reason, then says what happened and offers the new URL form', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/int_1');
    await user.click(await screen.findByRole('button', { name: 'Revoke webhook URL' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('radio', { name: 'We no longer use it' }));
    await user.click(within(dialog).getByRole('button', { name: 'Revoke webhook URL' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await screen.findByText(/Webhook URL revoked\. Nothing more is sent/)).toBeTruthy();
    expect(screen.getByText('Revoked')).toBeTruthy();
    expect(screen.getByText(/Destroyed in the live database/)).toBeTruthy();
    // The fingerprint outlives the key, and the replace form is open for the next step.
    expect(screen.getByText('K3M7QXAZ')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save new webhook URL' })).toBeTruthy();
    // Nothing left to revoke.
    expect(screen.queryByRole('button', { name: 'Revoke webhook URL' })).toBeNull();
    await expectClean('after revoke');
  });

  it('does not revoke when Enter is pressed on a reason: only the confirm button revokes', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/int_1');
    await user.click(await screen.findByRole('button', { name: 'Revoke webhook URL' }));
    const dialog = await screen.findByRole('alertdialog');
    const radio = within(dialog).getByRole('radio', { name: 'We no longer use it' });
    await user.click(radio);
    radio.focus();
    await user.keyboard('{Enter}');
    // Still open and nothing was revoked.
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.queryByText(/Webhook URL revoked\./)).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Revoke webhook URL' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await screen.findByText(/Webhook URL revoked\./)).toBeTruthy();
  });

  it('offers no revoke control to a member, who lacks integration.revoke', async () => {
    await renderApp('/integrations/int_1', { api: { me: MEMBER } });
    await screen.findByText('Fingerprint');
    expect(screen.queryByRole('button', { name: 'Revoke webhook URL' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Replace webhook URL' })).toBeTruthy();
  });

  it('shows the fingerprint of an unrevoked URL and no revoke state', async () => {
    await renderApp('/integrations/int_1');
    await screen.findByRole('button', { name: 'Revoke webhook URL' });
    expect(screen.getByText('Fingerprint')).toBeTruthy();
    expect(screen.getByText('K3M7QXAZ')).toBeTruthy();
    expect(screen.queryByText('Revoked')).toBeNull();
  });

  it('is announced in Vietnamese, with the diacritics intact', async () => {
    await renderApp('/integrations/int_1', { locale: 'vi' });
    expect(await screen.findByRole('button', { name: 'Thu hồi webhook URL' })).toBeTruthy();
    expect(screen.getByText('Dấu vân tay')).toBeTruthy();
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

describe('attempt history and duplicate disclosure (ADR 0023)', () => {
  const openRow = async (user: ReturnType<typeof userEvent.setup>, state: RegExp, locale?: 'vi') => {
    await renderApp('/activity', locale ? { locale } : {});
    const rows = await screen.findAllByRole('row');
    const row = rows.find((r) => within(r).queryByText(state));
    expect(row, 'no matching row in the fixture').toBeDefined();
    await user.click(
      within(row as HTMLElement).getByRole('button', { name: locale ? /Chi tiết/ : /Details/ }),
    );
    return screen.findByRole('dialog');
  };

  it('lists every attempt, oldest first, with words for each outcome, and is accessible', async () => {
    const user = userEvent.setup();
    const dialog = await openRow(user, /Failed/);
    await within(dialog).findByText('Every attempt');
    const list = within(dialog).getByRole('list', { name: 'Attempts, oldest first' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    // Outcome is text, never colour alone; a wait is not an attempt.
    expect(within(items[0]).getByText('Attempt 1')).toBeTruthy();
    expect(within(items[0]).getByText('Did not work, will retry')).toBeTruthy();
    expect(within(items[1]).getByText('Waited, and then 41 more times. Nothing was sent.')).toBeTruthy();
    expect(
      within(items[1]).getByText('Paused automatically because the destination keeps failing.'),
    ).toBeTruthy();
    expect(within(items[2]).getByText('Did not work, stopped')).toBeTruthy();
    // Nothing the destination answered is shown: a status class and a minted code only.
    expect(within(items[0]).getByText('The destination had an error · Took 412 ms')).toBeTruthy();
    expect(within(items[0]).getByText('Code provider_http_503')).toBeTruthy();
    expect(within(items[0]).getByText('The destination may already have received this one.')).toBeTruthy();
    await expectClean('delivery attempts');
  });

  it('says plainly that a retried delivery may have arrived more than once', async () => {
    const user = userEvent.setup();
    const dialog = await openRow(user, /Retrying/);
    await within(dialog).findByText('This may have arrived more than once');
    expect(within(dialog).getByText(/Noti cannot tell, and does not promise it did not/)).toBeTruthy();
    expect(
      within(dialog).getByText(
        /Paused automatically because the destination keeps failing\. Noti will try again/,
      ),
    ).toBeTruthy();
    await expectClean('possible duplicate');
  });

  it('records a suppressed repeat with its reason and a way to the first delivery', async () => {
    const user = userEvent.setup();
    const dialog = await openRow(user, /Suppressed/);
    await within(dialog).findByText('Not sent again');
    expect(within(dialog).getByText(/recorded this repeat instead of sending it again/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Show the first delivery' })).toBeTruthy();
    // The original failed: say so and point at it, rather than implying this repeat could be redelivered.
    expect(
      within(dialog).getByText(/The first delivery of this event failed\. Redeliver that one/),
    ).toBeTruthy();
    await expectClean('suppressed duplicate');
  });

  it('is accessible in Vietnamese', async () => {
    const user = userEvent.setup();
    const dialog = await openRow(user, /Thất bại|Failed/, 'vi');
    await within(dialog).findByText('Từng lần thử');
    await expectClean('delivery attempts (vi)');
  });
});

describe('redeliver all failed (F182)', () => {
  it('counts first, asks for the number above the threshold, then reports what was queued', async () => {
    const user = userEvent.setup();
    await renderApp('/activity?state=dead_lettered');
    const start = await screen.findByRole('button', { name: 'Redeliver all failed' });
    await user.click(start);
    await screen.findByText('25 failed deliveries will be sent again as new deliveries.');
    expect(screen.getByText(/5 more are waiting\. Noti sends at most 200 at a time/)).toBeTruthy();
    const confirm = screen.getByRole('button', { name: 'Send them again' });
    // Above the threshold the number must be typed; until then the button does nothing.
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    await user.click(confirm);
    expect(screen.queryByText(/Queued/)).toBeNull();
    await expectClean('bulk redeliver preview');
    await user.type(screen.getByLabelText('Type 25 to confirm'), '25');
    expect(screen.getByRole('button', { name: 'Send them again' }).getAttribute('aria-disabled')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Send them again' }));
    const queued = await screen.findByText(/Queued 24 new deliveries/);
    // The confirm button unmounted: focus moves to the outcome, not to the top of the page.
    await waitFor(() =>
      expect(queued.closest('[tabindex="-1"]')?.contains(document.activeElement)).toBe(true),
    );
    expect(screen.getByText('1 had already been sent again earlier.')).toBeTruthy();
    expect(screen.getByText('5 more are waiting for another round.')).toBeTruthy();
    await expectClean('bulk redeliver result');
  });

  it('is not offered on other views, and can be cancelled', async () => {
    const user = userEvent.setup();
    await renderApp('/activity');
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: 'Redeliver all failed' })).toBeNull();
    cleanup();
    await renderApp('/activity?state=dead_lettered');
    await user.click(await screen.findByRole('button', { name: 'Redeliver all failed' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await screen.findByRole('button', { name: 'Redeliver all failed' });
  });

  it('is accessible in Vietnamese', async () => {
    const user = userEvent.setup();
    await renderApp('/activity?state=dead_lettered', { locale: 'vi' });
    await user.click(await screen.findByRole('button', { name: 'Gửi lại tất cả lượt thất bại' }));
    await screen.findByText('25 lượt gửi thất bại sẽ được gửi lại dưới dạng lượt gửi mới.');
    await expectClean('bulk redeliver preview (vi)');
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
    await waitFor(() => expect(document.activeElement?.textContent).toBe(rotate.textContent));

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

describe('source credential: fingerprint and revoke (F39, F40, ADR 0049)', () => {
  const card = async (name: string) => {
    const heading = await screen.findByRole('heading', { name });
    return heading.closest('article') as HTMLElement;
  };

  it('shows the fingerprint, or says why there is none, and no revoked state', async () => {
    await renderApp('/sources');
    const ci = await card('CI pipeline');
    expect(within(ci).getByText('Fingerprint')).toBeTruthy();
    expect(within(ci).getByText('P4Q2WJ7N')).toBeTruthy();
    expect(within(ci).getByText(/A short code computed from the stored secret/)).toBeTruthy();
    expect(within(ci).queryByText('Revoked')).toBeNull();
    const billing = await card('Billing service');
    expect(within(billing).getByText(/No fingerprint is available for this secret/)).toBeTruthy();
  });

  it('is accessible, focuses Cancel first, traps Tab, closes on Escape and restores focus', async () => {
    const user = userEvent.setup();
    await renderApp('/sources');
    const ci = await card('CI pipeline');
    const trigger = within(ci).getByRole('button', { name: 'Revoke secret…' });
    await user.click(trigger);
    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke the secret for CI pipeline?' });
    await expectClean('source revoke dialog open');
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' })),
    );
    expect(within(dialog).getByText(/refuses every event/)).toBeTruthy();
    expect(within(dialog).getAllByRole('radio')).toHaveLength(3);
    expect(await tabStaysWithin(user, dialog, 8)).toBe(true);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('revokes, shows the revoked state, locks the switch and moves focus to the rotate path', async () => {
    const user = userEvent.setup();
    clearRequests();
    await renderApp('/sources');
    let ci = await card('CI pipeline');
    await user.click(within(ci).getByRole('button', { name: 'Revoke secret…' }));
    const dialog = await screen.findByRole('alertdialog');
    const radio = within(dialog).getByRole('radio', { name: 'We no longer use it' });
    await user.click(radio);
    // Enter on a reason does not revoke: only the confirm button does.
    radio.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(requests.some((r) => r.includes('/revoke-credentials'))).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Revoke secret' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    expect(requests).toContain(`POST /api/sources/src_1/revoke-credentials?org=${ORG_ID}`);
    ci = await card('CI pipeline');
    expect(await within(ci).findByText(/Secret revoked\. CI pipeline refuses every event/)).toBeTruthy();
    expect(within(ci).getByText('Revoked')).toBeTruthy();
    expect(within(ci).getByText(/Being destroyed/)).toBeTruthy();
    // The fingerprint outlives the revoke.
    expect(within(ci).getByText('P4Q2WJ7N')).toBeTruthy();
    expect(within(ci).queryByRole('button', { name: 'Revoke secret…' })).toBeNull();
    const rotate = within(ci).getByRole('button', { name: 'Rotate secret…' });
    await waitFor(() => expect(document.activeElement).toBe(rotate));
    const toggle = within(ci).getByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    expect(within(ci).getByText('Off: the secret was revoked')).toBeTruthy();
    await user.click(toggle);
    expect(requests.some((r) => r.startsWith('PATCH /api/sources/src_1'))).toBe(false);
    await expectClean('revoked source');

    // Rotate is the way back: the dialog says so, and the new secret turns the source on.
    await user.click(rotate);
    const rotateDialog = await screen.findByRole('alertdialog');
    expect(within(rotateDialog).getByText(/the source is turned back on/)).toBeTruthy();
    await user.click(within(rotateDialog).getByRole('button', { name: 'Rotate secret' }));
    await screen.findByText(/New signing secret for CI pipeline/);
    ci = await card('CI pipeline');
    await waitFor(() => expect(within(ci).queryByText('Revoked')).toBeNull());
    expect(within(ci).getByRole('switch').getAttribute('aria-checked')).toBe('true');
    expect(within(ci).queryByText(/Secret revoked\./)).toBeNull();
    expect(within(ci).getByRole('button', { name: 'Revoke secret…' })).toBeTruthy();
  });

  it('states what happened to the encrypted copy: destroyed, or kept when there is no fingerprint', async () => {
    await renderApp('/sources', {
      api: {
        sources: [
          { ...SOURCES[0], enabled: false, revoked: true, keyDestroyed: true },
          { ...SOURCES[1], revoked: true, keyDestroyed: false },
        ],
      },
    });
    expect(within(await card('CI pipeline')).getByText(/Destroyed in the live database/)).toBeTruthy();
    expect(within(await card('Billing service')).getByText(/Not destroyed yet/)).toBeTruthy();
    await expectClean('revoked sources');
  });

  it('words a provider source for its pasted credential', async () => {
    const user = userEvent.setup();
    await renderApp('/sources', {
      api: { sources: [{ ...SOURCES[0], kind: 'gitlab', authMode: 'signing_token' }] },
    });
    const ci = await card('CI pipeline');
    await user.click(within(ci).getByRole('button', { name: 'Revoke credential…' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke the credential for CI pipeline?' });
    expect(within(dialog).getByText(/create a new credential in GitLab/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Revoke credential' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await within(ci).findByText('Credential revoked')).toBeTruthy();
    expect(within(ci).getByText(/pastes a new credential from GitLab/)).toBeTruthy();
  });

  it('offers no revoke control to a member, who lacks source.revoke', async () => {
    await renderApp('/sources', { api: { me: MEMBER } });
    const ci = await card('CI pipeline');
    expect(within(ci).getByText('P4Q2WJ7N')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Revoke/ })).toBeNull();
  });

  it('is accessible in Vietnamese, with the diacritics intact', async () => {
    const user = userEvent.setup();
    await renderApp('/sources', { locale: 'vi' });
    const ci = await card('CI pipeline');
    expect(within(ci).getByText('Dấu vân tay')).toBeTruthy();
    await user.click(within(ci).getByRole('button', { name: 'Thu hồi secret…' }));
    await screen.findByRole('alertdialog', { name: 'Thu hồi secret của CI pipeline?' });
    await expectClean('source revoke dialog (vi)');
  });
});
