import { describe, expect, it } from 'vitest';
import { larkAdapter } from '../../src/connectors/destinations/lark/adapter';
import { larkSignature } from '../../src/connectors/destinations/lark/sign';
import { capabilitiesFor } from '../../src/connectors/destinations/capabilities';
import { validateDestinationConfig } from '../../src/connectors/destinations/config';
import { REDACTED_EMAIL } from '../../src/connectors/destinations/redact';
import { BASE, LARK_URL, NOW, response } from './fixtures';

const caps = capabilitiesFor('lark');

function render(n = BASE, startAt?: 'card' | 'markdown' | 'plain') {
  const r = larkAdapter.render(n, caps, startAt ? { startAt } : {});
  if (!r.ok) throw new Error('render failed: ' + r.reason);
  return r.message;
}

function config(signingSecret?: string) {
  const r = validateDestinationConfig({ kind: 'lark', webhookUrl: LARK_URL, signingSecret });
  if (!r.ok || r.config.kind !== 'lark') throw new Error('config');
  return r.config;
}

describe('Lark renderer', () => {
  it('renders an interactive JSON 2.0 card in the `card` field', () => {
    const p = render().payload as any;
    expect(p.msg_type).toBe('interactive');
    expect(p.content).toBeUndefined();
    expect(p.card.schema).toBe('2.0');
    expect(p.card.header).toEqual({
      title: { tag: 'plain_text', content: 'Failed: CI failed on main' },
      template: 'red',
    });
  });

  it('sets the chat-list preview so it is never blank', () => {
    expect((render().payload as any).card.config.summary.content).toBe('Failed: CI failed on main');
  });

  it('places the link as an intact markdown link', () => {
    const els = (render().payload as any).card.body.elements;
    expect(els.at(-1)).toEqual({
      tag: 'markdown',
      content: '[Open in source](https://github.com/acme/api/actions/runs/1)',
    });
    const none = (render({ ...BASE, url: '' }).payload as any).card.body.elements;
    expect(none.at(-1).content).toBe('Source link unavailable');
  });

  it('neutralises <at> mentions and disguised links in markdown', () => {
    const p = render({ ...BASE, summary: '<at id=all></at> [ok](https://evil.example)' }).payload as any;
    const json = JSON.stringify(p.card.body);
    expect(json).not.toContain('<at');
    expect(json).not.toContain('[ok]');
  });

  it('redacts emails and phone numbers before Lark DLP sees them', () => {
    const m = render({ ...BASE, title: 'Fix by jane@example.com', summary: 'call +84 912 345 678' });
    const json = JSON.stringify(m.payload);
    expect(json).not.toContain('jane@example.com');
    expect(json).not.toContain('912 345');
    expect(json).toContain(REDACTED_EMAIL);
    expect(m.redactedFields).toEqual(['title', 'summary']);
  });

  it('renders markdown and text rungs', () => {
    const md = render(BASE, 'markdown').payload as any;
    expect(md.card.body.elements).toHaveLength(1);
    expect(md.card.body.elements[0].content).toContain('**Failed: CI failed on main**');
    const plain = render({ ...BASE, title: '<at id=all></at>' }, 'plain').payload as any;
    expect(plain.msg_type).toBe('text');
    expect(plain.content.text).not.toContain('<at');
  });

  it('reserves room for the signature under the 20 KB cap', () => {
    const m = render({ ...BASE, summary: 'ü'.repeat(50_000) });
    expect(m.bytes).toBeLessThanOrEqual(caps.maxBodyBytes);
  });
});

describe('Lark request building', () => {
  it('omits the signature without a secret', async () => {
    const body = JSON.parse((await larkAdapter.buildRequest(render(), config(), NOW)).body);
    expect(body.sign).toBeUndefined();
    expect(body.timestamp).toBeUndefined();
  });

  it('adds second-resolution timestamp and signature as top-level strings', async () => {
    const body = JSON.parse((await larkAdapter.buildRequest(render(), config('secret'), 123_456_789)).body);
    expect(body.timestamp).toBe('123456');
    expect(body.sign).toBe(await larkSignature('secret', 123456));
    expect(body.msg_type).toBe('interactive');
  });

  it('matches the documented HMAC construction (key = ts\\nsecret, empty message)', async () => {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('1599360473\nsecret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const expected = btoa(
      String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new Uint8Array()))),
    );
    expect(await larkSignature('secret', 1599360473)).toBe(expected);
  });
});

describe('Lark classifier', () => {
  const classify = (status: number, body: unknown, headers = {}) =>
    larkAdapter.classifyResponse(
      response(status, typeof body === 'string' ? body : JSON.stringify(body), headers),
      NOW,
    );

  it('treats code 0 as delivered, preferring `code` over legacy `StatusCode`', () => {
    expect(classify(200, { code: 0, msg: 'success', data: {} })).toEqual({
      outcome: 'delivered',
      reason: 'ok',
    });
    expect(classify(200, { StatusCode: 0 })).toEqual({ outcome: 'delivered', reason: 'ok' });
    expect(classify(200, { code: 19021, StatusCode: 0 }).outcome).toBe('permanent');
  });

  it.each([
    [9499, 'payload_rejected'],
    [19021, 'signature_rejected'],
    [19022, 'destination_policy_blocked'],
    [19024, 'destination_policy_blocked'],
    [230001, 'payload_rejected'],
    [230025, 'payload_too_large'],
    [230028, 'content_policy_blocked'],
    [232009, 'destination_revoked'],
  ])('maps code %i to permanent %s', (code, reason) => {
    expect(classify(200, { code, msg: 'x' })).toEqual({
      outcome: 'permanent',
      reason,
      providerCode: String(code),
    });
  });

  it.each([11232, 230020, 99991400])('maps throttle code %i to retryable', (code) => {
    expect(classify(200, { code })).toMatchObject({
      outcome: 'retryable',
      reason: 'destination_rate_limited',
    });
  });

  it('classifies legacy HTTP 400 throttling by code, with x-ogw-ratelimit-reset', () => {
    expect(
      classify(
        400,
        { code: 99991400, msg: 'request trigger frequency limit' },
        { 'x-ogw-ratelimit-reset': '4' },
      ),
    ).toEqual({
      outcome: 'retryable',
      reason: 'destination_rate_limited',
      retryAfterMs: 4000,
      providerCode: '99991400',
    });
  });

  it('flags unknown codes (including the unverified 19001) as unmapped', () => {
    expect(classify(200, { code: 19001 })).toEqual({
      outcome: 'retryable',
      reason: 'unmapped_response',
      unmapped: true,
    });
    expect(classify(400, { code: 424242 })).toMatchObject({ unmapped: true });
  });

  it('falls back to HTTP status for non-JSON bodies', () => {
    expect(classify(502, '<html>bad gateway</html>')).toMatchObject({ reason: 'destination_unavailable' });
    expect(classify(429, '', { 'retry-after': '3' })).toMatchObject({ retryAfterMs: 3000 });
    expect(classify(404, 'not found')).toEqual({ outcome: 'permanent', reason: 'destination_revoked' });
    expect(classify(200, 'ok')).toMatchObject({ unmapped: true });
  });
});
