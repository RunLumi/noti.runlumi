import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ERROR_CODE,
  ERROR_CODES,
  ERROR_TAXONOMY,
  TAXONOMY_VERSION,
  assertNever,
  classifyUnmappedHttpStatus,
  errorClass,
  errorSpec,
  httpStatusFor,
  isErrorCode,
  isRetryable,
  toErrorCode,
  userMessageKey,
  type ErrorCode,
} from '../../src/platform/errors';

const RETRYABLE: readonly ErrorCode[] = [
  'destination_rate_limited',
  'destination_unavailable',
  'destination_timeout',
  'internal_error',
];
const NEVER_SURFACES: readonly ErrorCode[] = [
  'signature_invalid',
  'timestamp_out_of_tolerance',
  'replay_detected',
  'unauthorized_tenant',
];

describe('error taxonomy (F13)', () => {
  it('is versioned and defaults to internal_error', () => {
    expect(TAXONOMY_VERSION).toBe(1);
    expect(DEFAULT_ERROR_CODE).toBe('internal_error');
  });

  it('covers every code, each one time', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    expect(Object.keys(ERROR_TAXONOMY).sort()).toEqual([...ERROR_CODES].sort());
  });

  it.each(ERROR_CODES)('%s: retryable flag matches its class', (code) => {
    const expected = RETRYABLE.includes(code);
    expect(isRetryable(code)).toBe(expected);
    expect(errorClass(code)).toBe(expected ? 'retryable' : 'permanent');
    expect(errorSpec(code).retryable).toBe(expected);
  });

  it.each(ERROR_CODES)('%s: has a valid HTTP status', (code) => {
    const status = httpStatusFor(code);
    expect(status).toBeGreaterThanOrEqual(200);
    expect(status).toBeLessThan(600);
    // A provider throttle must never look like *our* rate limit.
    expect(status).not.toBe(429);
  });

  it.each(ERROR_CODES)('%s: user copy is a catalogue id, or absent for boundary codes', (code) => {
    const key = userMessageKey(code);
    if (NEVER_SURFACES.includes(code)) {
      expect(key).toBeNull();
    } else {
      expect(key).toMatch(/^errors\.[a-z_]+$/);
    }
  });

  it('maps verification-boundary codes to the documented statuses', () => {
    expect(httpStatusFor('signature_invalid')).toBe(401);
    expect(httpStatusFor('unauthorized_tenant')).toBe(403);
    expect(httpStatusFor('replay_detected')).toBe(200);
    expect(httpStatusFor('internal_error')).toBe(500);
  });

  it('user-actionable codes are exactly the ones the user can fix', () => {
    const actionable = ERROR_CODES.filter((c) => errorSpec(c).userActionable);
    expect(actionable.sort()).toEqual(
      [
        'config_invalid',
        'destination_credentials_invalid',
        'destination_revoked',
        'destination_unauthorized',
        'destination_url_rejected',
        'payload_too_large',
        'render_failed',
      ].sort(),
    );
  });

  it('narrows untrusted values', () => {
    expect(isErrorCode('destination_revoked')).toBe(true);
    expect(isErrorCode('HTTP 500')).toBe(false);
    expect(isErrorCode(42)).toBe(false);
    expect(toErrorCode('destination_timeout')).toBe('destination_timeout');
    expect(toErrorCode('something new')).toBe('internal_error');
    expect(toErrorCode(undefined)).toBe('internal_error');
  });

  it.each([
    [429, 'destination_rate_limited'],
    [410, 'destination_revoked'],
    [500, 'destination_unavailable'],
    [503, 'destination_unavailable'],
    [599, 'destination_unavailable'],
    [400, 'internal_error'],
    [404, 'internal_error'],
    [600, 'internal_error'],
    [200, 'internal_error'],
  ] as const)('unmapped HTTP %i falls back to %s and is flagged', (status, code) => {
    expect(classifyUnmappedHttpStatus(status)).toEqual({ code, unmapped: true });
  });

  it('assertNever throws for an impossible value', () => {
    expect(() => assertNever('x' as never, 'thing')).toThrow('Unhandled thing: x');
  });
});
