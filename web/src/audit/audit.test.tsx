// @vitest-environment jsdom
import '../a11y/testing/environment';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUMMARY_FIELDS } from '../../../src/api/audit-view';
import { AUDIT_ACTIONS, AUDIT_SUBJECT_TYPES } from '../../../src/audit/actions';
import { audit, describeViolations } from '../a11y/testing/axe';
import {
  AUDIT_EVENTS,
  INSTALLATION_AUDIT_EVENTS,
  MEMBER,
  MULTI,
  OTHER_ORG_ID,
  ORG_ID,
} from '../a11y/testing/fixtures';
import { clearRequests, renderApp, requests } from '../a11y/testing/render';
import { catalogues, en } from '../i18n';
import { actionLabel, actorLabel, detailLabel } from './copy';
import { csvCell, toCsv } from './csv';
import { eventsToCsv } from './AuditPage';
import { validateAuditSearch } from './search';
import { setLocale } from '../i18n/locale';
import { parseAuditEvent } from './api';
import { changePairs } from './copy';

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

describe('search in the URL: actor, target and request id', () => {
  it('keeps well-formed ones and drops the rest, so nothing odd reaches the server', () => {
    expect(
      validateAuditSearch({
        actor: 'user_9',
        target: 'acme/website',
        targetType: 'repository',
        correlationId: 'req_8f3a2c91',
      }),
    ).toEqual({
      actor: 'user_9',
      target: 'acme/website',
      targetType: 'repository',
      correlationId: 'req_8f3a2c91',
    });
    expect(
      validateAuditSearch({ actor: 'a b', target: 'x\u0000y', targetType: 'nope', correlationId: "x'; --" }),
    ).toEqual({});
    expect(validateAuditSearch({ actor: 'a'.repeat(65), correlationId: 'ab' })).toEqual({});
  });
});

describe('field diff and request id', () => {
  const update = () => parseAuditEvent(AUDIT_EVENTS.find((e) => e.id === 'au_5'));

  it('parses the changes and the request id, and tolerates a row without them', () => {
    const event = update();
    expect(event.correlationId).toBe('req_8f3a2c91');
    expect(event.changes).toHaveLength(3);
    const old = parseAuditEvent({ ...AUDIT_EVENTS[0], correlationId: undefined, changes: undefined });
    expect(old.correlationId).toBeNull();
    expect(old.changes).toEqual([]);
    // A malformed change is dropped, never rendered.
    const odd = parseAuditEvent({ ...AUDIT_EVENTS[0], changes: [{ field: 'x' }, { kind: 'list' }, 5] });
    expect(odd.changes).toEqual([]);
  });

  it('writes the diff as plain before-and-after lines', () => {
    expect(changePairs(update()).map((p) => `${p.label}: ${p.text}`)).toEqual([
      'Turned on: from Yes to No',
      'Repository: from acme/website to acme/shop',
      'Updates added: workflow_run.timed_out',
      'Updates removed: pull_request.opened',
    ]);
  });

  it('shows what an update changed, and the request it was made in', async () => {
    await renderApp('/audit');
    const table = await screen.findByRole('table', { name: 'Audit events, newest first' });
    expect(within(table).getByText('Turned on')).toBeTruthy();
    expect(within(table).getByText('from Yes to No')).toBeTruthy();
    expect(within(table).getByText('from acme/website to acme/shop')).toBeTruthy();
    expect(within(table).getByText('workflow_run.timed_out')).toBeTruthy();
    expect(within(table).getByText('req_8f3a2c91')).toBeTruthy();
  });

  it('includes the diff and the request id in the CSV, still without addresses', () => {
    const text = eventsToCsv(AUDIT_EVENTS.map(parseAuditEvent));
    expect(text).toContain('Request ID');
    expect(text).toContain('req_8f3a2c91');
    expect(text).toContain('Turned on: from Yes to No');
    expect(text).not.toMatch(/@|\bip\b/i);
  });
});

