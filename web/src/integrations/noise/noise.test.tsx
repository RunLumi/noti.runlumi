// @vitest-environment jsdom
import '../../a11y/testing/environment';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INTEGRATIONS } from '../../a11y/testing/fixtures';
import { renderApp } from '../../a11y/testing/render';

/**
 * The quiet-hours and summaries section of integration settings, mounted in the real route tree
 * against the mock API: what it shows, what a save sends, how errors are placed, and that it
 * follows the language (ADR 0016, ADR 0013).
 */
afterEach(cleanup);

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}
let sent: Sent[];
let original: typeof fetch;
let respond: ((sent: Sent) => Response | null) | null;

beforeEach(() => {
  sent = [];
  respond = null;
  original = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = original;
});

/** Records every mutation and, when `respond` returns a Response, answers it instead of the mock. */
function spyOnWrites(): void {
  const base = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://localhost',
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      const record = {
        method,
        path: url.pathname,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
      };
      sent.push(record);
      const custom = respond?.(record) ?? null;
      if (custom) return Promise.resolve(custom);
    }
    return base(input, init);
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const section = async (): Promise<HTMLElement> => {
  const heading = await screen.findByRole('heading', {
    name: /Quiet hours and summaries|Giờ yên tĩnh và bản tóm tắt/,
  });
  const root = heading.closest('section');
  if (!root) throw new Error('section not found');
  return root;
};

describe('showing the saved settings', () => {
  it('fills every control from the integration and previews exactly what will happen', async () => {
    await renderApp('/integrations/int_6');
    const root = await section();
    const ui = within(root);
    expect(ui.getByLabelText<HTMLInputElement>('Save updates during quiet hours').checked).toBe(true);
    expect(ui.getByLabelText<HTMLInputElement>('Quiet hours start').value).toBe('22:00');
    expect(ui.getByLabelText<HTMLInputElement>('Quiet hours end').value).toBe('08:00');
    expect(ui.getByLabelText<HTMLSelectElement>('Combine updates for').value).toBe('300');
    expect(ui.getByLabelText<HTMLSelectElement>('Send non-urgent updates').value).toBe('daily');
    expect(ui.getByLabelText<HTMLSelectElement>('Time zone').value).toBe('Asia/Ho_Chi_Minh');
    expect(ui.getByLabelText<HTMLInputElement>('Tell me when a failing workflow passes again').checked).toBe(
      true,
    );
    expect(
      ui.getByText('During quiet hours Noti will hold updates and send one summary at 08:00.'),
    ).toBeTruthy();
    expect(ui.getByText(/Failures and other urgent updates are always sent right away/)).toBeTruthy();
  });

  it('says what is waiting and when it will be sent', async () => {
    await renderApp('/integrations/int_6');
    const root = await section();
    expect(await within(root).findByText(/3 updates are waiting\. Next send: /)).toBeTruthy();
  });

  it('shows an integration with no settings as everything off', async () => {
    await renderApp('/integrations/int_1');
    const root = await section();
    const ui = within(root);
    expect(ui.getByLabelText<HTMLInputElement>('Save updates during quiet hours').checked).toBe(false);
    expect(ui.queryByLabelText('Quiet hours start')).toBeNull();
    expect(ui.getByText('Every update is sent right away.')).toBeTruthy();
  });

  it('hides resolved notices for an integration that routes from a source', async () => {
    await renderApp('/integrations/int_4');
    const root = await section();
    expect(within(root).queryByLabelText('Tell me when a failing workflow passes again')).toBeNull();
  });

  it('disables resolved notices, and says why, when no failing run is selected', async () => {
    await renderApp('/integrations/int_5');
    const root = await section();
    const box = within(root).getByLabelText<HTMLInputElement>('Tell me when a failing workflow passes again');
    expect(box.disabled).toBe(true);
    expect(within(root).getByText(/Choose “workflow run failed” or “timed out”/)).toBeTruthy();
  });

  it('tells the person when the saved settings cannot be read and that updates still flow', async () => {
    const broken = { ...INTEGRATIONS[0], noiseInvalid: true };
    await renderApp('/integrations/int_1', { api: { integrations: [broken] } });
    const root = await section();
    expect(within(root).getByText('The saved settings could not be read')).toBeTruthy();
    expect(within(root).getByText(/Updates are being sent normally/)).toBeTruthy();
    // Saving is allowed straight away: it replaces the unreadable document.
    expect(
      within(root).getByRole('button', { name: 'Save settings' }).getAttribute('aria-disabled'),
    ).toBeNull();
  });
});

