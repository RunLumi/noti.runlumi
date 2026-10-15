import { afterEach, describe, expect, it, vi } from 'vitest';
import { ERROR_CODES, ERROR_TAXONOMY } from '../../../src/platform/errors';
import { ApiError } from '../lib/api';
import { en } from '../i18n/messages.en';
import { vi as viMessages } from '../i18n/messages.vi';
import { t } from '../i18n';
import { DELIVERY_STATES, parseDelivery, type DeliveryError } from './api';
import { STATE_LABEL, STATE_MEANING, describeDeliveryError, failureCopy } from './copy';
import { hasFilters, toFilters, validateActivitySearch } from './search';
import { absoluteTime, relativeTime } from './Time';
import { REVOKE_DELAY_MS, downloadExport, parseDeletion, safeFileName } from '../workspace/api';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'd1',
  integration: {
    id: 'i1',
    name: 'Alerts',
    repo: 'acme/web',
    destination: 'slack',
    destinationHost: 'hooks.slack.com',
  },
  integrationExists: true,
  integrationStatus: 'available',
  state: 'dead_lettered',
  attempts: 3,
  error: {
    code: 'destination_revoked',
    messageKey: 'errors.destination_revoked',
    retryable: false,
    userActionable: true,
  },
  createdAt: '2026-10-13T10:00:00.000Z',
  updatedAt: '2026-10-13T11:00:00.000Z',
  nextAttemptAt: null,
  replayOf: null,
  latestReplayState: null,
  canReplay: true,
  ...over,
});

