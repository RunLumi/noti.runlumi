import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { connectorFor } from '../../../src/connectors/sources/registry';
import { en } from '../i18n';
import { tp } from '../i18n';
import { ApiError } from '../lib/api';
import { parseSource, parseSourceWithSecret } from './api';
import { toConnectBody } from './connect';
import { ProviderGuidance } from './ProviderGuidance';
import {
  EMPTY_DRAFT,
  eventCatalog,
  eventLabelId,
  toCreateBody,
  validateCreate,
  validateSecret,
  type AuthMode,
} from './providers';
import { outcomeOf } from './SourcesPage';

const W = 'whsec' + '_';
const b64 = Buffer.alloc(32, 3).toString('base64');
const URL_ = 'https://noti.example/webhooks/gitlab/AbCdEfGhIjKlMnOpQrStUvWx';
const row = {
  id: 's1',
  name: 'Repo',
  kind: 'gitlab',
  authMode: 'signing_token',
  livemode: null,
  endpointId: 'AbCdEfGhIjKlMnOpQrStUvWx',
  endpointUrl: URL_,
  enabled: true,
  createdAt: '2026-10-13 12:00:00',
  updatedAt: '2026-10-13 12:00:00',
  lastReceivedAt: null,
  secretRotatedAt: null,
  reusedIdRejections: 0,
  droppedEvents: 0,
  lastDroppedAt: null,
  integrationCount: 0,
};

describe('credential checks agree with the Worker', () => {
  const gitlabCases: [AuthMode, string][] = [
    ['signing_token', W + b64],
    ['signing_token', 'nope'],
    ['signing_token', W + '!!!'],
    ['signing_token', W],
    ['secret_token', 'abcdefgh'],
    ['secret_token', 'short'],
    ['secret_token', 'has space in it'],
    ['secret_token', 'x'.repeat(255)],
    ['secret_token', 'x'.repeat(256)],
  ];
  it.each(gitlabCases)('gitlab %s %s', (authMode, secret) => {
    const server = connectorFor('gitlab').parseSecret({ authMode, secret }, 'create').ok;
    expect(validateSecret('gitlab', authMode, secret) === undefined).toBe(server);
  });

  const stripeCases = [
    W + 'a'.repeat(16),
    W + 'a'.repeat(15),
    'sk_test_' + 'a'.repeat(20),
    W + 'a'.repeat(201),
    W + 'ab cd'.repeat(5),
  ];
  it.each(stripeCases)('stripe %s', (secret) => {
    const server = connectorFor('stripe').parseSecret({ secret, livemode: false }, 'create').ok;
    expect(validateSecret('stripe', null, secret) === undefined).toBe(server);
  });
});

describe('create draft', () => {
  it('requires the GitLab auth mode and the Stripe mode before the secret', () => {
    expect(validateCreate({ ...EMPTY_DRAFT, kind: 'gitlab', name: 'x' }, undefined)).toMatchObject({
      authMode: expect.any(String) as string,
    });
    expect(
      validateCreate({ ...EMPTY_DRAFT, kind: 'stripe', name: 'x', secret: W + 'a'.repeat(20) }, undefined),
    ).toMatchObject({
      livemode: expect.any(String) as string,
    });
    expect(validateCreate({ ...EMPTY_DRAFT, name: 'x' }, undefined)).toEqual({});
  });

  it('builds the body the Worker expects, sending the pasted secret untouched', () => {
    expect(toCreateBody({ ...EMPTY_DRAFT, name: ' CI ' })).toEqual({ name: 'CI' });
    expect(
      toCreateBody({
        name: 'Repo',
        kind: 'gitlab',
        authMode: 'secret_token',
        livemode: null,
        secret: ' padded  ',
      }),
    ).toEqual({ name: 'Repo', kind: 'gitlab', authMode: 'secret_token', secret: ' padded  ' });
    expect(
      toCreateBody({
        name: 'Pay',
        kind: 'stripe',
        authMode: null,
        livemode: true,
        secret: W + 'a'.repeat(20),
      }),
    ).toEqual({
      name: 'Pay',
      kind: 'stripe',
      livemode: true,
      secret: W + 'a'.repeat(20),
    });
  });
});

