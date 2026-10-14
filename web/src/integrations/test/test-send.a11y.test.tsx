// @vitest-environment jsdom
import '../../a11y/testing/environment';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { audit, describeViolations } from '../../a11y/testing/axe';
import { INTEGRATIONS, SETUP_BLOCKED, SETUP_DONE } from '../../a11y/testing/fixtures';
import { renderApp, type RenderOptions } from '../../a11y/testing/render';

/**
 * "Send a test notification" and the setup-progress card, in the states a person reaches by
 * acting: every outcome the panel can show, scanned with axe in English and Vietnamese, with the
 * announcement and focus contract from ADR 0018 (a polite status region that exists before the
 * click; focus stays on the button).
 */
afterEach(cleanup);

async function expectClean(label: string) {
  const { blocking } = await audit();
  expect(blocking, `${label}\n${describeViolations(blocking)}`).toEqual([]);
}

const FAILURE = {
  state: 'dead_lettered',
  error: {
    code: 'destination_revoked',
    messageKey: 'errors.destination_revoked',
    retryable: false,
    userActionable: true,
  },
};

const teams = { ...INTEGRATIONS[0], destination: 'teams', destinationHost: 'prod.logic.azure.com' };

async function sendFromSettings(
  options: RenderOptions = {},
  name = /Send a test notification|Gửi thông báo thử/,
) {
  const user = userEvent.setup();
  await renderApp('/integrations/int_1', options);
  const section = await screen.findByRole('region', { name: /Send a test notification|Gửi thông báo thử/ });
  const button = within(section).getByRole('button', { name });
  await user.click(button);
  return { user, section, button };
}

describe('send a test from the integration settings', () => {
  it('sent: says what the destination confirmed, where to look, keeps focus, and is accessible', async () => {
    const { section, button } = await sendFromSettings();
    await within(section).findByText('Test sent');
    expect(within(section).getByText(/confirmed it received the message/)).toBeTruthy();
    expect(within(section).getByText(/Slack channel you chose/)).toBeTruthy();
    const live = within(section).getByRole('status', { name: 'Test result' });
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(button.textContent).toMatch(/Send another test/);
    expect(document.activeElement).toBe(button);
    await expectClean('test sent');
  });

  it('accepted by Teams: honest "accepted is not seen" copy, never "delivered"', async () => {
    const { section } = await sendFromSettings({
      api: { integrations: [teams], testDelivery: { state: 'accepted' } },
    });
    await within(section).findByText('Test accepted, not confirmed');
    expect(within(section).getByText(/without confirming that they were posted/)).toBeTruthy();
    expect(within(section).getByText(/Power Automate/)).toBeTruthy();
    expect(section.textContent).not.toMatch(/delivered/i);
    await expectClean('test accepted (teams)');
  });

  it('failed: the taxonomy explanation, a fix link, the destination docs and Activity', async () => {
    const { section } = await sendFromSettings({ api: { testDelivery: FAILURE } });
    await within(section).findByText('The test did not go through');
    expect(within(section).getByText(/This connection was removed in Slack/)).toBeTruthy();
    const fix = within(section).getByRole('link', { name: 'Replace the webhook URL' });
    expect(fix.getAttribute('href')).toBe('#credentials');
    const docs = within(section).getByRole('link', { name: /Slack’s guide to incoming webhooks/ });
    expect(docs.getAttribute('rel')).toContain('noopener');
    expect(within(section).getByRole('link', { name: 'See it in Activity' })).toBeTruthy();
    await expectClean('test failed');
  });

  it('retrying: says Noti is trying again and that nothing is needed', async () => {
    const { section } = await sendFromSettings({
      api: {
        testDelivery: {
          state: 'retrying',
          error: {
            code: 'destination_rate_limited',
            messageKey: 'errors.destination_rate_limited',
            retryable: true,
            userActionable: false,
          },
        },
      },
    });
    await within(section).findByText('The first try did not work');
    expect(within(section).getByText(/asked Noti to slow down/)).toBeTruthy();
    expect(within(section).queryByRole('link', { name: 'Replace the webhook URL' })).toBeNull();
    await expectClean('test retrying');
  });

  it('rate limited: shows the wait from Retry-After', async () => {
    const { section } = await sendFromSettings({ api: { testSend: 429 } });
    await within(section).findByText(/Wait 42 seconds/);
    await expectClean('test rate limited');
  });

  it('refused by the server (409): the integration-specific message, not the quota copy', async () => {
    const { section } = await sendFromSettings({ api: { testSend: 409 } });
    await within(section).findByText(/can’t receive a test right now/);
    expect(section.textContent).not.toMatch(/limit/i);
  });

  it('a test already running (409 test_in_flight) says so', async () => {
    const { section } = await sendFromSettings({ api: { testSend: 'in_flight' } });
    await within(section).findByText(/test is already running/);
    await expectClean('test in flight');
  });

  it('a server error is announced as an error with a support reference', async () => {
    const { section } = await sendFromSettings({ api: { testSend: 500 } });
    await within(section).findByText(/500/);
    await expectClean('test server error');
  });

  it('a paused integration cannot be tested: aria-disabled, explained, and no request is sent', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/int_2');
    const section = await screen.findByRole('region', { name: 'Send a test notification' });
    const button = within(section).getByRole('button', { name: 'Send a test notification' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(within(section).getByText(/This integration is paused/)).toBeTruthy();
    await user.click(button);
    expect(within(section).queryByText(/Sending the test/)).toBeNull();
  });

  it('an integration with quarantined credentials points at the credentials section', async () => {
    await renderApp('/integrations/int_3');
    const section = await screen.findByRole('region', { name: 'Send a test notification' });
    expect(within(section).getByText(/Paste the URL again in the credentials section/)).toBeTruthy();
    expect(within(section).getByRole('button').getAttribute('aria-disabled')).toBe('true');
  });

  it('is accessible in Vietnamese (sent, and failed with the fix)', async () => {
    const sent = await sendFromSettings({ locale: 'vi' });
    await within(sent.section).findByText('Đã gửi thử');
    await expectClean('test sent (vi)');
    cleanup();
    const failed = await sendFromSettings({ locale: 'vi', api: { testDelivery: FAILURE } });
    await within(failed.section).findByText('Thông báo thử chưa gửi được');
    expect(within(failed.section).getByRole('link', { name: 'Thay URL webhook' })).toBeTruthy();
    await expectClean('test failed (vi)');
  });
});

describe('send a test from the integration list', () => {
  it('has a per-row button named for the integration, and shows the result in the row', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations');
    const card = (await screen.findByRole('heading', { name: 'Website builds' })).closest('article');
    if (!card) throw new Error('no card');
    await user.click(
      within(card).getByRole('button', { name: 'Send a test notification for Website builds' }),
    );
    await within(card).findByText('Test sent');
    await expectClean('list row after test');
  });
});

