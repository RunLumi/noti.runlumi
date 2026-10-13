import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ERROR_TAXONOMY } from '../../../src/platform/errors';
import { ApiError } from '../lib/api';
import { en } from '../i18n/messages.en';
import { t } from '../i18n';
import { DELIVERY_STATES, parseDelivery, type DeliveryError } from './api';
import { STATE_LABEL, STATE_MEANING, describeDeliveryError, failureCopy } from './copy';
import { hasFilters, toFilters, validateActivitySearch } from './search';
import { absoluteTime, relativeTime } from './Time';
import { parseDeletion, safeFileName } from '../workspace/api';

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
    expect(() => parseDelivery(row({ error: { code: 1 } }))).toThrow(ApiError);
  });
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