describe('editing and saving', () => {
  it('updates the preview as controls change, before anything is saved', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/int_1');
    const root = await section();
    const ui = within(root);
    await user.click(ui.getByLabelText('Save updates during quiet hours'));
    fireEvent.change(ui.getByLabelText('Quiet hours start'), { target: { value: '21:30' } });
    fireEvent.change(ui.getByLabelText('Quiet hours end'), { target: { value: '07:15' } });
    await user.selectOptions(ui.getByLabelText('Time zone'), 'UTC');
    expect(
      ui.getByText('During quiet hours Noti will hold updates and send one summary at 07:15.'),
    ).toBeTruthy();
    expect(ui.getByText('Unsaved changes')).toBeTruthy();
    expect(sent).toEqual([]);
  });

  it('sends the validated document, once, and confirms', async () => {
    spyOnWrites();
    const user = userEvent.setup();
    await renderApp('/integrations/int_1');
    respond = (r) =>
      r.method === 'PATCH'
        ? json({ integration: { ...INTEGRATIONS[0], noise: (r.body as { noise: unknown }).noise } })
        : null;
    const root = await section();
    const ui = within(root);
    await user.click(ui.getByLabelText('Save updates during quiet hours'));
    await user.selectOptions(ui.getByLabelText('Time zone'), 'UTC');
    await user.selectOptions(ui.getByLabelText('Combine updates for'), '900');
    await user.selectOptions(ui.getByLabelText('Send non-urgent updates'), 'hourly');
    await user.click(ui.getByRole('button', { name: 'Save settings' }));
    expect(await ui.findByText('Settings saved.')).toBeTruthy();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'PATCH', path: '/api/integrations/int_1' });
    expect(sent[0]?.body).toEqual({
      noise: {
        timezone: 'UTC',
        quietHours: { start: '22:00', end: '08:00' },
        groupWindowSec: 900,
        // No control for the maximum wait yet (ADR 0043): the stored value round-trips, 0 is "off".
        maxWaitSec: 0,
        digest: 'hourly',
        digestAt: '08:00',
        resolution: false,
      },
    });
  });

  it('turns everything off with null', async () => {
    spyOnWrites();
    const user = userEvent.setup();
    await renderApp('/integrations/int_6');
    respond = () => json({ integration: { ...INTEGRATIONS[0], id: 'int_6', noise: null } });
    const root = await section();
    const ui = within(root);
    await user.click(ui.getByRole('button', { name: 'Turn everything off' }));
    await user.click(ui.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toEqual({ noise: null });
  });

  it('does not send an invalid form, and focuses the first problem with a linked error', async () => {
    spyOnWrites();
    const user = userEvent.setup();
    await renderApp('/integrations/int_1');
    const root = await section();
    const ui = within(root);
    await user.click(ui.getByLabelText('Save updates during quiet hours'));
    const end = ui.getByLabelText<HTMLInputElement>('Quiet hours end');
    fireEvent.change(end, { target: { value: '22:00' } });
    await user.click(ui.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(document.activeElement).toBe(end));
    expect(end.getAttribute('aria-invalid')).toBe('true');
    const message = ui.getByText('Start and end must be different times.');
    expect(end.getAttribute('aria-describedby')).toContain(message.closest('[id]')?.id ?? 'missing');
    expect(sent).toEqual([]);
  });

  it('puts a server refusal next to the control it is about, in our own words', async () => {
    spyOnWrites();
    const user = userEvent.setup();
    await renderApp('/integrations/int_1');
    respond = () =>
      json(
        {
          error: 'Validation failed',
          fields: [{ field: 'noise.timezone', message: 'server wording that must not be shown' }],
        },
        422,
      );
    const root = await section();
    const ui = within(root);
    await user.click(ui.getByLabelText('Save updates during quiet hours'));
    await user.click(ui.getByRole('button', { name: 'Save settings' }));
    expect(await ui.findByText('Choose a time zone from the list.')).toBeTruthy();
    expect(screen.queryByText(/server wording/)).toBeNull();
  });

  it('is operable from the keyboard alone', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/int_1');
    const root = await section();
    const toggle = within(root).getByLabelText<HTMLInputElement>('Save updates during quiet hours');
    toggle.focus();
    await user.keyboard(' ');
    expect(toggle.checked).toBe(true);
    await user.tab();
    expect(document.activeElement).toBe(within(root).getByLabelText('Quiet hours start'));
  });
});

describe('language', () => {
  it('shows the section, the preview and the waiting count in Vietnamese', async () => {
    await renderApp('/integrations/int_6', { locale: 'vi' });
    const root = await section();
    const ui = within(root);
    expect(
      ui.getByText('Trong giờ yên tĩnh, Noti sẽ giữ cập nhật lại và gửi một bản tóm tắt lúc 08:00.'),
    ).toBeTruthy();
    expect(await ui.findByText(/3 cập nhật đang chờ\. Lần gửi tiếp theo: /)).toBeTruthy();
    expect(ui.getByLabelText('Lưu cập nhật trong giờ yên tĩnh')).toBeTruthy();
    expect(ui.getByRole('button', { name: 'Lưu cài đặt' })).toBeTruthy();
  });
});

describe('the recent-decisions list', () => {
  it('shows an update saved for later as such, and an urgent bypass in words', async () => {
    await renderApp('/integrations/int_6');
    expect(await screen.findByText('Saved for later')).toBeTruthy();
    expect(screen.getByText('Saved during quiet hours and sent in a summary.')).toBeTruthy();
    expect(screen.getByText(/Urgent: sent right away, ignoring quiet hours/)).toBeTruthy();
  });
});

describe('related copy', () => {
  it('explains that a window ending at midnight uses 00:00', async () => {
    await renderApp('/integrations/int_6');
    const root = await section();
    expect(within(root).getByText('To end at midnight, choose 00:00.')).toBeTruthy();
  });

  it('the delete confirmation says how many updates are still waiting and will be deleted', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/int_6');
    await user.click(await screen.findByRole('button', { name: 'Delete integration' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(
      await within(dialog).findByText(
        '3 updates are still waiting to be sent. They will be deleted with this integration.',
      ),
    ).toBeTruthy();
  });

  it('says nothing about waiting updates when there are none', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/int_1');
    await user.click(await screen.findByRole('button', { name: 'Delete integration' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).queryByText(/still waiting to be sent/)).toBeNull();
  });
});
