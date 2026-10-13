// @vitest-environment jsdom
import '../a11y/testing/environment';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUMMARY_FIELDS } from '../../../src/api/audit-view';
import { AUDIT_ACTIONS, AUDIT_SUBJECT_TYPES } from '../../../src/audit/actions';
import { audit, describeViolations } from '../a11y/testing/axe';
import { AUDIT_EVENTS, MEMBER, MULTI, OTHER_ORG_ID, ORG_ID } from '../a11y/testing/fixtures';
import { clearRequests, renderApp, requests } from '../a11y/testing/render';
import { catalogues, en } from '../i18n';
import { actionLabel, detailLabel } from './copy';
import { csvCell, toCsv } from './csv';
import { eventsToCsv } from './AuditPage';
import { validateAuditSearch } from './search';
import { parseAuditEvent } from './api';

afterEach(cleanup);
beforeEach(clearRequests);

describe('plain-language catalogue', () => {
  const ids = Object.keys(en);

  it('has a label, in both languages, for every audit action the server can record', () => {
    for (const action of AUDIT_ACTIONS) {
      const id = `audit.action.${action}`;
      expect(ids, id).toContain(id);
      expect(id in catalogues.vi, `vi ${id}`).toBe(true);
    }
  });

  it('has a label for every subject type and every allow-listed detail key', () => {
    for (const type of AUDIT_SUBJECT_TYPES) expect(ids).toContain(`audit.subject.${type}`);
    const keys = new Set(Object.values(SUMMARY_FIELDS).flatMap((fields) => Object.keys(fields)));
    for (const key of keys) {
      expect(ids, `audit.detail.${key}`).toContain(`audit.detail.${key}`);
      expect(`audit.detail.${key}` in catalogues.vi).toBe(true);
    }
  });

  it('falls back to a generic label for an action from a newer release', () => {
    expect(actionLabel('integration.create')).toBe('Integration created');
    expect(actionLabel('something.new')).toBe('Other event');
    expect(detailLabel('repo')).toBe('Repository');
  });
});

