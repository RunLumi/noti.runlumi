import { describe, expect, it } from 'vitest';
import { parseCreateIntegration } from '../../../src/api/integration-input';
import { ApiError, parseInstallation, parseIntegration, type GithubInstallation } from '../lib/api';
import { allInstallationFor, isCovered, repoName } from './github/coverage';
import { returnMessage } from './github/ReturnStatus';
import { en, t, tp } from '../i18n';
import { DEFAULT_EVENTS, EVENT_GROUPS, EVENT_LABEL, GITHUB_EVENT_TYPES, sortEvents } from './events';
import { describeError } from './errors';
import {
  fromServer,
  validateName,
  validateRepo,
  validateSigningSecret,
  validateWebhookUrl,
} from './validation';
import { EMPTY_DRAFT, earliestStep, toBody, validateAll, validateStep, type Draft } from './wizard/draft';

const installation = (over: Partial<GithubInstallation>): GithubInstallation => ({
  id: 'row',
  account: 'acme',
  accountType: 'Organization',
  repositorySelection: 'selected',
  status: 'active',
  updatedAt: null,
  needsResync: false,
  repositories: [],
  ...over,
});
const INSTALLATIONS: GithubInstallation[] = [
  installation({ id: 'a', account: 'acme', repositories: ['acme/web', 'acme/api'] }),
  installation({ id: 'b', account: 'everything', accountType: 'User', repositorySelection: 'all' }),
  installation({ id: 'c', account: 'gone', repositorySelection: 'all', status: 'uninstalled' }),
];

const SLACK = 'https://hooks.slack.com/services/T000/B000/XXXX';
const LARK = 'https://open.larksuite.com/open-apis/bot/v2/hook/abc';

describe('event catalog labels', () => {
  it('labels every catalog event with an existing message', () => {
    for (const type of GITHUB_EVENT_TYPES) expect(en[EVENT_LABEL[type]]).toBeTruthy();
  });

  it('places every catalog event in exactly one group', () => {
    const grouped = EVENT_GROUPS.flatMap((g) => g.events);
    expect([...grouped].sort()).toEqual([...GITHUB_EVENT_TYPES].sort());
  });

  it('starts from the quiet failures-only default', () => {
    expect(DEFAULT_EVENTS).toEqual(['workflow_run.failure', 'workflow_run.timed_out']);
  });

  it('sorts by display order and keeps unknown legacy values last', () => {
    expect(sortEvents(['push', 'legacy.thing', 'workflow_run.failure'])).toEqual([
      'workflow_run.failure',
      'push',
      'legacy.thing',
    ]);
  });
});

