import { afterEach, describe, expect, it, vi } from 'vitest';
import { log, logLine } from '../../src/platform/log';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('log (F11/F12)', () => {
  it('emits redacted structured JSON', () => {
    const line = JSON.parse(
      logLine('info', 'delivery_attempt', {
        delivery_id: 'd1',
        webhook_url: 'https://hooks.slack.com/services/T/B/X',
      }),
    ) as Record<string, unknown>;
    expect(line).toMatchObject({
      level: 'info',
      msg: 'delivery_attempt',
      delivery_id: 'd1',
      webhook_url: '[redacted]',
    });
    expect(typeof line.ts).toBe('string');
  });

  it.each(['info', 'warn', 'error'] as const)('routes %s to the matching console method', (level) => {
    const spy = vi.spyOn(console, level).mockImplementation(() => undefined);
    log(level, 'm', { error: new Error('token=abc123') });
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]?.[0])).not.toContain('abc123');
  });
});
