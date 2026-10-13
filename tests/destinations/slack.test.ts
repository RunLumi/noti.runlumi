import { describe, expect, it } from 'vitest';
import { slackAdapter } from '../../src/connectors/destinations/slack/adapter';
import { SLACK_TEXT_MAX } from '../../src/connectors/destinations/slack/render';
import { capabilitiesFor } from '../../src/connectors/destinations/capabilities';
import { validateDestinationConfig } from '../../src/connectors/destinations/config';
import { BASE, NOW, SLACK_URL, response } from './fixtures';

const caps = capabilitiesFor('slack');

function render(n = BASE, startAt?: 'card' | 'markdown' | 'plain') {
  const r = slackAdapter.render(n, caps, startAt ? { startAt } : {});
  if (!r.ok) throw new Error('render failed: ' + r.reason);
  return r.message;
}

describe('Slack renderer', () => {
  it('renders Block Kit with a full top-level text fallback', () => {
    const m = render();
    const p = m.payload as any;
    expect(m.format).toBe('card');
    expect(m.degradedFrom).toEqual([]);
    expect(p.text).toContain('*Failed: CI failed on main*');
    expect(p.text).toContain('<https://github.com/acme/api/actions/runs/1|Open in source>');
    expect(p.text).toContain('Job `test` failed');
    expect(p.blocks[0]).toEqual({
      type: 'header',
      text: { type: 'plain_text', text: 'Failed: CI failed on main' },
    });
    expect(p.blocks[1]).toEqual({
      type: 'context',
      elements: [{ type: 'plain_text', text: 'acme/api · by octocat' }],
    });
    expect(p.blocks.at(-1).text.type).toBe('mrkdwn');
  });

  it('never attempts identity or channel overrides on an app webhook', () => {
    const p = render().payload as any;
    for (const key of ['channel', 'username', 'icon_emoji', 'icon_url']) expect(p).not.toHaveProperty(key);
  });

  it('keeps untrusted text in plain_text blocks and escapes the fallback', () => {
    const m = render({ ...BASE, title: '<!here> fix & <@U1>', summary: '<!channel>' });
    const p = m.payload as any;
    expect(p.blocks[0].text).toEqual({ type: 'plain_text', text: 'Failed: <!here> fix & <@U1>' });
    expect(p.text).not.toMatch(/<[!@]/);
    expect(p.text).toContain('&lt;!here&gt; fix &amp; &lt;@U1&gt;');
  });

  it('truncates visibly at the header and section limits', () => {
    const m = render({ ...BASE, title: 'T'.repeat(500), summary: 'S'.repeat(5000) });
    const p = m.payload as any;
    expect(p.blocks[0].text.text.length).toBeLessThanOrEqual(caps.maxTitleChars);
    expect(p.blocks[0].text.text.endsWith('…')).toBe(true);
    const section = p.blocks.find((b: any) => b.type === 'section' && b.text.type === 'plain_text');
    expect(section.text.text.length).toBeLessThanOrEqual(caps.maxTextChars);
    expect(p.text.length).toBeLessThanOrEqual(SLACK_TEXT_MAX);
    expect(p.text).toContain('|Open in source>');
    expect(m.truncatedFields).toEqual(expect.arrayContaining(['title', 'summary']));
  });

  it('omits the link when the URL is not https', () => {
    const p = render({ ...BASE, url: 'javascript:alert(1)' }).payload as any;
    expect(JSON.stringify(p)).not.toContain('javascript');
  });

  it('renders the markdown and plain rungs on request', () => {
    const md = render(BASE, 'markdown');
    expect(md.format).toBe('markdown');
    expect(Object.keys(md.payload)).toEqual(['text']);
    const plain = render({ ...BASE, url: 'https://x.test/?a=1&b=2' }, 'plain');
    expect((plain.payload as any).text).toContain('https://x.test/?a=1&amp;b=2');
    expect((plain.payload as any).text).not.toContain('*');
  });

  it('builds a JSON POST to the stored URL', async () => {
    const cfg = validateDestinationConfig({ kind: 'slack', webhookUrl: SLACK_URL });
    if (!cfg.ok || cfg.config.kind !== 'slack') throw new Error('config');
    const req = await slackAdapter.buildRequest(render(), cfg.config, NOW);
    expect(req).toMatchObject({ kind: 'slack', url: SLACK_URL, method: 'POST' });
    expect(JSON.parse(req.body)).toEqual(render().payload);
  });
});

describe('Slack classifier', () => {
  const classify = (status: number, body = '', headers = {}) =>
    slackAdapter.classifyResponse(response(status, body, headers), NOW);

  it('treats 200 "ok" as delivered', () => {
    expect(classify(200, 'ok')).toEqual({ outcome: 'delivered', reason: 'ok' });
  });

  it('flags an unexpected 200 body as unmapped rather than delivered', () => {
    expect(classify(200, '{"ok":true}')).toMatchObject({ outcome: 'retryable', unmapped: true });
  });

  it.each([
    [400, 'invalid_payload', 'payload_rejected'],
    [400, 'no_text', 'payload_rejected'],
    [400, 'too_many_attachments', 'payload_rejected'],
    [403, 'action_prohibited', 'destination_policy_blocked'],
    [403, 'posting_to_general_channel_denied', 'destination_policy_blocked'],
    [404, 'no_service', 'destination_revoked'],
    [404, 'no_service_id', 'destination_revoked'],
    [410, 'channel_is_archived', 'destination_revoked'],
    [404, 'channel_not_found', 'destination_revoked'],
    [404, 'user_not_found', 'destination_revoked'],
    [403, 'team_disabled', 'destination_revoked'],
    [403, 'no_active_hooks', 'destination_revoked'],
  ])('maps %i %s to permanent %s', (status, body, reason) => {
    expect(classify(status, body)).toEqual({ outcome: 'permanent', reason, providerCode: body });
  });

  it('honours Retry-After on 429', () => {
    expect(classify(429, 'rate_limited', { 'retry-after': '7' })).toEqual({
      outcome: 'retryable',
      reason: 'destination_rate_limited',
      retryAfterMs: 7000,
    });
  });

  it('retries 5xx', () => {
    expect(classify(503, 'service_unavailable')).toMatchObject({
      outcome: 'retryable',
      reason: 'destination_unavailable',
    });
  });

  it('falls back to HTTP status for unknown bodies and never echoes them', () => {
    const r = classify(404, 'https://hooks.slack.com/services/SECRET');
    expect(r).toEqual({ outcome: 'permanent', reason: 'destination_revoked' });
    expect(classify(400, 'some_new_error')).toEqual({ outcome: 'permanent', reason: 'payload_rejected' });
    expect(classify(302, '')).toMatchObject({ unmapped: true });
  });
});
