import { describe, expect, it } from 'vitest';
import { parseCreateIntegration, parseUpdateIntegration } from '../../src/api/integration-input';

const SLACK = 'https://hooks.slack.com/services/T000/B000/xxxxxxxx';
const LARK = 'https://open.larksuite.com/open-apis/bot/v2/hook/abc-123';

const valid = {
  name: 'Deploy alerts',
  repo: 'acme/web',
  eventTypes: ['workflow_run.failure', 'pull_request.merged'],
  destination: 'slack',
  webhookUrl: SLACK,
};

function fields(result: ReturnType<typeof parseCreateIntegration>): string[] {
  return result.ok ? [] : result.errors.map((e) => e.field);
}

describe('create validation', () => {
  it('accepts a valid Slack integration', () => {
    const r = parseCreateIntegration(valid);
    expect(r.ok && r.value).toEqual({ ...valid, signingSecret: null, filters: {} });
  });

  it('accepts a signed Lark integration', () => {
    const r = parseCreateIntegration({
      ...valid,
      destination: 'lark',
      webhookUrl: LARK,
      signingSecret: 'Abc123xyz',
    });
    expect(r.ok && r.value.signingSecret).toBe('Abc123xyz');
  });

  it('deduplicates event types', () => {
    const r = parseCreateIntegration({ ...valid, eventTypes: ['push', 'push'] });
    expect(r.ok && r.value.eventTypes).toEqual(['push']);
  });

  it.each([
    ['https://hooks.slack.com.evil.test/services/x', 'look-alike host'],
    ['http://hooks.slack.com/services/x', 'plain http'],
    ['https://user:pw@hooks.slack.com/services/x', 'userinfo'],
    ['https://hooks.slack.com:8443/services/x', 'non-default port'],
    ['https://hooks.slack.com/workflows/x', 'wrong path'],
    ['https://127.0.0.1/services/x', 'IP literal'],
    ['not a url', 'not a URL'],
    ['https://hooks.slack.com./services/x', 'trailing dot'],
    ['https://[::1]/services/x', 'IPv6 literal'],
    ['https://hooks.slack.com%2eevil.test/services/x', 'encoded dot in host'],
    ['https://evil.test\\@hooks.slack.com/services/x', 'backslash userinfo trick'],
  ])('rejects %s (%s) at write time', (webhookUrl) => {
    expect(fields(parseCreateIntegration({ ...valid, webhookUrl }))).toEqual(['webhookUrl']);
  });

  it('normalises harmless variants to the canonical host', () => {
    const r = parseCreateIntegration({
      ...valid,
      webhookUrl: 'HTTPS://HOOKS.SLACK.COM:443/services/T0/B0/x',
    });
    expect(r.ok && r.value.webhookUrl).toBe('https://hooks.slack.com/services/T0/B0/x');
  });

  it('rejects a Lark URL for a Slack destination', () => {
    expect(fields(parseCreateIntegration({ ...valid, webhookUrl: LARK }))).toEqual(['webhookUrl']);
  });

  it('never echoes the URL or secret in an error message', () => {
    const r = parseCreateIntegration({ ...valid, webhookUrl: 'https://evil.test/very-secret-path' });
    expect(JSON.stringify(r)).not.toContain('very-secret-path');
  });

  it('rejects event types outside the closed catalog (D16)', () => {
    expect(
      fields(parseCreateIntegration({ ...valid, eventTypes: ['issues.opened', 'star.created'] })),
    ).toEqual(['eventTypes']);
    expect(fields(parseCreateIntegration({ ...valid, eventTypes: [] }))).toEqual(['eventTypes']);
    expect(fields(parseCreateIntegration({ ...valid, eventTypes: 'push' }))).toEqual(['eventTypes']);
  });

  it.each(['acme', 'acme/', '/web', 'ac me/web', '-acme/web', 'acme--x/web', 'acme/..', 'a/b/c'])(
    'rejects repo %s',
    (repo) => {
      expect(fields(parseCreateIntegration({ ...valid, repo }))).toEqual(['repo']);
    },
  );

  it('rejects a signing secret for Slack and a malformed one for Lark', () => {
    expect(fields(parseCreateIntegration({ ...valid, signingSecret: 'x' }))).toEqual(['signingSecret']);
    expect(
      fields(
        parseCreateIntegration({
          ...valid,
          destination: 'lark',
          webhookUrl: LARK,
          signingSecret: 'has space',
        }),
      ),
    ).toEqual(['signingSecret']);
  });

  it('reports every invalid field at once', () => {
    expect(fields(parseCreateIntegration({ destination: 'discord' })).sort()).toEqual(
      ['destination', 'eventTypes', 'name', 'repo', 'webhookUrl'].sort(),
    );
    expect(fields(parseCreateIntegration([]))).toEqual(['body']);
  });

  it('rejects names that are blank, too long or contain control characters', () => {
    for (const name of ['', '   ', 'x'.repeat(81), 'bad\nname', 'safe\u202Etxt.exe', 'c1\u0085']) {
      expect(fields(parseCreateIntegration({ ...valid, name }))).toEqual(['name']);
    }
  });
});

