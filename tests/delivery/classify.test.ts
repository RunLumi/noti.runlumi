import { describe, expect, it } from 'vitest';
import {
  classifyHttpFailure,
  classifyLarkReply,
  classifyRedirect,
  classifyThrown,
} from '../../src/delivery/classify';

const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const none = new Headers();

describe('classifyHttpFailure (F179)', () => {
  it.each([
    [401, 'destination_unauthorized', false],
    [403, 'destination_unauthorized', false],
    [404, 'destination_revoked', false],
    [408, 'destination_timeout', false],
    [410, 'destination_revoked', false],
    [413, 'payload_too_large', false],
    [429, 'destination_rate_limited', false],
    [500, 'destination_unavailable', false],
    [503, 'destination_unavailable', false],
    [400, 'internal_error', true],
    [418, 'internal_error', true],
  ] as const)('%i → %s (unmapped: %s)', (status, code, unmapped) => {
    expect(classifyHttpFailure(status, none, NOW)).toEqual({
      code,
      retryAfterSeconds: null,
      diagnostic: `provider_http_${status}`,
      unmapped,
    });
  });

  it('carries a parsed Retry-After', () => {
    const headers = new Headers({ 'retry-after': 'Tue, 13 Oct 2026 12:00:30 GMT' });
    expect(classifyHttpFailure(503, headers, NOW).retryAfterSeconds).toBe(30);
  });
});

describe('classifyLarkReply (F179)', () => {
  it('accepts code 0 and legacy StatusCode 0', () => {
    expect(classifyLarkReply({ code: 0 })).toEqual({ kind: 'delivered' });
    expect(classifyLarkReply({ StatusCode: 0 })).toEqual({ kind: 'delivered' });
  });

  it.each([
    [19021, 'destination_credentials_invalid'],
    [19022, 'destination_unauthorized'],
    [19024, 'config_invalid'],
    [230028, 'render_failed'],
    [230025, 'payload_too_large'],
    [230011, 'destination_revoked'],
    [230110, 'destination_revoked'],
    [11232, 'destination_rate_limited'],
    [230020, 'destination_rate_limited'],
    [99991400, 'destination_rate_limited'],
    [9499, 'destination_unavailable'],
  ] as const)('code %i → %s', (larkCode, code) => {
    expect(classifyLarkReply({ code: larkCode, msg: 'echoed text' })).toEqual({
      kind: 'failed',
      classified: { code, retryAfterSeconds: null, diagnostic: `provider_lark_${larkCode}`, unmapped: false },
    });
  });

  it('flags unknown codes; an unreadable 2xx body is unconfirmed, never retried', () => {
    expect(classifyLarkReply({ code: 12345 })).toMatchObject({
      kind: 'failed',
      classified: { code: 'internal_error', unmapped: true },
    });
    expect(classifyLarkReply(null)).toEqual({ kind: 'unconfirmed' });
    expect(classifyLarkReply({ code: 1.5 })).toEqual({ kind: 'unconfirmed' });
    expect(classifyLarkReply('x')).toEqual({ kind: 'unconfirmed' });
  });

  it('a redirect is a permanent url rejection', () => {
    expect(classifyRedirect(302)).toEqual({
      code: 'destination_url_rejected',
      retryAfterSeconds: null,
      diagnostic: 'provider_redirect_302',
      unmapped: false,
    });
  });
});

describe('classifyThrown', () => {
  it('a deadline is a timeout; anything else is unavailable, with no message kept', () => {
    expect(classifyThrown(new DOMException('t', 'TimeoutError')).code).toBe('destination_timeout');
    expect(classifyThrown(new DOMException('t', 'AbortError')).code).toBe('destination_timeout');
    expect(classifyThrown(new TypeError('fetch failed https://secret.test/x'))).toEqual({
      code: 'destination_unavailable',
      retryAfterSeconds: null,
      diagnostic: 'transient_error',
      unmapped: false,
    });
    expect(classifyThrown('weird').code).toBe('destination_unavailable');
  });
});
