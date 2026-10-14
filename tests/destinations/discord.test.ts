import { describe, expect, it } from 'vitest';
import { discordAdapter } from '../../src/connectors/destinations/discord/adapter';
import { isDeadWebhook } from '../../src/connectors/destinations/discord/classify';
import {
  DISCORD_CONTENT_MAX,
  DISCORD_EMBED_TOTAL_MAX,
} from '../../src/connectors/destinations/discord/render';
import { capabilitiesFor } from '../../src/connectors/destinations/capabilities';
import { validateDestinationConfig } from '../../src/connectors/destinations/config';
import { checkDestinationUrl } from '../../src/connectors/destinations/url-policy';
import { BASE, DISCORD_URL, NOW, response } from './fixtures';

const caps = capabilitiesFor('discord');

function render(n = BASE, startAt?: 'card' | 'markdown' | 'plain') {
  const r = discordAdapter.render(n, caps, startAt ? { startAt } : {});
  if (!r.ok) throw new Error('render failed: ' + r.reason);
  return r.message;
}

interface Embed {
  title: string;
  url?: string;
  description?: string;
  color: number;
  footer?: { text: string };
}
interface Payload {
  content?: string;
  embeds?: Embed[];
  allowed_mentions?: unknown;
}
const payload = (m: { payload: unknown }): Payload => m.payload as Payload;

