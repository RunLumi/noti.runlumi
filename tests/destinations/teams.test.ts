import { describe, expect, it } from 'vitest';
import { teamsAdapter } from '../../src/connectors/destinations/teams/adapter';
import { ADAPTIVE_CARD_CONTENT_TYPE } from '../../src/connectors/destinations/teams/render';
import { capabilitiesFor } from '../../src/connectors/destinations/capabilities';
import { validateDestinationConfig } from '../../src/connectors/destinations/config';
import { BASE, NOW, TEAMS_URL, response } from './fixtures';

const caps = capabilitiesFor('teams');

function render(n = BASE, startAt?: 'card' | 'markdown' | 'plain') {
  const r = teamsAdapter.render(n, caps, startAt ? { startAt } : {});
  if (!r.ok) throw new Error('render failed: ' + r.reason);
  return r.message;
}

function card(payload: unknown): any {
  return (payload as any).attachments[0].content;
}

describe('Teams Workflows renderer', () => {
  it('wraps an Adaptive Card in the documented message envelope', () => {
    const p = render().payload as any;
    expect(p.type).toBe('message');
    expect(p.attachments).toHaveLength(1);
    expect(p.attachments[0].contentType).toBe(ADAPTIVE_CARD_CONTENT_TYPE);
    expect(p.attachments[0].contentUrl).toBeNull();
    expect(card(p)).toMatchObject({ type: 'AdaptiveCard', version: '1.2' });
  });

  it('never emits a MessageCard or callback actions', () => {
    const json = JSON.stringify(render().payload);
    expect(json).not.toContain('MessageCard');
    expect(json).not.toContain('Action.Submit');
    expect(json).not.toContain('HttpPOST');
  });

  it('renders title, meta, summary and an OpenUrl action', () => {
    const c = card(render().payload);
    expect(c.body[0]).toMatchObject({
      type: 'TextBlock',
      text: 'Failed: CI failed on main',
      color: 'Attention',
    });
    expect(c.body[1]).toMatchObject({ text: 'acme/api · by octocat', isSubtle: true });
    expect(c.actions).toEqual([
      { type: 'Action.OpenUrl', title: 'Open in source', url: 'https://github.com/acme/api/actions/runs/1' },
    ]);
  });

  it('neutralises markdown links in untrusted text', () => {
    const c = card(render({ ...BASE, title: '[Approve](https://evil.example)' }).payload);
    expect(c.body[0].text).not.toContain('[Approve]');
  });

  it('drops the action when the URL is unsafe', () => {
    expect(card(render({ ...BASE, url: 'http://github.com/x' }).payload).actions).toBeUndefined();
  });

  it('keeps the whole payload within the 28 KB budget', () => {
    const m = render({ ...BASE, summary: '漢'.repeat(20_000), title: '😀'.repeat(400) });
    expect(m.bytes).toBeLessThanOrEqual(caps.maxBodyBytes);
    expect(new TextEncoder().encode(JSON.stringify(m.payload)).length).toBe(m.bytes);
    expect(m.truncatedFields).toEqual(expect.arrayContaining(['title', 'summary']));
  });

  it('collapses lower rungs into a single TextBlock card', () => {
    const md = card(render(BASE, 'markdown').payload);
    expect(md.body).toHaveLength(1);
    expect(md.body[0].text).toContain('**Failed: CI failed on main**');
    expect(md.body[0].text).toContain('[Open in source](https://github.com/acme/api/actions/runs/1)');
    const plain = card(render(BASE, 'plain').payload);
    expect(plain.body[0].text).not.toContain('**');
    expect(plain.body[0].text).toContain('https://github.com/acme/api/actions/runs/1');
  });

  it('sends no Authorization header for an "anyone" trigger', async () => {
    const cfg = validateDestinationConfig({ kind: 'teams', webhookUrl: TEAMS_URL });
    if (!cfg.ok || cfg.config.kind !== 'teams') throw new Error('config');
    const req = await teamsAdapter.buildRequest(render(), cfg.config, NOW);
    expect(Object.keys(req.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
    expect(req.url).toBe(TEAMS_URL);
  });
});

describe('Teams classifier', () => {
  const classify = (status: number, body = '', headers = {}) =>
    teamsAdapter.classifyResponse(response(status, body, headers), NOW);

  it('reports 202 as accepted, never delivered', () => {
    expect(classify(202)).toEqual({ outcome: 'accepted', reason: 'ok' });
    expect(classify(200, '{"ok":true}').outcome).toBe('accepted');
  });

  it.each([
    [400, 'permanent', 'payload_rejected'],
    [401, 'permanent', 'destination_unauthorized'],
    [403, 'permanent', 'destination_unauthorized'],
    [404, 'permanent', 'destination_revoked'],
    [413, 'permanent', 'payload_too_large'],
    [408, 'retryable', 'destination_timeout'],
    [500, 'retryable', 'destination_unavailable'],
    [502, 'retryable', 'destination_unavailable'],
  ])('maps %i to %s %s', (status, outcome, reason) => {
    expect(classify(status)).toMatchObject({ outcome, reason });
  });

  it('honours Retry-After on 429, in both RFC 9110 forms', () => {
    expect(classify(429, '', { 'retry-after': '12' })).toMatchObject({ retryAfterMs: 12_000 });
    expect(classify(429, '', { 'retry-after': 'Tue, 13 Oct 2026 00:01:00 GMT' })).toMatchObject({
      reason: 'destination_rate_limited',
      retryAfterMs: 60_000,
    });
  });

  it('never carries the response body into the classification', () => {
    const r = classify(400, '{"error":{"message":"https://prod.logic.azure.com/?sig=SECRET"}}');
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });
});