describe('CSV', () => {
  it('neutralises cells a spreadsheet would run as a formula', () => {
    for (const evil of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\t=1', '\r=1'])
      expect(csvCell(evil).replace(/^"/, '').startsWith("'"), JSON.stringify(evil)).toBe(true);
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe('"\'=HYPERLINK(""http://x"",""y"")"');
  });

  it('quotes commas, quotes and line breaks, and leaves plain text alone', () => {
    expect(csvCell('plain text')).toBe('plain text');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(toCsv(['a', 'b'], [['1', '=2']])).toBe("a,b\r\n1,'=2\r\n");
  });

  it('exports the loaded events with names and details, and no addresses or emails', () => {
    const text = eventsToCsv(AUDIT_EVENTS.map(parseAuditEvent));
    expect(text).toContain('Integration created');
    expect(text).toContain('Linh Nguyen');
    expect(text).toContain('Repository: acme/website');
    expect(text).not.toMatch(/@|\bip\b/i);
  });
});

describe('search in the URL', () => {
  it('keeps valid filters and drops anything else', () => {
    expect(
      validateAuditSearch({
        action: 'access.denied',
        outcome: 'denied',
        from: '2026-10-01',
        to: '2026-10-31',
      }),
    ).toEqual({ action: 'access.denied', outcome: 'denied', from: '2026-10-01', to: '2026-10-31' });
    expect(
      validateAuditSearch({ action: 'nope', outcome: 'x', from: 'yesterday', to: '2026-13-45' }),
    ).toEqual({});
  });
});

describe('audit log page', () => {
  it('lists events with plain-language labels, names only, and the retention note', async () => {
    await renderApp('/audit');
    const table = await screen.findByRole('table', { name: 'Audit events, newest first' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(AUDIT_EVENTS.length + 1);
    expect(within(table).getByText('Integration created')).toBeTruthy();
    expect(within(table).getByText('Linh Nguyen')).toBeTruthy();
    expect(within(table).getByText('Noti (automatic)')).toBeTruthy();
    expect(within(table).getByText('Outside user')).toBeTruthy();
    expect(within(table).getAllByText('Refused').length).toBe(2);
    // plain-language details, localised values
    expect(within(table).getByText('acme/website')).toBeTruthy();
    expect(within(table).getByText('Slack')).toBeTruthy();
    expect(screen.getByText(/kept for 365 days/)).toBeTruthy();
    expect(table.textContent).not.toMatch(/@|203\.0\.113/);
    const { blocking } = await audit();
    expect(blocking, describeViolations(blocking)).toEqual([]);
  });

  it('asks the server with the filters from the URL, in the workspace shown', async () => {
    await renderApp('/audit?action=access.denied&outcome=denied&from=2026-10-01&to=2026-10-31');
    await screen.findByRole('table');
    const asked = requests.find((r) => r.startsWith('GET /api/audit'));
    expect(asked).toBeDefined();
    const params = new URL(asked ?? '', 'http://x').searchParams;
    expect(Object.fromEntries(params)).toEqual({
      org: ORG_ID,
      action: 'access.denied',
      outcome: 'denied',
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(screen.getByLabelText<HTMLSelectElement>('What happened').value).toBe('access.denied');
  });

  it('changing a filter updates the URL and the request', async () => {
    const user = userEvent.setup();
    const rendered = await renderApp('/audit');
    await screen.findByRole('table');
    await user.selectOptions(screen.getByLabelText('Result'), 'denied');
    await waitFor(() => expect(rendered.router.state.location.search).toMatchObject({ outcome: 'denied' }));
    await waitFor(() => expect(requests.some((r) => r.includes('outcome=denied'))).toBe(true));
  });

  it('is for admins only: a member sees why, and no request is made', async () => {
    await renderApp('/audit', { api: { me: MEMBER } });
    expect(await screen.findByRole('heading', { name: 'Only admins can read the audit log' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Audit log' })).toBeNull();
    expect(requests.filter((r) => r.startsWith('GET /api/audit'))).toEqual([]);
  });

  it('shows the Audit log link to admins only', async () => {
    await renderApp('/');
    expect(await screen.findByRole('link', { name: 'Audit log' })).toBeTruthy();
    cleanup();
    await renderApp('/', { api: { me: MEMBER } });
    await screen.findByText('Get started');
    expect(screen.queryByRole('link', { name: 'Audit log' })).toBeNull();
  });

  it('shows an honest empty state, and a different one when filters hide everything', async () => {
    await renderApp('/audit', { api: { audit: [] } });
    expect(await screen.findByRole('heading', { name: 'No events yet' })).toBeTruthy();
    cleanup();
    await renderApp('/audit?outcome=denied', { api: { audit: [] } });
    expect(await screen.findByRole('heading', { name: 'No events match these filters' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Clear filters' }).length).toBeGreaterThan(0);
  });

  it('shows a failure as an error, never as an empty log', async () => {
    await renderApp('/audit', { api: { audit: 'error' } });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('We couldn’t load the audit log.');
    expect(screen.queryByRole('heading', { name: 'No events yet' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('downloads the loaded events as CSV', async () => {
    const user = userEvent.setup();
    const blobs: Blob[] = [];
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      blobs.push(b as Blob);
      return 'blob:test';
    });
    await renderApp('/audit');
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: /Download loaded events/ }));
    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.type).toContain('text/csv');
    // A byte-order mark first, so Excel reads Vietnamese as UTF-8.
    const buffer = await new Promise<ArrayBuffer>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(blobs[0] ?? new Blob());
    });
    const bytes = new Uint8Array(buffer);
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    create.mockRestore();
  });

  it('shows nothing of another workspace after a switch (admin in both)', async () => {
    const user = userEvent.setup();
    const both = {
      user: {
        ...MULTI.user,
        organizations: [
          { orgId: ORG_ID, role: 'admin', name: 'Acme Studio' },
          { orgId: OTHER_ORG_ID, role: 'admin', name: 'Bao Retail' },
        ],
      },
    };
    const bao = {
      ...AUDIT_EVENTS[0],
      id: 'au_bao',
      action: 'source.create',
      subjectType: 'source',
      subjectId: 'src_bao',
      summary: [{ key: 'kind', value: 'stripe' }],
    };
    await renderApp('/audit', {
      api: {
        me: both,
        orgs: {
          [ORG_ID]: { integrations: [], deliveries: [], members: [], audit: [...AUDIT_EVENTS] },
          [OTHER_ORG_ID]: { integrations: [], deliveries: [], members: [], audit: [bao] },
        },
      },
    });
    await screen.findByRole('cell', { name: 'Integration created' });
    await user.click(await screen.findByRole('button', { name: /Switch workspace/ }));
    await user.click(await screen.findByRole('menuitemradio', { name: /Bao Retail/ }));
    await screen.findByRole('cell', { name: 'Source created' });
    expect(screen.queryByRole('cell', { name: 'Integration created' })).toBeNull();
    expect(screen.queryByText('Minh Tran')).toBeNull();
    const after = requests.slice(requests.indexOf('POST /api/workspace/active') + 1);
    expect(after.filter((r) => r.includes(`org=${ORG_ID}`))).toEqual([]);
  });
});