describe('client validation mirrors the server', () => {
  // Each case is checked against the real server parser so the two cannot silently diverge.
  const server = (overrides: Record<string, unknown>) =>
    parseCreateIntegration({
      name: 'Ops',
      repo: 'acme/web',
      eventTypes: ['push'],
      destination: 'slack',
      webhookUrl: SLACK,
      ...overrides,
    });

  const urls: [string, 'slack' | 'lark' | 'teams' | 'discord' | 'generic_webhook'][] = [
    ['https://discord.com/api/webhooks/123456789012345678/Tok', 'discord'],
    ['https://discord.com/api/v10/webhooks/123456789012345678/Tok?thread_id=42', 'discord'],
    ['https://discordapp.com/api/webhooks/123456789012345678/Tok', 'discord'],
    ['https://discord.com/api/webhooks/123456789012345678/Tok?username=x', 'discord'],
    [SLACK, 'discord'],
    ['https://hooks.example.com/noti?channel=ci', 'generic_webhook'],
    ['https://hooks.example.com:8443/noti', 'generic_webhook'],
    ['http://hooks.example.com/noti', 'generic_webhook'],
    ['https://127.0.0.1/noti', 'generic_webhook'],
    ['https://2130706433/noti', 'generic_webhook'],
    ['https://localhost/noti', 'generic_webhook'],
    ['https://db.internal/noti', 'generic_webhook'],
    ['https://noti.runlumi.app/webhooks/generic/x', 'generic_webhook'],
    ['https://prod-12.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=x', 'teams'],
    ['https://logic.azure.com/workflows/abc', 'teams'],
    ['https://evil.test/logic.azure.com', 'teams'],
    ['https://logic.azure.com.evil.test/x', 'teams'],
    ['http://prod-12.westus.logic.azure.com/x', 'teams'],
    [SLACK, 'teams'],
    [SLACK, 'slack'],
    [LARK, 'lark'],
    ['https://open.feishu.cn/open-apis/bot/v2/hook/abc', 'lark'],
    ['http://hooks.slack.com/services/T/B/X', 'slack'],
    ['https://hooks.slack.com.evil.test/services/T/B/X', 'slack'],
    ['https://user@hooks.slack.com/services/T/B/X', 'slack'],
    ['https://hooks.slack.com:8443/services/T/B/X', 'slack'],
    ['https://hooks.slack.com/other/T/B/X', 'slack'],
    [LARK, 'slack'],
    ['not a url', 'slack'],
    ['', 'lark'],
  ];
  it.each(urls)('webhook %s for %s', (url, destination) => {
    const clientOk = validateWebhookUrl(url, destination) === undefined;
    const serverOk = server({ webhookUrl: url, destination }).ok;
    expect(clientOk).toBe(serverOk);
  });

  const repos = [
    'acme/web',
    'a/b',
    'Acme-Co/web.site_v2',
    '-acme/web',
    'acme--x/web',
    'acme',
    'acme/.',
    'a/b/c',
  ];
  it.each(repos)('repository %s', (repo) => {
    expect(validateRepo(repo) === undefined).toBe(server({ repo }).ok);
  });

  const names = ['Ops', 'x'.repeat(80), 'x'.repeat(81), '   ', 'line\nbreak', 'bidi\u202eevil', 'c1\u0085'];
  it.each(names)('name %j', (name) => {
    expect(validateName(name) === undefined).toBe(server({ name }).ok);
  });

  const secrets = ['abc123', 'has space', 'x'.repeat(256), 'x'.repeat(257), 'tab\there'];
  it.each(secrets)('signing secret %j', (signingSecret) => {
    const serverOk = server({ destination: 'lark', webhookUrl: LARK, signingSecret }).ok;
    expect(validateSigningSecret(signingSecret) === undefined).toBe(serverOk);
  });

  it('never echoes the submitted URL in its message', () => {
    const pasted = 'https://example.test/services/PRIVATE-PATH';
    expect(validateWebhookUrl(pasted, 'slack')).not.toContain('PRIVATE-PATH');
  });
});

describe('server field errors', () => {
  it('maps known fields inline and keeps the rest for a form notice', () => {
    const result = fromServer([
      { field: 'repo', message: 'Use the form owner/repository.' },
      { field: 'body', message: 'Expected a JSON object.' },
    ]);
    expect(result.fields).toEqual({ repo: 'Use the form owner/repository.' });
    expect(result.other).toEqual(['Expected a JSON object.']);
  });
});

describe('wizard draft', () => {
  const complete: Draft = {
    ...EMPTY_DRAFT,
    destination: 'lark',
    webhookUrl: LARK,
    repo: 'acme/web',
  };

  it('asks for the repository first, then the destination', () => {
    expect(validateStep(0, EMPTY_DRAFT, INSTALLATIONS)).toHaveProperty('repo');
    expect(validateStep(1, EMPTY_DRAFT, INSTALLATIONS)).toHaveProperty('destination');
    expect(earliestStep(validateAll(EMPTY_DRAFT, INSTALLATIONS), 4)).toBe(0);
  });

  it('accepts only repositories an active installation covers', () => {
    const at = (repo: string) => validateStep(0, { ...EMPTY_DRAFT, repo }, INSTALLATIONS);
    expect(at('Acme/Web')).toEqual({});
    expect(at('acme/secret')).toHaveProperty('repo');
    expect(at('everything/new-repo')).toEqual({});
    expect(at('gone/app')).toHaveProperty('repo');
  });

  it('builds a body that the server accepts, defaulting the name to the repository', () => {
    const body = toBody({ ...complete, destination: 'lark' });
    expect(body.name).toBe('acme/web');
    expect(body).not.toHaveProperty('signingSecret');
    expect(parseCreateIntegration(body).ok).toBe(true);
  });

  it('cuts a long repository to the name limit', () => {
    const repo = 'a'.repeat(39) + '/' + 'b'.repeat(100);
    const body = toBody({ ...complete, repo, destination: 'lark' });
    expect(parseCreateIntegration(body).ok).toBe(true);
  });

  it('sends a Lark signing secret only when one was entered', () => {
    const body = toBody({ ...complete, destination: 'lark', signingSecret: 'abc' });
    expect(body.signingSecret).toBe('abc');
  });

  it('routes server field errors back to the step that owns them', () => {
    expect(earliestStep({ eventTypes: 'x', webhookUrl: 'y' }, 4)).toBe(2);
    expect(earliestStep({ eventTypes: 'x', repo: 'y' }, 4)).toBe(0);
    expect(earliestStep({}, 4)).toBe(4);
  });
});