describe('update validation', () => {
  it('accepts a partial update', () => {
    const r = parseUpdateIntegration({ enabled: false, eventTypes: ['push'] }, 'slack');
    expect(r.ok && r.value).toEqual({ enabled: false, eventTypes: ['push'] });
  });

  it('requires the URL when rotating a signing secret', () => {
    const r = parseUpdateIntegration({ signingSecret: 'abc' }, 'lark');
    expect(!r.ok && r.errors[0]?.field).toBe('signingSecret');
  });

  it('rotates credentials against the stored destination kind', () => {
    const r = parseUpdateIntegration({ webhookUrl: LARK, signingSecret: 'abc' }, 'lark');
    expect(r.ok && r.value.credentials).toEqual({ webhookUrl: LARK, signingSecret: 'abc' });
    expect(parseUpdateIntegration({ webhookUrl: LARK }, 'slack').ok).toBe(false);
  });

  it('refuses fields that cannot change, and empty updates', () => {
    expect(parseUpdateIntegration({ destination: 'lark' }, 'slack').ok).toBe(false);
    expect(parseUpdateIntegration({ organizationId: 'org-b' }, 'slack').ok).toBe(false);
    expect(parseUpdateIntegration({}, 'slack').ok).toBe(false);
    expect(parseUpdateIntegration({ enabled: 'yes' }, 'slack').ok).toBe(false);
  });
});

const TEAMS =
  'https://prod-12.westus.logic.azure.com/workflows/abc123/triggers/manual/paths/invoke?sig=s3cr3t';

describe('Microsoft Teams destination (ADR 0006)', () => {
  const teams = { ...valid, destination: 'teams', webhookUrl: TEAMS };

  it('accepts a Workflows trigger URL, with triggerAuth defaulting to anyone', () => {
    const r = parseCreateIntegration(teams);
    expect(r.ok && r.value).toMatchObject({ destination: 'teams', webhookUrl: TEAMS, signingSecret: null });
    expect(parseCreateIntegration({ ...teams, triggerAuth: 'anyone' }).ok).toBe(true);
  });

  it.each(['tenant_users', 'specific_users', 'bogus', 7])('rejects triggerAuth %s', (triggerAuth) => {
    const r = parseCreateIntegration({ ...teams, triggerAuth });
    expect(fields(r)).toEqual(['triggerAuth']);
    expect(JSON.stringify(r)).not.toContain('s3cr3t');
  });

  it('applies the single URL policy: URLs of other destinations are refused', () => {
    expect(fields(parseCreateIntegration({ ...teams, webhookUrl: SLACK }))).toEqual(['webhookUrl']);
    expect(fields(parseCreateIntegration({ ...valid, webhookUrl: TEAMS }))).toEqual(['webhookUrl']);
    expect(
      fields(parseCreateIntegration({ ...teams, webhookUrl: 'https://evil.test/logic.azure.com' })),
    ).toEqual(['webhookUrl']);
  });

  it('refuses a signing secret, and triggerAuth on other destinations', () => {
    expect(fields(parseCreateIntegration({ ...teams, signingSecret: 'x' }))).toEqual(['signingSecret']);
    expect(fields(parseCreateIntegration({ ...valid, triggerAuth: 'anyone' }))).toEqual(['triggerAuth']);
  });

  it('rotates Teams credentials and still validates triggerAuth', () => {
    const ok = parseUpdateIntegration({ webhookUrl: TEAMS, triggerAuth: 'anyone' }, 'teams');
    expect(ok.ok && ok.value.credentials).toEqual({ webhookUrl: TEAMS, signingSecret: null });
    expect(parseUpdateIntegration({ webhookUrl: TEAMS, triggerAuth: 'tenant_users' }, 'teams').ok).toBe(
      false,
    );
    expect(parseUpdateIntegration({ triggerAuth: 'anyone' }, 'teams').ok).toBe(false);
  });
});