describe('create wizard: the optional "Test it" step', () => {
  async function createThroughReview() {
    const user = userEvent.setup();
    await renderApp('/integrations/new');
    // After each step the wizard moves focus to the step heading on the next frame; typing before
    // that would lose keystrokes, so wait for it.
    const next = async () => {
      await user.click(screen.getByRole('button', { name: /Continue/ }));
      await waitFor(() => expect(document.activeElement?.classList.contains('wizard-step-title')).toBe(true));
    };
    await user.selectOptions(await screen.findByLabelText('GitHub repository'), 'repo:acme/website');
    await next();
    await screen.findByRole('group', { name: 'Where should notifications go?' });
    await user.click(screen.getByRole('radio', { name: /Slack/ }));
    await next();
    await screen.findByLabelText('Webhook URL');
    await user.type(screen.getByLabelText('Webhook URL'), 'https://hooks.slack.com/services/T000/B000/XXXX');
    await next();
    await screen.findByText(/Updates to send/);
    await next();
    await screen.findByRole('heading', { level: 2, name: /Step 5 of 7/ });
    await next();
    await user.click(await screen.findByRole('button', { name: /Create integration/ }));
    return user;
  }

  it('after saving, offers the test; skipping goes to the integration', async () => {
    const user = await createThroughReview();
    const heading = await screen.findByRole('heading', {
      level: 2,
      name: /Step 7 of 7: Test it \(optional\)/,
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.getByText(/This step is optional/)).toBeTruthy();
    const stepper = screen.getByRole('navigation', { name: 'Setup steps' });
    expect(within(stepper).getAllByRole('listitem')).toHaveLength(7);
    await expectClean('wizard test step');
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    await screen.findByRole('heading', { level: 1, name: 'New integration' });
  });

  it('testing first switches the exit to "Go to the integration"', async () => {
    const user = await createThroughReview();
    await screen.findByRole('heading', { level: 2, name: /Step 7 of 7/ });
    await user.click(screen.getByRole('button', { name: 'Send a test notification' }));
    await screen.findByText('Test sent');
    expect(screen.getByRole('button', { name: 'Go to the integration' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Skip for now' })).toBeNull();
    await expectClean('wizard test step after test');
  });
});

describe('setup progress on the Overview', () => {
  it('lists the steps from the server, says each state in words, and links only the next action', async () => {
    await renderApp('/');
    const card = (await screen.findByRole('heading', { name: 'Finish setting up' })).closest('section');
    if (!card) throw new Error('no card');
    // Six steps after the always-done workspace; "skipped" counts as settled.
    expect(within(card).getByText('4 of 6 steps done')).toBeTruthy();
    const steps = within(card).getAllByRole('listitem');
    expect(steps).toHaveLength(6);
    expect(within(steps[0]).getByText(/Done/)).toBeTruthy();
    expect(within(steps[3]).getByText(/Optional · Skipped/)).toBeTruthy();
    expect(within(steps[4]).getByText(/Next/)).toBeTruthy();
    expect(within(steps[5]).getByText(/To do/)).toBeTruthy();
    // The step title and the one primary button both lead to the next step.
    const actions = within(card).getAllByRole('link', { name: 'Send a test' });
    expect(actions.map((a) => a.getAttribute('href'))).toEqual(['/setup/test', '/setup/test']);
    await expectClean('setup progress');
  });

  it('says why a step is blocked, from the server’s reason', async () => {
    await renderApp('/', { api: { setup: SETUP_BLOCKED, githubConfigured: false, installations: [] } });
    const card = (await screen.findByRole('heading', { name: 'Finish setting up' })).closest('section');
    if (!card) throw new Error('no card');
    expect(within(card).getAllByText(/Blocked because:/).length).toBeGreaterThan(0);
    expect(within(card).getAllByText(/no GitHub App configured/).length).toBeGreaterThan(0);
    expect(within(card).getAllByRole('link', { name: 'Connect GitHub' }).length).toBeGreaterThan(0);
    await expectClean('setup blocked');
  });

  it('reports an accepted-only destination as accepted, not as confirmed', async () => {
    await renderApp('/', {
      api: {
        setup: {
          ...SETUP_DONE,
          complete: false,
          next: 'activated',
          nextAction: 'trigger_real_event',
          steps: SETUP_DONE.steps.map((s) =>
            s.id === 'test_delivered'
              ? { ...s, verification: 'accepted' }
              : s.id === 'activated'
                ? { ...s, state: 'todo', done: false, since: null }
                : s,
          ),
        },
      },
    });
    const card = (await screen.findByRole('heading', { name: 'Finish setting up' })).closest('section');
    if (!card) throw new Error('no card');
    expect(within(card).getByText(/does not confirm it was shown/)).toBeTruthy();
    await expectClean('setup accepted');
  });

  it('is accessible in Vietnamese', async () => {
    await renderApp('/', { locale: 'vi' });
    await screen.findByRole('heading', { name: 'Hoàn tất thiết lập' });
    await expectClean('setup progress (vi)');
  });

  it('shrinks to one honest line when setup is complete but no real event has come', async () => {
    await renderApp('/', {
      api: {
        setup: {
          ...SETUP_DONE,
          next: 'activated',
          nextAction: 'trigger_real_event',
          steps: SETUP_DONE.steps.map((s) =>
            s.id === 'activated' ? { ...s, state: 'todo', done: false, since: null } : s,
          ),
        },
      },
    });
    await screen.findByRole('heading', { name: 'Setup is complete' });
    expect(screen.queryByRole('heading', { name: 'Finish setting up' })).toBeNull();
  });

  it('disappears when every step is done', async () => {
    await renderApp('/', { api: { setup: SETUP_DONE } });
    await screen.findByText(/Get started/);
    expect(screen.queryByRole('heading', { name: 'Finish setting up' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Setup is complete' })).toBeNull();
  });

  it('renders nothing, and no alert, if the progress cannot be read', async () => {
    await renderApp('/', { api: { setup: 'error' } });
    await screen.findByText(/Get started/);
    expect(screen.queryByRole('heading', { name: 'Finish setting up' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the delivery log labels tests', () => {
  it('marks a test delivery', async () => {
    await renderApp('/activity');
    await screen.findByRole('table');
    expect(screen.getAllByText('Test')).toHaveLength(1);
  });
});
