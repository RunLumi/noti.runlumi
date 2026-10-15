// @vitest-environment jsdom
import './testing/environment';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { audit, describeViolations } from './testing/axe';
import { ORG_ID, clearRequests, renderApp, requests, type RenderOptions } from './testing/render';

/**
 * ADR 0050: the request id in the delivery detail dialog (slice 1.10) and the consequence counts
 * in the pause and delete confirmations (slice 1.30, F217). Real routes over the mock API, each
 * state scanned with axe and held to the dialog focus contract of F221.
 */
afterEach(cleanup);

type User = ReturnType<typeof userEvent.setup>;

async function expectClean(label: string) {
  const { blocking } = await audit();
  expect(blocking, `${label}\n${describeViolations(blocking)}`).toEqual([]);
}

async function openDetail(user: User, state: RegExp, options: RenderOptions = {}) {
  const rendered = await renderApp('/activity', options);
  const rows = await screen.findAllByRole('row');
  const row = rows.find((r) => within(r).queryByText(state));
  expect(row, 'no matching row in the fixture').toBeDefined();
  const details = options.locale === 'vi' ? /Chi tiết/ : /Details/;
  await user.click(within(row as HTMLElement).getByRole('button', { name: details }));
  const dialog = await screen.findByRole('dialog');
  return { rendered, dialog };
}

describe('request id in the delivery detail dialog', () => {
  it('shows the id in monospace under "Details for support", copyable, and is accessible', async () => {
    const user = userEvent.setup();
    const { dialog } = await openDetail(user, /^Failed$/);
    await user.click(within(dialog).getByText('Details for support'));
    const code = await within(dialog).findByText('req_7Hq2mX9pLk');
    expect(code.tagName).toBe('CODE');
    expect(code.className).toContain('mono-wrap');
    expect(within(dialog).getByText('Request ID').tagName).toBe('DT');
    await expectClean('detail with request id');

    await user.click(within(dialog).getByRole('button', { name: 'Copy request ID' }));
    expect(await navigator.clipboard.readText()).toBe('req_7Hq2mX9pLk');
    expect(await within(dialog).findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('links to the activity log filtered by that id, closes the dialog and lands on the heading', async () => {
    const user = userEvent.setup();
    const { rendered, dialog } = await openDetail(user, /^Failed$/);
    await user.click(within(dialog).getByText('Details for support'));
    const link = await within(dialog).findByRole('link', { name: 'Show every delivery from this request' });
    expect(link.getAttribute('href')).toBe('/activity?correlationId=req_7Hq2mX9pLk');
    clearRequests();
    await user.click(link);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(rendered.router.state.location.search).toEqual({ correlationId: 'req_7Hq2mX9pLk' });
    await waitFor(() =>
      expect(
        requests.some(
          (r) => r.startsWith('GET /api/deliveries?') && r.includes('correlationId=req_7Hq2mX9pLk'),
        ),
      ).toBe(true),
    );
    // The filter shows what is applied, and focus is on the page heading, not lost on <body>.
    expect(screen.getByLabelText<HTMLInputElement>('Request ID').value).toBe('req_7Hq2mX9pLk');
    await waitFor(() => expect(document.activeElement?.tagName).toBe('H1'));
    await expectClean('activity filtered by request id');
  });

  it('says plainly when a delivery has no request id, and offers no link', async () => {
    const user = userEvent.setup();
    const { dialog } = await openDetail(user, /^Delivered$/);
    await user.click(within(dialog).getByText('Details for support'));
    expect(await within(dialog).findByText(/^Not recorded\./)).toBeTruthy();
    expect(within(dialog).queryByRole('link', { name: /from this request/ })).toBeNull();
  });

  it('is accessible in Vietnamese, with the diacritics intact', async () => {
    const user = userEvent.setup();
    const { dialog } = await openDetail(user, /^Thất bại$/, { locale: 'vi' });
    await user.click(within(dialog).getByText('Chi tiết cho bộ phận hỗ trợ'));
    expect(await within(dialog).findByText('Mã yêu cầu')).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'Xem mọi lượt gửi của yêu cầu này' })).toBeTruthy();
    await expectClean('detail with request id (vi)');
  });

  it('accepts a pasted request id in the activity filter and refuses an impossible one', async () => {
    const user = userEvent.setup();
    const rendered = await renderApp('/activity');
    const field = await screen.findByLabelText('Request ID');
    await user.type(field, 'a b{Enter}');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(rendered.router.state.location.search).toEqual({});
    await user.clear(field);
    await user.type(field, 'req_7Hq2mX9pLk{Enter}');
    await waitFor(() =>
      expect(rendered.router.state.location.search).toEqual({ correlationId: 'req_7Hq2mX9pLk' }),
    );
  });
});

const settled = (dialog: HTMLElement) => within(dialog).findByText(/past deliveries stay in Activity/);

