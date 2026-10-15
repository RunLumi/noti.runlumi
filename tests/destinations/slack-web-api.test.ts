import { describe, expect, it } from 'vitest';
import { classifySlackWebApiResponse } from '../../src/connectors/destinations/slack/web-api';
import type { ProviderResponse } from '../../src/connectors/destinations/types';

/**
 * ADR 0041 / F179: Slack Web API `{ ok: false, error }` tokens map onto the closed taxonomy.
 * Every token asserted here is one recorded in docs/DESTINATION_API_REFERENCE.md section 1.3.
 */
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

function web(body: unknown, status = 200, headers: Record<string, string> = {}): ProviderResponse {
  return {
    status,
    headers: new Headers(headers),
    bodyText: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

const err = (token: string) => web({ ok: false, error: token });

describe('Slack Web API success', () => {
  it('ok:true is delivered', () => {
    expect(classifySlackWebApiResponse(web({ ok: true, ts: '1.2' }), NOW)).toEqual({
      outcome: 'delivered',
      reason: 'ok',
    });
  });
});

describe('Slack Web API transient errors', () => {
  it.each(['ratelimited', 'rate_limited'])('%s is a retryable rate limit', (token) => {
    expect(classifySlackWebApiResponse(err(token), NOW)).toEqual({
      outcome: 'retryable',
      reason: 'destination_rate_limited',
      providerCode: token,
    });
  });

  it('HTTP 429 honours Retry-After, as the generic classifier does', () => {
    const res = web({ ok: false, error: 'ratelimited' }, 429, { 'retry-after': '30' });
    expect(classifySlackWebApiResponse(res, NOW)).toMatchObject({
      outcome: 'retryable',
      reason: 'destination_rate_limited',
      retryAfterMs: 30_000,
    });
  });

  it.each([
    ['internal_error', 'destination_unavailable'],
    ['fatal_error', 'destination_unavailable'],
    ['service_unavailable', 'destination_unavailable'],
    ['request_timeout', 'destination_timeout'],
  ] as const)('%s is retryable as %s', (token, reason) => {
    expect(classifySlackWebApiResponse(err(token), NOW)).toEqual({
      outcome: 'retryable',
      reason,
      providerCode: token,
    });
  });

  it('HTTP 5xx is retryable without reading the body', () => {
    expect(classifySlackWebApiResponse(web('<html>', 503), NOW)).toMatchObject({
      outcome: 'retryable',
      reason: 'destination_unavailable',
    });
  });
});

describe('Slack Web API permanent errors', () => {
  it.each([
    ['invalid_auth', 'destination_unauthorized'],
    ['token_revoked', 'destination_unauthorized'],
    ['token_expired', 'destination_unauthorized'],
    ['account_inactive', 'destination_unauthorized'],
    ['team_not_found', 'destination_unauthorized'],
    ['ekm_access_denied', 'destination_unauthorized'],
    ['missing_scope', 'destination_unauthorized'],
    ['no_permission', 'destination_unauthorized'],
    ['not_in_channel', 'destination_unauthorized'],
    ['channel_not_found', 'destination_revoked'],
    ['is_archived', 'destination_revoked'],
    ['team_disabled', 'destination_revoked'],
    ['posting_to_general_channel_denied', 'destination_policy_blocked'],
    ['restricted_action', 'destination_policy_blocked'],
    ['restricted_action_read_only_channel', 'destination_policy_blocked'],
    ['invalid_blocks', 'payload_rejected'],
    ['invalid_blocks_format', 'payload_rejected'],
    ['no_text', 'payload_rejected'],
    ['msg_blocks_too_long', 'payload_too_large'],
  ] as const)('%s is permanent as %s', (token, reason) => {
    expect(classifySlackWebApiResponse(err(token), NOW)).toEqual({
      outcome: 'permanent',
      reason,
      providerCode: token,
    });
  });
});

describe('Slack Web API unknown and unreadable responses', () => {
  it('an unknown token is retryable, flagged unmapped, and carries no provider code', () => {
    const res = err('some_new_token');
    const c = classifySlackWebApiResponse(res, NOW);
    expect(c).toEqual({ outcome: 'retryable', reason: 'unmapped_response', unmapped: true });
    expect(c).not.toHaveProperty('providerCode');
  });

  it('msg_too_long is not invented: it stays unmapped', () => {
    expect(classifySlackWebApiResponse(err('msg_too_long'), NOW)).toMatchObject({ unmapped: true });
  });

  it('a 200 body that is not JSON is unmapped, never delivered', () => {
    expect(classifySlackWebApiResponse(web('ok'), NOW)).toMatchObject({ unmapped: true });
  });

  it('a 200 body with ok:false but no error token is unmapped', () => {
    expect(classifySlackWebApiResponse(web({ ok: false }), NOW)).toMatchObject({ unmapped: true });
  });

  it('a provider code is never taken from free text in the body', () => {
    const c = classifySlackWebApiResponse(err('invalid_auth; send token abc123'), NOW);
    expect(c).toEqual({ outcome: 'retryable', reason: 'unmapped_response', unmapped: true });
    expect(JSON.stringify(c)).not.toContain('abc123');
  });

  it('a non-200 client error falls back to the generic HTTP mapping', () => {
    expect(classifySlackWebApiResponse(web('', 401), NOW)).toEqual({
      outcome: 'permanent',
      reason: 'destination_unauthorized',
    });
  });
});