describe('audit log page', () => {
  it('lists events with plain-language labels, names only, and the retention note', async () => {
    await renderApp('/audit');
    const table = await screen.findByRole('table', { name: 'Audit events, newest first' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(AUDIT_EVENTS.length + 1);
    expect(within(table).getByText('Integration created')).toBeTruthy();
    expect(within(table).getAllByText('Linh Nguyen').length).toBe(2);
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

  it('shows how many events match, and asks for the member list by workspace', async () => {
    await renderApp('/audit');
    await screen.findByRole('table');
    expect(screen.getByText(/\d+ events match\./)).toBeTruthy();
    expect(requests.some((r) => r === `GET /api/workspace/team?org=${ORG_ID}`)).toBe(true);
    const actor = screen.getByLabelText<HTMLSelectElement>('Who');
    expect([...actor.options].map((o) => o.textContent)).toEqual(
      expect.arrayContaining(['Anyone', 'Noti (automatic)', 'Linh Nguyen', 'Minh Tran']),
    );
    // Names only: no member's email is on the page.
    const form = screen.getByRole('search', { name: 'Filter audit events' });
    expect(form.textContent).not.toMatch(/@/);
  });

  it('asks the server with the actor, target and request id from the URL', async () => {
    await renderApp('/audit?actor=user_9&target=int_1&targetType=integration&correlationId=req_8f3a2c91');
    await screen.findByRole('table');
    const asked = requests.find((r) => r.startsWith('GET /api/audit'));
    const params = new URL(asked ?? '', 'http://x').searchParams;
    expect(Object.fromEntries(params)).toEqual({
      org: ORG_ID,
      actor: 'user_9',
      target: 'int_1',
      targetType: 'integration',
      correlationId: 'req_8f3a2c91',
    });
    expect(screen.getByLabelText<HTMLInputElement>('About (id)').value).toBe('int_1');
    expect(screen.getByLabelText<HTMLInputElement>('Request ID').value).toBe('req_8f3a2c91');
    expect(screen.getByLabelText<HTMLSelectElement>('Who').value).toBe('user_9');
  });

  it('applies a text filter on Enter, not on every keystroke, and refuses an invalid id', async () => {
    const user = userEvent.setup();
    const rendered = await renderApp('/audit');
    await screen.findByRole('table');
    const field = screen.getByLabelText('Request ID');
    await user.type(field, 'req_8f3a');
    expect(rendered.router.state.location.search).toEqual({});
    await user.type(field, '2c91{Enter}');
    await waitFor(() =>
      expect(rendered.router.state.location.search).toMatchObject({ correlationId: 'req_8f3a2c91' }),
    );
    await waitFor(() => expect(requests.some((r) => r.includes('correlationId=req_8f3a2c91'))).toBe(true));
    // An id that cannot be valid is explained and never sent.
    const request = screen.getByLabelText('Request ID');
    await user.clear(request);
    await user.type(request, 'no{Enter}');
    expect(screen.getByText(/A request ID is 4 to 64 letters/)).toBeTruthy();
    expect(request.getAttribute('aria-invalid')).toBe('true');
    expect(rendered.router.state.location.search).toMatchObject({ correlationId: 'req_8f3a2c91' });
    const { blocking } = await audit();
    expect(blocking, describeViolations(blocking)).toEqual([]);
  });

  it('"Show events about this" and "Show events from this request" set one filter in a click', async () => {
    const user = userEvent.setup();
    const rendered = await renderApp('/audit');
    const table = await screen.findByRole('table', { name: 'Audit events, newest first' });
    const about = within(table).getAllByRole('button', { name: /Show events about Integration int_1/ });
    await user.click(about[0]);
    await waitFor(() =>
      expect(rendered.router.state.location.search).toEqual({ target: 'int_1', targetType: 'integration' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Show events from this request' }));
    await waitFor(() =>
      expect(rendered.router.state.location.search).toEqual({ correlationId: 'req_8f3a2c91' }),
    );
    expect(screen.getByLabelText<HTMLInputElement>('Request ID').value).toBe('req_8f3a2c91');
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

describe('a GitHub App installation as the actor (F222, ADR 0055)', () => {
  const rows = [...AUDIT_EVENTS, ...INSTALLATION_AUDIT_EVENTS];

  it('parses the installation actor, with or without an account login', () => {
    const [named, unnamed] = INSTALLATION_AUDIT_EVENTS.map(parseAuditEvent);
    expect(named?.actor).toEqual({ kind: 'installation', account: 'acme' });
    expect(unnamed?.actor).toEqual({ kind: 'installation', account: null });
    // An empty or malformed login is "unknown", never rendered as a blank name.
    expect(
      parseAuditEvent({ ...INSTALLATION_AUDIT_EVENTS[0], actor: { kind: 'installation', account: '' } })
        .actor,
    ).toEqual({ kind: 'installation', account: null });
    expect(
      parseAuditEvent({ ...INSTALLATION_AUDIT_EVENTS[0], actor: { kind: 'installation', account: 7 } }).actor,
    ).toEqual({ kind: 'installation', account: null });
  });

  it('names the account and says it is the GitHub App installation, never Noti or a raw id', async () => {
    await renderApp('/audit', { api: { audit: rows } });
    const table = await screen.findByRole('table', { name: 'Audit events, newest first' });
    const named = within(table)
      .getAllByRole('row')
      .find((r) => r.textContent?.includes('gi_1'));
    const who = within(named as HTMLElement).getAllByRole('cell')[2];
    expect(within(who).getByText('acme')).toBeTruthy();
    expect(within(who).getByText('GitHub App installation')).toBeTruthy();
    expect(who.textContent).not.toContain('Noti');
    const unnamed = within(table)
      .getAllByRole('row')
      .find((r) => r.textContent?.includes('gi_old'));
    const whoUnnamed = within(unnamed as HTMLElement).getAllByRole('cell')[2];
    expect(whoUnnamed.textContent).toBe('GitHub App installation');
    const { blocking } = await audit();
    expect(blocking, describeViolations(blocking)).toEqual([]);
  });

  it('is labelled in Vietnamese with the diacritics intact', async () => {
    await renderApp('/audit', { api: { audit: rows }, locale: 'vi' });
    const table = await screen.findByRole('table');
    expect(within(table).getAllByText('Bản cài đặt GitHub App').length).toBe(2);
    expect(within(table).getAllByText('acme').length).toBeGreaterThan(0);
    const { blocking } = await audit();
    expect(blocking, describeViolations(blocking)).toEqual([]);
  });

  it('writes one plain label in the CSV', () => {
    setLocale('en', { persist: false });
    expect(actorLabel({ kind: 'installation', account: 'acme' })).toBe('acme (GitHub App installation)');
    expect(actorLabel({ kind: 'installation', account: null })).toBe('GitHub App installation');
    expect(eventsToCsv(rows.map(parseAuditEvent))).toContain('acme (GitHub App installation)');
  });

  it('can be chosen in the Who filter, which keeps it in the URL and sends it to the server', async () => {
    const user = userEvent.setup();
    expect(validateAuditSearch({ actor: '~github-installation' })).toEqual({ actor: '~github-installation' });
    const rendered = await renderApp('/audit', { api: { audit: rows } });
    await screen.findByRole('table');
    await user.selectOptions(screen.getByLabelText('Who'), '~github-installation');
    await waitFor(() =>
      expect(rendered.router.state.location.search).toMatchObject({ actor: '~github-installation' }),
    );
    await waitFor(() => expect(requests.some((r) => r.includes('actor=%7Egithub-installation'))).toBe(true));
  });
});