describe('failure copy', () => {
  it('has catalogue copy for every code the server can surface (F13, F220)', () => {
    for (const code of ERROR_CODES) {
      const key = ERROR_TAXONOMY[code].messageKey;
      if (key === null) continue;
      expect(Object.keys(en), `${code} -> ${key}`).toContain(key);
      const error: DeliveryError = { code, messageKey: key, retryable: false, userActionable: false };
      const text = failureCopy(error, 'slack');
      expect(text).toBeTruthy();
      expect(text).not.toMatch(/undefined|«|\{/);
    }
  });

  it('never leads with a taxonomy code, an HTTP status or a stack trace', () => {
    for (const code of ERROR_CODES) {
      const key = ERROR_TAXONOMY[code].messageKey;
      if (key === null) continue;
      const text =
        failureCopy({ code, messageKey: key, retryable: false, userActionable: false }, 'lark') ?? '';
      expect(text).not.toContain(code);
      expect(text).not.toMatch(/\bHTTP\b|\b[45]\d\d\b|\bat \w+\.\w+/);
      expect(text).not.toMatch(/^(invalid|error|unexpected)/i);
    }
  });

  it('ignores a message id the catalogue does not have instead of showing it', () => {
    const unknown: DeliveryError = {
      code: 'x',
      messageKey: 'errors.not_a_thing',
      retryable: false,
      userActionable: false,
    };
    expect(failureCopy(unknown, 'slack')).toBeNull();
    expect(failureCopy({ ...unknown, messageKey: null }, null)).toBeNull();
  });

  it('names the destination from our catalogue, never from the server', () => {
    const e: DeliveryError = {
      code: 'destination_revoked',
      messageKey: 'errors.destination_revoked',
      retryable: false,
      userActionable: true,
    };
    expect(failureCopy(e, 'slack')).toContain('Slack');
    expect(failureCopy(e, 'lark')).toContain('Lark');
  });
});

describe('delivery states', () => {
  it('give every state its own distinct label, so Accepted is never shown as Delivered', () => {
    const labels = DELIVERY_STATES.map((s) => t(STATE_LABEL[s]));
    expect(new Set(labels).size).toBe(DELIVERY_STATES.length);
    expect(t(STATE_LABEL.accepted)).not.toBe(t(STATE_LABEL.sent));
    expect(t(STATE_MEANING.accepted)).toMatch(/cannot confirm/);
  });

  it('states the at-least-once model without promising exactly-once', () => {
    expect(en['deliveries.model']).toMatch(/at least once/);
    expect(en['deliveries.model']).toMatch(/more than once/);
    expect(en['redeliver.body']).toMatch(/more than once/);
    expect(JSON.stringify(en)).not.toMatch(/exactly[- ]once/i);
  });
});

describe('parseDelivery', () => {
  it('accepts a server row and keeps only known fields', () => {
    expect(parseDelivery(row())).toMatchObject({ id: 'd1', state: 'dead_lettered', canReplay: true });
  });

  it('rejects a malformed or unknown-state row instead of dropping it', () => {
    expect(() => parseDelivery(row({ state: 'exploded' }))).toThrow(ApiError);
    expect(() => parseDelivery(row({ attempts: '3' }))).toThrow(ApiError);
    expect(() => parseDelivery(null)).toThrow(ApiError);
    expect(() => parseDelivery(row({ integrationStatus: 'gone' }))).toThrow(ApiError);
    expect(() => parseDelivery(row({ integrationStatus: undefined }))).toThrow(ApiError);
    expect(() => parseDelivery(row({ error: { code: 1 } }))).toThrow(ApiError);
  });

  it('keeps the request id the server sent, and drops one it would not accept (ADR 0050)', () => {
    expect(parseDelivery(row({ correlationId: 'req_7Hq2mX9pLk' })).correlationId).toBe('req_7Hq2mX9pLk');
    expect(parseDelivery(row({ correlationId: null })).correlationId).toBeNull();
    expect(parseDelivery(row()).correlationId).toBeNull();
    expect(parseDelivery(row({ correlationId: 'a b<script>' })).correlationId).toBeNull();
    expect(parseDelivery(row({ correlationId: 'x'.repeat(65) })).correlationId).toBeNull();
  });
});

describe('held-delivery reasons (ADR 0029)', () => {
  const reasons = ['circuit_open', 'destination_paced', 'platform_paused', 'workspace_paused'] as const;

  it.each(reasons)('parseDelivery keeps pausedReason %s', (reason) => {
    expect(parseDelivery(row({ pausedReason: reason })).pausedReason).toBe(reason);
  });

  it('parseDelivery drops an unknown pausedReason', () => {
    expect(parseDelivery(row({ pausedReason: 'exploded' })).pausedReason).toBeNull();
  });

  it.each(reasons)(
    'the detail line and the attempt line for %s exist in English and Vietnamese',
    (reason) => {
      for (const catalogue of [en, viMessages] as Record<string, unknown>[]) {
        expect(catalogue[`delivery.detail.paused.${reason}`], reason).toEqual(expect.any(String));
        expect(catalogue[`attempts.reason.${reason}`], reason).toEqual(expect.any(String));
      }
    },
  );

  it('the attempt timeline maps every held reason and its 24-hour stop to a message', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./AttemptTimeline.tsx', import.meta.url), 'utf8');
    for (const r of reasons) {
      expect(source, r).toContain(`${r}: 'attempts.reason.${r}'`);
      expect(source, `${r}_timeout`).toContain(`${r}_timeout: 'attempts.reason.${r}_timeout'`);
    }
  });

  it.each(['circuit_open', 'destination_paced', 'platform_paused', 'workspace_paused'])(
    'the 24-hour stop line for %s exists in English and Vietnamese',
    (reason) => {
      for (const catalogue of [en, viMessages] as Record<string, unknown>[])
        expect(catalogue[`attempts.reason.${reason}_timeout`], reason).toEqual(expect.any(String));
    },
  );
});

describe('activity filters in the URL', () => {
  it('round-trip valid values', () => {
    const search = validateActivitySearch({
      state: 'dead_lettered',
      integration: 'i1',
      from: '2026-10-01',
      to: '2026-10-13',
    });
    expect(search).toEqual({
      state: 'dead_lettered',
      integration: 'i1',
      from: '2026-10-01',
      to: '2026-10-13',
    });
    expect(toFilters(search)).toEqual({
      state: 'dead_lettered',
      integrationId: 'i1',
      from: '2026-10-01',
      to: '2026-10-13',
    });
    expect(hasFilters(search)).toBe(true);
  });

  it('drops anything invalid rather than trusting it', () => {
    expect(
      validateActivitySearch({
        state: 'nope',
        integration: 'x'.repeat(65),
        from: 'yesterday',
        to: '2026-13-45',
      }),
    ).toEqual({});
    expect(hasFilters({})).toBe(false);
  });

  it('carry a request id to the server only in the shape the server accepts (ADR 0050)', () => {
    const search = validateActivitySearch({ correlationId: 'req_7Hq2mX9pLk' });
    expect(search).toEqual({ correlationId: 'req_7Hq2mX9pLk' });
    expect(toFilters(search)).toEqual({ correlationId: 'req_7Hq2mX9pLk' });
    expect(hasFilters(search)).toBe(true);
    for (const bad of ['abc', 'has space', '-leading', 'x'.repeat(65), 42])
      expect(validateActivitySearch({ correlationId: bad })).toEqual({});
  });
});