describe('pause confirmation (F217)', () => {
  it('states what is not sent yet, what may still arrive and what is kept, focusing "Keep sending"', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/int_1');
    const toggle = await screen.findByRole('switch', { name: 'Send notifications for Website builds' });
    clearRequests();
    await user.click(toggle);
    const dialog = await screen.findByRole('alertdialog', { name: 'Pause Website builds?' });
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Keep sending' })),
    );
    await settled(dialog);
    expect(within(dialog).getByText(/^3 notifications have not been sent yet\./).textContent).toContain(
      'you can redeliver them from Activity',
    );
    expect(
      within(dialog).getByText('1 notification is being sent right now and may still arrive.'),
    ).toBeTruthy();
    expect(within(dialog).getByText('1,284 past deliveries stay in Activity.')).toBeTruthy();
    expect(requests).toContain(`GET /api/integrations/int_1/impact?org=${ORG_ID}`);
    await expectClean('pause confirmation');

    // Escape changes nothing and hands focus back to the switch.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(toggle));
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(requests.some((r) => r.startsWith('PATCH'))).toBe(false);
  });

  it('pauses only on the confirm button', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/int_1');
    const toggle = await screen.findByRole('switch', { name: 'Send notifications for Website builds' });
    await user.click(toggle);
    const dialog = await screen.findByRole('alertdialog');
    clearRequests();
    await user.click(within(dialog).getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(requests.filter((r) => r.startsWith('PATCH /api/integrations/int_1'))).toHaveLength(1);
  });

  it('still lets a person pause when the count fails, and says the number is unknown', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/int_1', { api: { impact: 'error' } });
    await user.click(await screen.findByRole('switch', { name: 'Send notifications for Website builds' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(await within(dialog).findByText(/couldn’t count the notifications this affects/)).toBeTruthy();
    expect(within(dialog).queryByText(/^0 /)).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Pause' }).getAttribute('aria-disabled')).toBeNull();
    await expectClean('pause confirmation, count failed');
  });

  it('resumes at once, with no confirmation', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/int_2');
    const toggle = await screen.findByRole('switch', { name: 'Send notifications for API releases' });
    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('asks from the integration list too', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations');
    await user.click(await screen.findByRole('switch', { name: 'Send notifications for Website builds' }));
    expect(await screen.findByRole('alertdialog', { name: 'Pause Website builds?' })).toBeTruthy();
  });

  it('is accessible in Vietnamese, with the diacritics intact', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/int_1', { locale: 'vi' });
    await user.click(await screen.findByRole('switch', { name: /Website builds/ }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Tạm dừng Website builds?' });
    expect(
      await within(dialog).findByText(/^1\.284 lượt gửi trước đây vẫn nằm trong Hoạt động\.$/),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Tiếp tục gửi' })).toBeTruthy();
    await expectClean('pause confirmation (vi)');
  });
});

describe('delete confirmation (F217)', () => {
  it('states what is removed and what is kept before the delete can happen', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/int_6');
    await user.click(await screen.findByRole('button', { name: 'Delete integration' }));
    const dialog = await screen.findByRole('alertdialog', { name: /Delete Night-quiet builds\?/ });
    expect(
      await within(dialog).findByText(/^1,284 past deliveries stay in Activity as “Deleted integration”/),
    ).toBeTruthy();
    expect(within(dialog).getByText(/^3 notifications have not been sent yet\./).textContent).toContain(
      'cannot be redelivered once the integration is deleted',
    );
    expect(
      within(dialog).getByText('3 saved updates are deleted with the integration and never sent.'),
    ).toBeTruthy();
    expect(
      within(dialog).getByText('The record of why updates were sent or held back is deleted.'),
    ).toBeTruthy();
    await expectClean('delete confirmation with counts');
  });

  it('keeps Delete inert while the counts are still on their way, even with the name typed', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/int_1', { api: { pending: ['/api/integrations/int_1/impact'] } });
    await user.click(await screen.findByRole('button', { name: 'Delete integration' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Counting the notifications this affects…')).toBeTruthy();
    await user.type(within(dialog).getByLabelText(/Type Website builds to confirm/), 'Website builds');
    const confirm = within(dialog).getByRole('button', { name: 'Delete permanently' });
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    clearRequests();
    await user.click(confirm);
    expect(requests.some((r) => r.startsWith('DELETE'))).toBe(false);
  });

  it('lets the delete go ahead when the count failed, and says the number is unknown', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/int_1', { api: { impact: 'error' } });
    await user.click(await screen.findByRole('button', { name: 'Delete integration' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(await within(dialog).findByText(/couldn’t count the notifications this affects/)).toBeTruthy();
    await user.type(within(dialog).getByLabelText(/Type Website builds to confirm/), 'Website builds');
    expect(
      within(dialog).getByRole('button', { name: 'Delete permanently' }).getAttribute('aria-disabled'),
    ).toBeNull();
  });

  it('is accessible in Vietnamese', async () => {
    const user = userEvent.setup();
    await renderApp('/integrations/int_1', { locale: 'vi' });
    await user.click(await screen.findByRole('button', { name: 'Xóa tích hợp' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(await within(dialog).findByText(/với nhãn “Tích hợp đã xóa”/)).toBeTruthy();
    await expectClean('delete confirmation with counts (vi)');
  });
});
