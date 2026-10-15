import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOG_LINE_BUDGET_BYTES, log, logLine, withinBudget } from '../../src/platform/log';
import { REDACTED, truncateSafely } from '../../src/platform/redact';

afterEach(() => {
  vi.restoreAllMocks();
});

const bytes = (s: string): number => new TextEncoder().encode(s).byteLength;
const parse = (s: string): Record<string, unknown> => JSON.parse(s) as Record<string, unknown>;

describe('log (F11/F12)', () => {
  it('emits redacted structured JSON', () => {
    const line = parse(
      logLine('info', 'delivery_attempt', {
        delivery_id: 'd1',
        outcome: 'see https://hooks.slack.com/services/T/B/X',
      }),
    );
    expect(line).toMatchObject({
      level: 'info',
      msg: 'delivery_attempt',
      delivery_id: 'd1',
      outcome: `see https://hooks.slack.com/${REDACTED}`,
    });
    expect(typeof line.ts).toBe('string');
  });

  it.each(['info', 'warn', 'error'] as const)('routes %s to the matching console method', (level) => {
    const spy = vi.spyOn(console, level).mockImplementation(() => undefined);
    log(level, 'cron_job_failed', { job: 'j', error: new Error('token=abc123') });
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]?.[0])).not.toContain('abc123');
  });
});

describe('closed catalogue (F194)', () => {
  it('rejects an unknown event name and undeclared fields at compile time, and still redacts at run time', () => {
    // @ts-expect-error an event that is not in src/platform/log-events.ts
    expect(parse(logLine('info', 'not_a_catalogued_event')).msg).toBe('not_a_catalogued_event');
    // @ts-expect-error `webhook_url` is not a declared field of delivery_attempt
    const literal = parse(logLine('info', 'delivery_attempt', { webhook_url: 'https://x.example/secret' }));
    expect(literal.webhook_url).toBe(REDACTED);
    const report = { delivery_id: 'd1', secret_count: 3 };
    // @ts-expect-error a spread is checked too: `secret_count` is not declared
    expect(parse(logLine('info', 'delivery_attempt', { ...report })).secret_count).toBe(REDACTED);
  });

  it('a field can never overwrite ts, level or msg', () => {
    const forged = { ts: 'then', level: 'debug', msg: 'forged' } as never;
    const line = parse(logLine('warn', 'delivery_not_found', forged));
    expect(line.msg).toBe('delivery_not_found');
    expect(line.level).toBe('warn');
    expect(line.ts).not.toBe('then');
  });
});

describe('per-line byte budget (F194)', () => {
  it('leaves a normal line untouched', () => {
    const line = parse(logLine('info', 'delivery_attempt', { delivery_id: 'd1', attempt: 2 }));
    expect(line).not.toHaveProperty('log_truncated');
  });

  it('shortens string values of an oversized line and keeps it valid JSON within budget', () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 'x'.repeat(500)]));
    const text = logLine('error', 'cron_job_failed', { job: 'retention', error: many });
    expect(bytes(text)).toBeLessThanOrEqual(LOG_LINE_BUDGET_BYTES);
    const line = parse(text);
    expect(line).toMatchObject({ msg: 'cron_job_failed', level: 'error', log_truncated: 'values' });
    expect(String((line.error as Record<string, unknown>).k0)).toMatch(/…\[truncated \d+ chars\]$/);
  });

  it('drops fields when shortening is not enough, keeping ts, level, msg and correlation', () => {
    const wide = Array.from({ length: 50 }, () =>
      Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i])),
    );
    const line = parse(
      withinBudget({ ts: 't', level: 'info', msg: 'noise_release', correlation_id: 'c1', units: wide }),
    );
    expect(line).toEqual({
      ts: 't',
      level: 'info',
      msg: 'noise_release',
      correlation_id: 'c1',
      log_truncated: 'fields_dropped',
      dropped_fields: 1,
    });
  });

  it('measures UTF-8 bytes, not characters', () => {
    // About 3,600 characters but over 10,000 bytes: `ế` is three bytes in UTF-8.
    const wide = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`k${i}`, 'ế'.repeat(500)]));
    const text = logLine('error', 'cron_job_failed', { job: 'j', error: wide });
    expect(text.length).toBeLessThan(LOG_LINE_BUDGET_BYTES);
    expect(bytes(text)).toBeLessThanOrEqual(LOG_LINE_BUDGET_BYTES);
    expect(parse(text).log_truncated).toBe('values');
  });

  it('never splits a redaction marker when a scrubbed value is shortened', () => {
    const scrubbed = parse(
      logLine('info', 'signup_refused', {
        reason: Array.from({ length: 400 }, (_, i) => `https://h${i}.example/p token=abc${i}`).join(' '),
      }),
    ).reason as string;
    expect(scrubbed).toContain(REDACTED);
    // Remove every whole marker: no bracket may remain, so none was cut in half.
    expect(scrubbed.replace(/…?\[[^[\]\n]{1,40}\]/g, '')).not.toMatch(/[[\]]/);
    expect(scrubbed).not.toMatch(/abc\d/);
  });
});

describe('truncateSafely', () => {
  it('backs off to before a marker the cut would split', () => {
    expect(truncateSafely(`abc${REDACTED}def`, 6)).toBe(`abc…[truncated ${REDACTED.length + 3} chars]`);
    expect(truncateSafely(`abc${REDACTED}def`, 13)).toBe(`abc${REDACTED}…[truncated 3 chars]`);
  });

  it('does not split a surrogate pair', () => {
    expect(truncateSafely('a😀b', 2)).toBe('a…[truncated 3 chars]');
  });

  it('returns short values as they are', () => {
    expect(truncateSafely('short', 16)).toBe('short');
  });
});
