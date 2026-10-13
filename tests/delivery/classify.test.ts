import { describe, expect, it } from 'vitest';
import { DELIVERY_REASONS, type ClassifiedResponse } from '../../src/connectors/destinations';
import { REASON_CODES, attemptFromClassification, isUnconfirmedReply } from '../../src/delivery/classify';
import { isRetryable } from '../../src/platform/errors';

/**
 * The adapters classify provider responses; this module only translates that verdict into
 * the F13 taxonomy and the retry policy's input (ADR 0006, F179).
 */
const failures = DELIVERY_REASONS.filter((r) => r !== 'ok');

describe('REASON_CODES', () => {
  it('maps every adapter failure reason', () => {
    expect(Object.keys(REASON_CODES).sort()).toEqual([...failures].sort());
  });

  it.each(failures)('keeps retryability identical to the code it maps to (%s)', (reason) => {
    // Retryable reasons are exactly those whose F13 code is retryable, so the two layers
    // can never disagree about whether to retry.
    const retryableReasons = new Set([
      'destination_rate_limited',
      'destination_unavailable',
      'destination_timeout',
      'network_error',
      'unmapped_response',
      'internal_error',
    ]);
    expect(isRetryable(REASON_CODES[reason])).toBe(retryableReasons.has(reason));
  });
});

const ctx = (status: number | null, bodyText = '') => (status === null ? null : { status, bodyText });

describe('attemptFromClassification', () => {
  it('delivered and accepted stay distinct (F100)', () => {
    const delivered = attemptFromClassification({ outcome: 'delivered', reason: 'ok' }, 'slack', ctx(200));
    expect(delivered.outcome).toEqual({ kind: 'delivered' });
    const accepted = attemptFromClassification({ outcome: 'accepted', reason: 'ok' }, 'teams', ctx(202));
    expect(accepted.outcome).toEqual({ kind: 'accepted' });
    expect(accepted.diagnostic).toBeNull();
  });

  it('turns Retry-After milliseconds into whole seconds, rounding up', () => {
    const c: ClassifiedResponse = {
      outcome: 'retryable',
      reason: 'destination_rate_limited',
      retryAfterMs: 1500,
    };
    expect(attemptFromClassification(c, 'slack', ctx(429)).outcome).toEqual({
      kind: 'failed',
      code: 'destination_rate_limited',
      retryAfterSeconds: 2,
    });
  });

  it('mints diagnostics from our own codes only', () => {
    const lark = attemptFromClassification(
      { outcome: 'permanent', reason: 'signature_rejected', providerCode: '19021' },
      'lark',
      ctx(200),
    );
    expect(lark.diagnostic).toBe('provider_lark_19021');
    const http = attemptFromClassification(
      { outcome: 'retryable', reason: 'destination_unavailable' },
      'slack',
      ctx(503),
    );
    expect(http.diagnostic).toBe('provider_http_503');
    const redirect = attemptFromClassification(
      { outcome: 'permanent', reason: 'destination_redirected' },
      'teams',
      ctx(302),
    );
    expect(redirect).toMatchObject({
      outcome: { kind: 'failed', code: 'destination_url_rejected' },
      diagnostic: 'provider_redirect_302',
    });
  });

  it('classifies requests that never completed without keeping platform text', () => {
    expect(
      attemptFromClassification({ outcome: 'retryable', reason: 'destination_timeout' }, 'lark', null)
        .diagnostic,
    ).toBe('provider_timeout');
    expect(
      attemptFromClassification({ outcome: 'retryable', reason: 'network_error' }, 'lark', null).diagnostic,
    ).toBe('transient_error');
    expect(
      attemptFromClassification({ outcome: 'permanent', reason: 'destination_url_rejected' }, 'lark', null)
        .diagnostic,
    ).toBe('destination_not_allowed');
  });

  it('carries the unmapped flag so a metric can name it (F13)', () => {
    const r = attemptFromClassification(
      { outcome: 'retryable', reason: 'unmapped_response', unmapped: true },
      'slack',
      ctx(418),
    );
    expect(r).toMatchObject({ unmapped: true, outcome: { kind: 'failed', code: 'internal_error' } });
  });

  it('never lets a permanent verdict become a retry, or the reverse', () => {
    const permanentOnRetryableCode = attemptFromClassification(
      { outcome: 'permanent', reason: 'internal_error' },
      'slack',
      ctx(500),
    );
    expect(permanentOnRetryableCode.outcome).toMatchObject({ kind: 'failed', code: 'config_invalid' });
    const retryableOnPermanentCode = attemptFromClassification(
      { outcome: 'retryable', reason: 'destination_revoked' },
      'slack',
      ctx(404),
    );
    expect(retryableOnPermanentCode.outcome).toMatchObject({ kind: 'failed', code: 'internal_error' });
  });
});

describe('unconfirmed 2xx replies (F100)', () => {
  const unmapped: ClassifiedResponse = { outcome: 'retryable', reason: 'unmapped_response', unmapped: true };

  it('records an unreadable 2xx as accepted instead of retrying into a duplicate', () => {
    expect(isUnconfirmedReply('lark', { status: 200, bodyText: '<html>ok</html>' }, unmapped)).toBe(true);
    const r = attemptFromClassification(unmapped, 'lark', ctx(200, '<html>ok</html>'));
    expect(r).toEqual({
      outcome: { kind: 'accepted' },
      diagnostic: 'provider_reply_unreadable',
      unmapped: true,
    });
  });

  it('keeps a Lark rejection with an unknown numeric code retryable', () => {
    expect(isUnconfirmedReply('lark', { status: 200, bodyText: '{"code":99999}' }, unmapped)).toBe(false);
    expect(attemptFromClassification(unmapped, 'lark', ctx(200, '{"code":99999}')).outcome.kind).toBe(
      'failed',
    );
  });

  it('never applies to a non-2xx response', () => {
    expect(isUnconfirmedReply('slack', { status: 418, bodyText: '' }, unmapped)).toBe(false);
  });
});