describe('Discord renderer', () => {
  it('emits exactly one embed carrying the canonical fields', () => {
    const p = payload(render());
    expect(p.embeds).toHaveLength(1);
    expect(p.embeds?.[0]).toMatchObject({
      title: 'Failed: CI failed on main',
      url: 'https://github.com/acme/api/actions/runs/1',
      footer: { text: 'acme/api · by octocat' },
    });
    // A plain preview rides along as the notification text.
    expect(p.content).toContain('CI failed on main');
  });

  it('never emits two embeds, whatever the input, so URL-deduplication cannot drop an event', () => {
    for (const n of [BASE, { ...BASE, summary: 'x'.repeat(10_000) }, { ...BASE, url: '' }]) {
      expect(payload(render(n)).embeds?.length ?? 1).toBe(1);
    }
  });

  it('sets allowed_mentions to the empty parse list on EVERY rung', () => {
    for (const startAt of caps.formats) {
      expect(payload(render(BASE, startAt)).allowed_mentions).toEqual({ parse: [] });
    }
  });

  it('a branch named @everyone, a PR body with <@&123> and <@everyone> cannot ping anyone', () => {
    const hostile = {
      ...BASE,
      title: '@everyone <@&123> @here',
      actor: '<@456>',
      repo: '@here/<#789>',
      summary: 'merge @everyone <@everyone> [click](https://evil.example) <t:1>',
    };
    for (const startAt of caps.formats) {
      const m = render(hostile, startAt);
      const json = JSON.stringify(m.payload);
      expect(payload(m).allowed_mentions).toEqual({ parse: [] });
      // No mention token survives as text either: `<` is neutralised, `@` is broken by a ZWSP.
      expect(json).not.toMatch(/<@|<#|<t:/);
      expect(json).not.toMatch(/@everyone|@here/);
      expect(json).not.toContain('[click](');
    }
  });

  it('keeps every field inside the documented limits, truncating visibly', () => {
    const m = render({ ...BASE, title: 'T'.repeat(5000), summary: 'S'.repeat(9000), actor: 'A'.repeat(900) });
    const e = payload(m).embeds?.[0] as Embed;
    expect(e.title.length).toBeLessThanOrEqual(256);
    expect(e.description?.length).toBeLessThanOrEqual(4096);
    expect(e.footer?.text.length).toBeLessThanOrEqual(2048);
    expect((payload(m).content ?? '').length).toBeLessThanOrEqual(DISCORD_CONTENT_MAX);
    expect(e.title.endsWith('…')).toBe(true);
    expect(e.description?.endsWith('…')).toBe(true);
    expect(m.truncatedFields).toEqual(expect.arrayContaining(['title', 'summary']));
  });

  it('the worst case of title + description + footer stays under the 6000-character embed total', () => {
    const e = payload(
      render({ ...BASE, title: '😀'.repeat(900), summary: '漢'.repeat(9000), actor: 'a'.repeat(900) }),
    ).embeds?.[0] as Embed;
    const total = e.title.length + (e.description?.length ?? 0) + (e.footer?.text.length ?? 0);
    expect(total).toBeLessThanOrEqual(DISCORD_EMBED_TOTAL_MAX);
  });

  it('content rungs stay within 2000 characters and carry a link', () => {
    const md = payload(render({ ...BASE, summary: 'S'.repeat(9000) }, 'markdown'));
    expect((md.content ?? '').length).toBeLessThanOrEqual(DISCORD_CONTENT_MAX);
    expect(md.content).toContain('[Open in source](https://github.com/acme/api/actions/runs/1)');
    expect(payload(render(BASE, 'plain')).content).toContain('https://github.com/acme/api/actions/runs/1');
  });

  it('never sets a username or an avatar from event data', () => {
    const json = JSON.stringify(render({ ...BASE, actor: 'octocat' }).payload);
    expect(json).not.toContain('username');
    expect(json).not.toContain('avatar_url');
  });

  it('drops an unsafe link instead of emitting it', () => {
    const e = payload(render({ ...BASE, url: 'javascript:alert(1)' })).embeds?.[0] as Embed;
    expect(e.url).toBeUndefined();
  });

  it('escapes markdown operators in the description', () => {
    const e = payload(render({ ...BASE, summary: '*bold* _it_ ~s~ `c` | x' })).embeds?.[0] as Embed;
    expect(e.description).toBe('\\*bold\\* \\_it\\_ \\~s\\~ \\`c\\` \\| x');
  });
});

describe('Discord URL policy and configuration', () => {
  it.each([
    'https://discord.com/api/webhooks/123456789012345678/DiscordFixtureToken',
    'https://discord.com/api/v10/webhooks/123456789012345678/DiscordFixtureToken',
    'https://discord.com/api/webhooks/123456789012345678/DiscordFixtureToken?thread_id=987654321',
    'https://discord.com/api/webhooks/123456789012345678/DiscordFixtureToken?wait=true',
  ])('accepts %s', (url) => {
    expect(checkDestinationUrl('discord', url).ok).toBe(true);
  });

  it.each([
    ['https://discordapp.com/api/webhooks/123456789012345678/DiscordFixtureToken', 'host'],
    ['https://canary.discord.com/api/webhooks/123456789012345678/DiscordFixtureToken', 'host'],
    ['https://discord.com.evil.test/api/webhooks/123456789012345678/DiscordFixtureToken', 'host'],
    ['http://discord.com/api/webhooks/123456789012345678/DiscordFixtureToken', 'scheme'],
    ['https://discord.com/api/webhooks/abc/DiscordFixtureToken', 'path'],
    ['https://discord.com/api/channels/123456789012345678/messages', 'path'],
    ['https://discord.com/api/webhooks/123456789012345678/DiscordFixtureToken/slack', 'path'],
    ['https://discord.com/api/webhooks/123456789012345678/DiscordFixtureToken?thread_id=abc', 'query'],
    ['https://discord.com/api/webhooks/123456789012345678/DiscordFixtureToken?wait=false', 'query'],
    ['https://discord.com/api/webhooks/123456789012345678/DiscordFixtureToken?username=x', 'query'],
    [
      'https://discord.com/api/webhooks/123456789012345678/DiscordFixtureToken?thread_id=1&thread_id=2',
      'query',
    ],
  ])('rejects %s (%s)', (url, rule) => {
    expect(checkDestinationUrl('discord', url)).toMatchObject({ ok: false, rule });
  });

  it('normalises to the form Discord shows: no version, no wait, thread_id kept', () => {
    const r = validateDestinationConfig({
      kind: 'discord',
      webhookUrl:
        'https://discord.com/api/v10/webhooks/123456789012345678/DiscordFixtureToken?wait=true&thread_id=42',
    });
    expect(r.ok && r.config.webhookUrl).toBe(
      'https://discord.com/api/webhooks/123456789012345678/DiscordFixtureToken?thread_id=42',
    );
  });

  it('always sends wait=true on the documented v10 endpoint, keeping thread_id', async () => {
    const cfg = validateDestinationConfig({ kind: 'discord', webhookUrl: DISCORD_URL + '?thread_id=42' });
    if (!cfg.ok || cfg.config.kind !== 'discord') throw new Error('config');
    const req = await discordAdapter.buildRequest(render(), cfg.config, NOW);
    const url = new URL(req.url);
    expect(url.origin + url.pathname).toBe(
      'https://discord.com/api/v10/webhooks/123456789012345678/DiscordFixtureToken',
    );
    expect(url.searchParams.get('wait')).toBe('true');
    expect(url.searchParams.get('thread_id')).toBe('42');
    expect(req.method).toBe('POST');
    expect(JSON.parse(req.body)).toMatchObject({ allowed_mentions: { parse: [] } });
    // The request URL itself passes the send-time policy.
    expect(checkDestinationUrl('discord', req.url).ok).toBe(true);
  });

  it('reports what this adapter does, not what Discord could do', () => {
    expect(caps).toMatchObject({
      canUpdate: false,
      canDelete: false,
      canReply: false,
      canCustomizeIdentity: false,
      supportsMentions: false,
      supportsCallbacks: false,
      supportsServerSideIdempotency: false,
      successSemantics: 'delivered',
      requiresCustomerOwnedCredential: true,
    });
  });
});

describe('Discord classifier', () => {
  const classify = (status: number, body = '', headers = {}) =>
    discordAdapter.classifyResponse(response(status, body, headers), NOW);

  it('200 with wait=true is a delivery; 204 is only accepted', () => {
    expect(classify(200, '{"id":"1"}')).toEqual({ outcome: 'delivered', reason: 'ok' });
    // A malformed 200 body is still delivered: the message exists, a retry would duplicate it.
    expect(classify(200, '<html>')).toEqual({ outcome: 'delivered', reason: 'ok' });
    expect(classify(204)).toEqual({ outcome: 'accepted', reason: 'ok' });
  });

  it('404 is terminal with no retry: Discord restricts callers that reuse a dead webhook', () => {
    expect(classify(404, '{"message":"Unknown Webhook","code":10015}')).toEqual({
      outcome: 'permanent',
      reason: 'destination_revoked',
    });
    expect(classify(410).outcome).toBe('permanent');
  });

  it('401 and 403 are a dead webhook only when Discord says so in its own error code', () => {
    expect(classify(404, '{"code":10015}')).toMatchObject({ outcome: 'permanent' });
    expect(classify(403, '{"message":"Unknown Webhook","code":10015}')).toEqual({
      outcome: 'permanent',
      reason: 'destination_revoked',
      providerCode: 'unknown_webhook',
    });
    expect(classify(401, '{"message":"Invalid Webhook Token","code":50027}')).toEqual({
      outcome: 'permanent',
      reason: 'destination_unauthorized',
      providerCode: 'invalid_webhook_token',
    });
  });

  it('any other 401 or 403 is retryable (not a dead webhook) and carries only our own code', () => {
    for (const body of ['', '<html>blocked</html>', '{"code":40333}', '{"code":"10015"}', 'null']) {
      for (const status of [401, 403]) {
        expect(classify(status, body)).toEqual({
          outcome: 'retryable',
          reason: 'destination_unavailable',
          providerCode: `http_${status}`,
        });
      }
    }
  });

  it('only a missing webhook pauses an integration', () => {
    const c = (status: number, body = '') => classify(status, body);
    expect(isDeadWebhook(404, c(404))).toBe(true);
    expect(isDeadWebhook(410, c(410))).toBe(true);
    expect(isDeadWebhook(403, c(403, '{"code":10015}'))).toBe(true);
    expect(isDeadWebhook(401, c(401, '{"code":50027}'))).toBe(true);
    expect(isDeadWebhook(403, c(403))).toBe(false);
    expect(isDeadWebhook(401, c(401))).toBe(false);
    expect(isDeadWebhook(400, c(400))).toBe(false);
    expect(isDeadWebhook(429, c(429))).toBe(false);
    expect(isDeadWebhook(500, c(500))).toBe(false);
  });

  it('429 honours retry_after from the body (seconds, float) before the header', () => {
    expect(
      classify(429, '{"message":"rate limited","retry_after":1.5,"global":false}', { 'retry-after': '99' }),
    ).toEqual({ outcome: 'retryable', reason: 'destination_rate_limited', retryAfterMs: 1500 });
    expect(classify(429, '', { 'retry-after': '7' })).toMatchObject({ retryAfterMs: 7000 });
    expect(classify(429, 'not json', { 'retry-after': '7' })).toMatchObject({ retryAfterMs: 7000 });
  });

  it('flags a global 429 and clamps an absurd retry_after', () => {
    expect(classify(429, '{"retry_after":1,"global":true}')).toMatchObject({ providerCode: 'global' });
    expect(classify(429, '{"retry_after":99999999}')).toMatchObject({ retryAfterMs: 3_600_000 });
    expect(classify(429, '{"retry_after":-4}')).not.toHaveProperty('retryAfterMs');
  });

  it('400 is a permanent rejection of our payload; 5xx retries', () => {
    expect(classify(400, '{"code":50035}')).toMatchObject({
      outcome: 'permanent',
      reason: 'payload_rejected',
    });
    expect(classify(500)).toMatchObject({ outcome: 'retryable', reason: 'destination_unavailable' });
    expect(classify(503)).toMatchObject({ outcome: 'retryable' });
  });

  it('never carries the response body into the classification', () => {
    const r = classify(400, '{"message":"https://discord.com/api/webhooks/1/SECRETTOKEN"}');
    expect(JSON.stringify(r)).not.toContain('SECRETTOKEN');
  });
});
