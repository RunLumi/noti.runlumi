import { describe, expect, it } from 'vitest';
import { checkDestinationUrl, larkDomainOf } from '../../src/connectors/destinations/url-policy';
import { validateDestinationConfig, validateConfigFor } from '../../src/connectors/destinations/config';
import type { DestinationKind } from '../../src/connectors/destinations/types';

const SLACK = 'https://hooks.slack.com/services/T000/B000/XXXX';
const TEAMS =
  'https://prod-12.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01&sig=s';
const LARK = 'https://open.larksuite.com/open-apis/bot/v2/hook/abc-123';
const FEISHU = 'https://open.feishu.cn/open-apis/bot/v2/hook/abc-123';

function rule(kind: DestinationKind, url: string): string {
  const r = checkDestinationUrl(kind, url);
  return r.ok ? 'ok' : r.rule;
}

describe('destination URL allowlist', () => {
  it.each([
    ['slack', SLACK],
    ['teams', TEAMS],
    ['teams', 'https://prod-01.logic.azure.com/workflows/x'],
    ['lark', LARK],
    ['lark', FEISHU],
  ] as const)('accepts documented %s URL', (kind, url) => {
    expect(rule(kind, url)).toBe('ok');
  });

  it.each([
    ['slack', 'https://hooks.slack.com.evil.com/services/T/B/X', 'host'],
    ['slack', 'https://evilhooks.slack.com/services/T/B/X', 'host'],
    ['slack', 'https://slack.com/services/T/B/X', 'host'],
    ['slack', 'http://hooks.slack.com/services/T/B/X', 'scheme'],
    ['slack', 'https://user:pw@hooks.slack.com/services/T/B/X', 'userinfo'],
    ['slack', 'https://hooks.slack.com@evil.com/services/T/B/X', 'userinfo'],
    ['slack', 'https://hooks.slack.com:8443/services/T/B/X', 'port'],
    ['slack', 'https://hooks.slack.com/api/chat.postMessage', 'path'],
    ['slack', 'https://hooks.slack.com/services/', 'path'],
    ['slack', 'https://hooks.slack.com/services/../api/x', 'path'],
    ['slack', 'https://hooks.slack.com/services/T/B/X#frag', 'fragment'],
    ['slack', 'https://hooks.slack.com/services/T/B/X#', 'fragment'],
    ['slack', 'https://127.0.0.1/services/T/B/X', 'ip_literal'],
    ['slack', 'https://2130706433/services/T/B/X', 'ip_literal'],
    ['slack', 'https://[::1]/services/T/B/X', 'ip_literal'],
    ['slack', ' https://hooks.slack.com/services/T/B/X', 'whitespace_or_control'],
    ['slack', 'https://hooks.slack.com/services/T/B/X\n', 'whitespace_or_control'],
    ['slack', 'not a url', 'whitespace_or_control'],
    ['slack', 'hooks.slack.com/services/T/B/X', 'malformed'],
    ['slack', 'javascript:alert(1)', 'scheme'],
    ['slack', 'https://hooks.slack.com/services/' + 'a'.repeat(2100), 'too_long'],
    ['teams', 'https://logic.azure.com/workflows/x', 'host'],
    ['teams', 'https://logic.azure.com.evil.com/workflows/x', 'host'],
    ['teams', 'https://evil-logic.azure.com/workflows/x', 'host'],
    ['teams', 'https://prod.westus.logic.azure.com:444/workflows/x', 'port'],
    ['teams', 'https://outlook.office.com/webhook/x', 'host'],
    ['lark', 'https://open.larksuite.com/open-apis/im/v1/messages', 'path'],
    ['lark', 'https://open.larksuite.com.evil.com/open-apis/bot/v2/hook/x', 'host'],
    ['lark', 'https://constructor/open-apis/bot/v2/hook/x', 'host'],
    ['lark', SLACK, 'host'],
    ['slack', LARK, 'host'],
  ] as const)('rejects %s %s (%s)', (kind, url, expected) => {
    expect(rule(kind, url)).toBe(expected);
  });

  it('records which Lark deployment a URL belongs to', () => {
    expect(larkDomainOf(new URL(LARK))).toBe('larksuite');
    expect(larkDomainOf(new URL(FEISHU))).toBe('feishu');
    expect(larkDomainOf(new URL(SLACK))).toBeUndefined();
  });
});

describe('write-time config validation', () => {
  it('normalises and seals a valid Slack config', () => {
    const r = validateDestinationConfig({ kind: 'slack', webhookUrl: SLACK });
    expect(r).toEqual({ ok: true, config: { kind: 'slack', mode: 'incoming_webhook', webhookUrl: SLACK } });
  });

  it('never echoes a rejected URL', () => {
    const hostileUrl = 'https://hooks.slack.com.evil.com/services/T/B/MARKER';
    const r = validateDestinationConfig({ kind: 'slack', webhookUrl: hostileUrl });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('MARKER');
  });

  it('rejects malformed input', () => {
    expect(validateDestinationConfig(null)).toMatchObject({ ok: false, field: 'kind' });
    expect(validateDestinationConfig({ kind: 'telegram', webhookUrl: SLACK })).toMatchObject({
      field: 'kind',
    });
    expect(validateDestinationConfig({ kind: 'slack' })).toMatchObject({ field: 'webhookUrl' });
    expect(validateDestinationConfig({ kind: 'slack', webhookUrl: 42 })).toMatchObject({
      field: 'webhookUrl',
    });
  });

  it('defaults Teams trigger auth to anyone and refuses token-requiring modes', () => {
    expect(validateDestinationConfig({ kind: 'teams', webhookUrl: TEAMS })).toMatchObject({
      ok: true,
      config: { triggerAuth: 'anyone', mode: 'workflows_webhook' },
    });
    expect(
      validateDestinationConfig({ kind: 'teams', webhookUrl: TEAMS, triggerAuth: 'tenant_users' }),
    ).toEqual({
      ok: false,
      reason: 'config_unsupported',
      field: 'triggerAuth',
    });
    expect(
      validateDestinationConfig({ kind: 'teams', webhookUrl: TEAMS, triggerAuth: 'bogus' }),
    ).toMatchObject({
      reason: 'config_invalid',
      field: 'triggerAuth',
    });
  });

  it('stores the Lark domain and validates the signing secret', () => {
    expect(validateDestinationConfig({ kind: 'lark', webhookUrl: FEISHU, signingSecret: 's' })).toMatchObject(
      {
        ok: true,
        config: { domain: 'feishu', signingSecret: 's' },
      },
    );
    expect(validateDestinationConfig({ kind: 'lark', webhookUrl: LARK, signingSecret: '' })).toMatchObject({
      field: 'signingSecret',
    });
    expect(
      validateDestinationConfig({ kind: 'lark', webhookUrl: LARK, signingSecret: 'x'.repeat(300) }),
    ).toMatchObject({ field: 'signingSecret' });
  });

  it('validateConfigFor refuses another kind', () => {
    expect(validateConfigFor('teams', { kind: 'slack', webhookUrl: SLACK })).toMatchObject({ field: 'kind' });
  });
});