describe('time text', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  it('is relative for scanning and falls back to the raw value when unparseable', () => {
    expect(relativeTime('2026-10-13T09:00:00Z', now)).toBe('3 hours ago');
    expect(relativeTime('2026-10-11T12:00:00Z', now)).toBe('2 days ago');
    expect(relativeTime('2026-10-13T12:00:20Z', now)).toBe('just now');
    expect(relativeTime('not a date', now)).toBe('not a date');
    expect(absoluteTime('not a date')).toBe('not a date');
  });
});

describe('delivery errors', () => {
  it('speak about deliveries, not integrations, for 404 and 409', () => {
    expect(describeDeliveryError(new ApiError('Not found', 404)).message).toBe(
      en['deliveries.error.notFound'],
    );
    expect(
      describeDeliveryError(new ApiError('This delivery already reached its destination.', 409)).message,
    ).toBe('This delivery already reached its destination.');
    expect(describeDeliveryError(new ApiError('Missing capability: delivery.replay', 403)).message).toBe(
      en['error.forbidden'],
    );
  });
});

describe('workspace data helpers', () => {
  it('reads the deletion status and refuses a malformed one', () => {
    expect(parseDeletion({ scheduled: false })).toEqual({ scheduled: false });
    expect(
      parseDeletion({ scheduled: true, requestedAt: 'a', purgeAfter: 'b', purgeStarted: false }),
    ).toMatchObject({ scheduled: true, purgeStarted: false });
    expect(() => parseDeletion({ scheduled: true })).toThrow(ApiError);
    expect(() => parseDeletion(null)).toThrow(ApiError);
  });

  it('reduces a download name to safe characters', () => {
    expect(safeFileName('attachment; filename="lumi-noti-export-org_1.json"')).toBe(
      'lumi-noti-export-org_1.json',
    );
    expect(safeFileName('attachment; filename="../../etc/passwd"')).toBe('.._.._etc_passwd');
    expect(safeFileName(null)).toBe('lumi-noti-export.json');
  });

  it('explains the 7-day window and the 30-day backup caveat', () => {
    expect(en['workspace.danger.point3']).toMatch(/7 days/);
    expect(en['workspace.danger.backup']).toMatch(/30 days/);
    expect(en['workspace.danger.backup']).toMatch(/Time Travel/);
  });
});

describe('redelivery that could not be delivered', () => {
  it('has a message for every integration state that blocks it', () => {
    for (const status of ['missing', 'disabled', 'quarantined'] as const) {
      const key = `redeliver.integration.${status}`;
      expect(Object.keys(en)).toContain(key);
    }
    expect(parseDelivery(row({ integrationStatus: 'disabled', canReplay: false })).integrationStatus).toBe(
      'disabled',
    );
  });
});

describe('export download', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('revokes the blob URL only after a delay, not straight after the click', async () => {
    vi.useFakeTimers();
    const revoke = vi.fn();
    const link = { click: vi.fn(), remove: vi.fn(), href: '', download: '' };
    vi.stubGlobal('document', { createElement: () => link, body: { append: vi.fn() } });
    vi.stubGlobal(
      'URL',
      Object.assign(function URLStub() {}, { createObjectURL: () => 'blob:x', revokeObjectURL: revoke }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response('{}', { headers: { 'content-disposition': 'attachment; filename="x.json"' } }),
        ),
      ),
    );
    await downloadExport('org-a');
    expect(link.click).toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(REVOKE_DELAY_MS - 1);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revoke).toHaveBeenCalledWith('blob:x');
    expect(REVOKE_DELAY_MS).toBeGreaterThanOrEqual(1000);
  });
});