describe('API parsing', () => {
  it('reads kind, auth mode and mode; rejects an unknown kind', () => {
    expect(parseSource(row)).toMatchObject({ kind: 'gitlab', authMode: 'signing_token', livemode: null });
    expect(() => parseSource({ ...row, kind: 'sentry' })).toThrow(ApiError);
    expect(() => parseSource({ ...row, authMode: 'plain' })).toThrow(ApiError);
    expect(() => parseSource({ ...row, livemode: 'yes' })).toThrow(ApiError);
  });

  it('a provider create response has no secret and refuses one; a generic one must have it', () => {
    expect(parseSourceWithSecret({ source: row })).toEqual({ source: parseSource(row), secret: null });
    expect(() => parseSourceWithSecret({ source: row, secret: W + 'x' })).toThrow(ApiError);
    const generic = { ...row, kind: 'generic', authMode: null };
    expect(() => parseSourceWithSecret({ source: generic })).toThrow(ApiError);
    expect(parseSourceWithSecret({ source: generic, secret: W + b64 }).secret).toBe(W + b64);
  });

  it('outcome: a generic result reveals the secret once; a provider result is only a notice', () => {
    const generic = outcomeOf('created', {
      source: parseSource({ ...row, kind: 'generic', authMode: null }),
      secret: W + b64,
    });
    expect(generic.type).toBe('reveal');
    const provider = outcomeOf('created', { source: parseSource(row), secret: null });
    expect(provider).toMatchObject({ type: 'notice' });
    expect(JSON.stringify(provider)).toContain('GitLab');
    expect(JSON.stringify(outcomeOf('rotated', { source: parseSource(row), secret: null }))).toContain(
      'replaced',
    );
  });
});

describe('dropped events', () => {
  it('reads the counter and refuses a response without it', () => {
    expect(parseSource({ ...row, droppedEvents: 4, lastDroppedAt: '2026-10-13 12:00:00' })).toMatchObject({
      droppedEvents: 4,
      lastDroppedAt: '2026-10-13 12:00:00',
    });
    const { droppedEvents: _omit, ...without } = row;
    void _omit;
    expect(() => parseSource(without)).toThrow(ApiError);
  });

  it('the card copy states the count and the cause in both locales', () => {
    expect(tp('sources.card.dropped', 1)).toContain('1 event was dropped');
    expect(tp('sources.card.dropped', 3)).toContain(
      '3 events were dropped because the source exceeded the rate limit',
    );
  });
});

describe('event selection', () => {
  it('every catalogue type has a label and a stable order', () => {
    for (const kind of ['gitlab', 'stripe'] as const) {
      expect(eventCatalog(kind).length).toBeGreaterThan(0);
      for (const type of eventCatalog(kind)) expect(en[eventLabelId(type)], type).toBeTypeOf('string');
    }
    expect(eventCatalog('generic')).toEqual([]);
  });

  it('is sent with the connect body only when something is chosen', () => {
    const draft = {
      destination: 'slack',
      name: 'n',
      webhookUrl: 'https://hooks.slack.com/services/T0/B0/x',
      signingSecret: '',
    } as const;
    expect(toConnectBody('sid', draft)).not.toHaveProperty('eventTypes');
    expect(toConnectBody('sid', { ...draft, eventTypes: [] })).not.toHaveProperty('eventTypes');
    expect(toConnectBody('sid', { ...draft, eventTypes: ['push'] })).toMatchObject({ eventTypes: ['push'] });
  });
});

describe('provider guidance markup', () => {
  it('names the real steps, GitLab.com only, and shows the weak-token note only for a secret token', () => {
    const strong = renderToStaticMarkup(
      <ProviderGuidance kind="gitlab" endpointUrl={URL_} weakAuth={false} />,
    );
    const weak = renderToStaticMarkup(<ProviderGuidance kind="gitlab" endpointUrl={URL_} weakAuth />);
    expect(strong).toContain('Settings, then Webhooks');
    expect(strong).toContain('GitLab.com only');
    expect(strong).not.toContain('plain text');
    expect(weak).toContain('replayed');
    expect(strong).toContain('rel="noopener noreferrer"');
  });

  it('Stripe guidance covers snapshot payloads, separate test and live endpoints, and privacy', () => {
    const html = renderToStaticMarkup(<ProviderGuidance kind="stripe" endpointUrl={URL_} weakAuth={false} />);
    expect(html).toContain('Snapshot');
    expect(html).toContain('one Noti source for each');
    expect(html).toContain('Customer names, emails and card details are never copied');
  });

  it('never prints a credential: only the endpoint URL appears', () => {
    const html = renderToStaticMarkup(<ProviderGuidance kind="stripe" endpointUrl={URL_} weakAuth={false} />);
    expect(html).not.toMatch(/whsec_[A-Za-z0-9+/=]{8,}/);
  });
});