describe('messages', () => {
  it('interpolates and pluralises without concatenation', () => {
    expect(tp('integrations.count', 1)).toBe('1 integration');
    expect(tp('integrations.count', 3)).toBe('3 integrations');
    expect(t('delete.title', { name: 'Ops' })).toBe('Delete Ops?');
  });

  it('turns a 429 with Retry-After into a plain wait instruction', () => {
    const error = describeError(new ApiError('Too many changes', 429, [], 42));
    expect(error.message).toContain('42 seconds');
    expect(error.message).not.toMatch(/429/);
  });

  it('explains the workspace quota and never leads with the status code', () => {
    const error = describeError(new ApiError('limit', 409));
    expect(error.message).toContain('100 integrations');
    expect(error.reference).toBe('Reference for support: HTTP 409');
  });

  it('distinguishes a missing capability from a blocked request', () => {
    expect(describeError(new ApiError('Missing capability: integration.update', 403)).message).toBe(
      t('error.forbidden'),
    );
    expect(describeError(new ApiError('Forbidden', 403)).message).toBe(t('error.blocked'));
  });
});

describe('response parsing', () => {
  const row = {
    id: 'i1',
    name: 'Ops',
    repo: 'acme/web',
    eventTypes: ['push', 7],
    destination: 'slack',
    destinationHost: 'hooks.slack.com',
    enabled: true,
    credentials: 'legacy',
    createdAt: null,
    updatedAt: null,
  };

  it('accepts a well-formed row and drops non-string event values', () => {
    expect(parseIntegration(row).eventTypes).toEqual(['push']);
  });

  it('rejects a row with an unknown destination or credential state', () => {
    expect(() => parseIntegration({ ...row, destination: 'telegram' })).toThrow(ApiError);
    expect(() => parseIntegration({ ...row, credentials: 'unknown' })).toThrow(ApiError);
  });

  it('accepts a Teams row', () => {
    expect(parseIntegration({ ...row, destination: 'teams' }).destination).toBe('teams');
  });

  it.each(['discord', 'generic_webhook'] as const)('accepts a %s row', (destination) => {
    expect(parseIntegration({ ...row, destination }).destination).toBe(destination);
  });

  it('has no field that could carry a webhook URL', () => {
    expect(Object.keys(parseIntegration({ ...row, webhookUrl: SLACK }))).not.toContain('webhookUrl');
  });
});

describe('GitHub connection', () => {
  it('matches coverage case-insensitively and ignores inactive installations', () => {
    expect(isCovered('ACME/API', INSTALLATIONS)).toBe(true);
    expect(isCovered('gone/anything', INSTALLATIONS)).toBe(false);
    expect(allInstallationFor('Everything/x', INSTALLATIONS)?.account).toBe('everything');
    expect(repoName('everything/')).toBe('');
  });

  const codes = [
    'connected',
    'state_invalid',
    'state_user_mismatch',
    'installation_id_invalid',
    'oauth_failed',
    'installation_not_accessible',
    'installation_admin_required',
    'installation_bound_elsewhere',
    'installation_deleted',
    'installation_too_large',
    'workspace_access_lost',
    'github_unavailable',
    'not_configured',
    'signin_required',
    'unexpected_error',
  ];
  it.each(codes)('explains the %s return without showing the raw code', (code) => {
    const message = returnMessage(code);
    expect(message?.id).toBe(`github.return.${code}`);
    expect(message?.ok).toBe(code === 'connected');
    // Codes with an underscore are support keys; none may leak into the sentence (F220).
    if (code.includes('_')) expect(t(message?.id ?? 'github.return.unexpected_error')).not.toContain(code);
  });

  it('treats an unknown return code as an unexpected error, and no code as nothing', () => {
    expect(returnMessage('made_up')?.id).toBe('github.return.unexpected_error');
    expect(returnMessage(null)).toBeNull();
  });

  it('explains that only organization admins can connect an organization', () => {
    expect(t('github.return.installation_admin_required')).toMatch(/owner or admin/);
  });

  it('parses an installation and rejects an unknown status', () => {
    const raw = { ...INSTALLATIONS[0] };
    expect(parseInstallation(raw).repositories).toEqual(['acme/web', 'acme/api']);
    expect(() => parseInstallation({ ...raw, status: 'paused' })).toThrow(ApiError);
  });
});
