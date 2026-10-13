import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSourceSecretText, rewrapStaleSourceKeys } from '../../src/connectors/sources/generic/secret';
import { PROVIDER_KINDS } from '../../src/connectors/sources/types';
import { connectorFor, eventCatalogFor, isProviderKind } from '../../src/connectors/sources/registry';
import { GITLAB_EVENT_TYPES } from '../../src/connectors/sources/gitlab/catalog';
import { STRIPE_EVENT_TYPES } from '../../src/connectors/sources/stripe/catalog';
import { keyringFromEnv } from '../../src/crypto/keyring-env';
import { SUMMARY_MAX_CHARS, type DeliveryMessage } from '../../src/env';
import { SUMMARY_BUDGET } from '../../src/connectors/sources/text';
import { consumeDeliveries, type ConsumerDeps } from '../../src/pipeline/consumer';
import { LARK, SLACK, TEAMS, setup, type Harness } from './harness';
import { PIPELINE_FAILED } from './fixtures/gitlab';
import { INVOICE_PAYMENT_FAILED } from './fixtures/stripe';
import {
  gitlabSignHeaders,
  newSecretToken,
  newSigningToken,
  newStripeSecret,
  providerHelpers,
  stripeSignature,
} from './provider-harness';

vi.mock('../../src/auth/better-auth', async () => (await import('./harness')).mockAuth());
const { default: worker } = await import('../../src/index');

let h: Harness;
const { call, createProviderSource, postTo } = providerHelpers(worker, () => h);

beforeEach(() => {
  h = setup();
});
afterEach(() => vi.unstubAllGlobals());

// Deliberately malformed credentials (wrong prefix, spaces, wrong key type).
const JUNK_A = ['not', 'a', 'whsec', 'value'].join('-');
const JUNK_B = ['has', 'a', 'space'].join(' ');
const JUNK_C = ['sk', 'live', 'nope'].join('_');

const createRaw = (body: Record<string, unknown>, as = 'alice') =>
  call('POST', '/api/sources', { as, body: { name: 'Source', ...body } });
const fields = async (res: Response) =>
  (await res.json<{ fields: { field: string; message: string }[] }>()).fields.map((f) => f.field);
const connectRaw = (body: Record<string, unknown>, as = 'alice') =>
  call('POST', '/api/integrations', {
    as,
    body: { name: 'to slack', destination: 'slack', webhookUrl: SLACK, ...body },
  });

describe('registry', () => {
  it('the mappers share the notification summary budget', () => {
    expect(SUMMARY_BUDGET).toBe(SUMMARY_MAX_CHARS);
  });

  it('registers exactly GitLab and Stripe; Sentry is not a registered source (spec 06 F89)', () => {
    expect([...PROVIDER_KINDS].sort()).toEqual(['gitlab', 'stripe']);
    expect(isProviderKind('sentry')).toBe(false);
    expect(isProviderKind('generic')).toBe(false);
    expect(eventCatalogFor('sentry')).toBeNull();
    expect(eventCatalogFor('generic')).toBeNull();
  });

  it('every connector has a closed, non-empty catalogue and a decoy that verifies nothing', () => {
    expect(connectorFor('gitlab').eventCatalog).toEqual(GITLAB_EVENT_TYPES);
    expect(connectorFor('stripe').eventCatalog).toEqual(STRIPE_EVENT_TYPES);
    for (const kind of PROVIDER_KINDS) {
      const connector = connectorFor(kind);
      expect(connector.eventCatalog.length).toBeGreaterThan(0);
      expect(new Set(connector.eventCatalog).size).toBe(connector.eventCatalog.length);
      expect(connector.maxBodyBytes).toBeLessThanOrEqual(1024 * 1024);
    }
  });

  it('a Sentry source cannot be created and the refusal says why', async () => {
    const res = await createRaw({ kind: 'sentry', secret: 'x'.repeat(20) });
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).toContain('re-serialised');
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM sources').get()).toEqual({ n: 0 });
    // And there is no route for it.
    const probe = await postTo(`/webhooks/sentry/${'A'.repeat(24)}`, '{}', {});
    expect(probe.status).toBe(404);
  });
});

describe('create: GitLab (pasted credential)', () => {
  it('seals a signing token, never echoes it, and records only the auth mode', async () => {
    const token = newSigningToken();
    const res = await createRaw({ kind: 'gitlab', authMode: 'signing_token', secret: token });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).not.toContain(token);
    expect(text).not.toContain(token.slice(6));
    const body = JSON.parse(text) as { source: Record<string, unknown>; secret?: string };
    expect(body.secret).toBeUndefined();
    expect(body.source).toMatchObject({ kind: 'gitlab', authMode: 'signing_token', livemode: null });
    expect(body.source.endpointUrl).toBe(
      `https://noti.test/webhooks/gitlab/${String(body.source.endpointId)}`,
    );

    // Stored only sealed, and it opens back to the pasted text with the right AAD.
    const row = h.db.raw.prepare('SELECT * FROM sources').get() as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(token);
    const opened = await openSourceSecretText(row as never, keyringFromEnv(h.env));
    expect(opened).toBe(token);
    const audit = JSON.stringify(h.db.raw.prepare('SELECT metadata_json FROM audit_events').all());
    expect(audit).not.toContain(token.slice(6));
    expect(audit).toContain('signing_token');
  });

  it('a sealed secret copied to another source fails to open (AAD binds the source)', async () => {
    await createProviderSource('gitlab', newSecretToken(), { authMode: 'secret_token' });
    await createProviderSource('gitlab', newSecretToken(), { authMode: 'secret_token' });
    const [a, b] = h.db.raw.prepare('SELECT * FROM sources ORDER BY rowid').all() as Record<
      string,
      unknown
    >[];
    await expect(
      openSourceSecretText(
        { ...(a as object), secret_envelope: (b as Record<string, unknown>).secret_envelope } as never,
        keyringFromEnv(h.env),
      ),
    ).rejects.toBeTruthy();
  });

  it('validates the auth mode and each credential shape without echoing the value', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ kind: 'gitlab', secret: newSecretToken() }, 'authMode'],
      [{ kind: 'gitlab', authMode: 'bogus', secret: newSecretToken() }, 'authMode'],
      [{ kind: 'gitlab', authMode: 'signing_token' }, 'secret'],
      [{ kind: 'gitlab', authMode: 'signing_token', secret: JUNK_A }, 'secret'],
      [{ kind: 'gitlab', authMode: 'signing_token', secret: 'whsec' + '_!!!notbase64' }, 'secret'],
      [{ kind: 'gitlab', authMode: 'secret_token', secret: 'short' }, 'secret'],
      [{ kind: 'gitlab', authMode: 'secret_token', secret: JUNK_B }, 'secret'],
      [{ kind: 'gitlab', authMode: 'secret_token', secret: 'x'.repeat(256) }, 'secret'],
    ];
    for (const [body, field] of cases) {
      const res = await createRaw(body);
      expect(res.status, JSON.stringify(Object.keys(body))).toBe(422);
      const text = await res.clone().text();
      expect(await fields(res)).toContain(field);
      if (typeof body.secret === 'string' && body.secret.length >= 12)
        expect(text).not.toContain(body.secret);
    }
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM sources').get()).toEqual({ n: 0 });
  });

  it('rejects an unknown kind and still creates generic sources exactly as before', async () => {
    expect(await fields(await createRaw({ kind: 'github' }))).toEqual(['kind']);
    const res = await createRaw({});
    expect(res.status).toBe(201);
    const body = await res.json<{ source: { kind: string }; secret: string }>();
    expect(body.source.kind).toBe('generic');
    expect(body.secret).toMatch(/^whsec_/);
  });
});

describe('create: Stripe', () => {
  it('requires a live/test choice and a whsec_ secret, and stores livemode', async () => {
    expect(await fields(await createRaw({ kind: 'stripe', secret: newStripeSecret() }))).toEqual([
      'livemode',
    ]);
    expect(await fields(await createRaw({ kind: 'stripe', livemode: false, secret: JUNK_C }))).toEqual([
      'secret',
    ]);
    expect(
      await fields(
        await createRaw({
          kind: 'stripe',
          livemode: false,
          authMode: 'signing_token',
          secret: newStripeSecret(),
        }),
      ),
    ).toEqual(['authMode']);
    const res = await createRaw({ kind: 'stripe', livemode: true, secret: newStripeSecret() });
    expect(res.status).toBe(201);
    expect((await res.json<{ source: Record<string, unknown> }>()).source).toMatchObject({
      kind: 'stripe',
      livemode: true,
      authMode: null,
    });
  });
});

describe('authorization and tenancy', () => {
  it('members may create provider sources; rotate is admin-only', async () => {
    const created = await createRaw({ kind: 'stripe', livemode: false, secret: newStripeSecret() }, 'bob');
    expect(created.status).toBe(201);
    const { source } = await created.json<{ source: { id: string } }>();
    const rotate = await call('POST', `/api/sources/${source.id}/rotate`, {
      as: 'bob',
      body: { secret: newStripeSecret() },
    });
    expect(rotate.status).toBe(403);
  });

  it('another workspace cannot see, rotate or connect to a provider source', async () => {
    const src = await createProviderSource('gitlab', newSigningToken(), { authMode: 'signing_token' });
    const list = await call('GET', '/api/sources', { as: 'mallory' });
    expect((await list.json<{ sources: unknown[] }>()).sources).toHaveLength(0);
    const rotate = await call('POST', `/api/sources/${src.id}/rotate`, {
      as: 'mallory',
      body: { authMode: 'signing_token', secret: newSigningToken() },
    });
    expect(rotate.status).toBe(404);
    expect((await connectRaw({ sourceId: src.id }, 'mallory')).status).toBe(422);
  });

  it('a non-JSON or cross-site create is refused', async () => {
    const res = await call('POST', '/api/sources', {
      as: 'alice',
      origin: 'https://evil.example',
      body: { name: 'x', kind: 'stripe' },
    });
    expect(res.status).toBe(403);
  });
});

describe('rotate with a pasted credential', () => {
  it('GitLab: the old credential stops working at once; the mode can move to a signing token', async () => {
    const src = await createProviderSource('gitlab', newSecretToken(), { authMode: 'secret_token' });
    await connectRaw({ sourceId: src.id });
    const body = JSON.stringify({ ...PIPELINE_FAILED });
    const withToken = (token: string) =>
      postTo(`/webhooks/gitlab/${src.endpointId}`, body, {
        'x-gitlab-event': 'Pipeline Hook',
        'x-gitlab-token': token,
      });
    expect((await withToken(src.secret)).status).toBe(202);

    const signing = newSigningToken();
    const res = await call('POST', `/api/sources/${src.id}/rotate`, {
      as: 'alice',
      body: { authMode: 'signing_token', secret: signing },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(signing);
    expect(JSON.parse(text)).toMatchObject({ source: { authMode: 'signing_token' } });
    expect((await withToken(src.secret)).status).toBe(401);
    const signed = await postTo(`/webhooks/gitlab/${src.endpointId}`, body, {
      'x-gitlab-event': 'Pipeline Hook',
      ...gitlabSignHeaders(signing, body, { id: 'after-rotate' }),
    });
    expect(signed.status).toBe(202);
    expect(
      (
        h.db.raw
          .prepare("SELECT action FROM audit_events WHERE action='source.secret.rotate'")
          .all() as unknown[]
      ).length,
    ).toBe(1);
  });

  it('requires the new credential, validates it, and refuses to change test/live', async () => {
    const src = await createProviderSource('stripe', newStripeSecret(), { livemode: false });
    const post = (body: Record<string, unknown>) =>
      call('POST', `/api/sources/${src.id}/rotate`, { as: 'alice', body });
    expect((await post({})).status).toBe(422);
    expect(await fields(await post({ secret: 'nope' }))).toEqual(['secret']);
    expect(await fields(await post({ secret: newStripeSecret(), livemode: true }))).toEqual(['livemode']);
    const next = newStripeSecret();
    const ok = await post({ secret: next });
    expect(ok.status).toBe(200);
    const body = JSON.stringify(INVOICE_PAYMENT_FAILED);
    const send = (s: string) =>
      postTo(`/webhooks/stripe/${src.endpointId}`, body, { 'stripe-signature': stripeSignature(s, body) });
    expect((await send(src.secret)).status).toBe(401);
    expect((await send(next)).status).toBe(202);
  });

  it('KEK rewrap covers provider sources without changing the credential', async () => {
    const token = newSecretToken();
    const src = await createProviderSource('gitlab', token, { authMode: 'secret_token' });
    h.env.KEK_V2 = '22'.repeat(32);
    h.env.KMS_ACTIVE_VERSION = '2';
    expect(await rewrapStaleSourceKeys(h.db.d1, keyringFromEnv(h.env))).toBe(1);
    const row = h.db.raw.prepare('SELECT * FROM sources WHERE id=?').get(src.id) as Record<string, unknown>;
    expect(await openSourceSecretText(row as never, keyringFromEnv(h.env))).toBe(token);
  });
});

describe('integrations on provider sources: event types', () => {
  it('accepts catalogue types, defaults to all, and stores what was chosen', async () => {
    const src = await createProviderSource('gitlab', newSigningToken(), { authMode: 'signing_token' });
    const all = await connectRaw({ sourceId: src.id });
    expect((await all.json<{ integration: { eventTypes: string[] } }>()).integration.eventTypes).toEqual([]);
    const some = await connectRaw({
      sourceId: src.id,
      eventTypes: ['pipeline.failed', 'pipeline.failed', 'push'],
    });
    expect(some.status).toBe(201);
    expect((await some.json<{ integration: { eventTypes: string[] } }>()).integration.eventTypes).toEqual([
      'pipeline.failed',
      'push',
    ]);
  });

  it('rejects types outside the source kind’s catalogue, malformed lists, and any type on a generic source', async () => {
    const gl = await createProviderSource('gitlab', newSigningToken(), { authMode: 'signing_token' });
    const generic = await (
      await call('POST', '/api/sources', { as: 'alice', body: { name: 'g' } })
    ).json<{
      source: { id: string };
    }>();
    for (const body of [
      { sourceId: gl.id, eventTypes: ['invoice.payment_failed'] },
      { sourceId: gl.id, eventTypes: ['issues.opened'] },
      { sourceId: gl.id, eventTypes: 'push' },
      { sourceId: gl.id, eventTypes: [1] },
      { sourceId: gl.id, eventTypes: ['Push; DROP'] },
      { sourceId: generic.source.id, eventTypes: ['push'] },
    ]) {
      const res = await connectRaw(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(await fields(res)).toContain('eventTypes');
    }
    // Filters and repositories stay GitHub-only.
    expect(await fields(await connectRaw({ sourceId: gl.id, filters: {} }))).toContain('filters');
    expect(await fields(await connectRaw({ sourceId: gl.id, repo: 'a/b' }))).toContain('repo');
  });

  it('can change the selection later, validated against the same catalogue; repo and filters stay locked', async () => {
    const src = await createProviderSource('stripe', newStripeSecret(), { livemode: false });
    const made = await connectRaw({ sourceId: src.id });
    const { integration } = await made.json<{ integration: { id: string } }>();
    const patch = (body: Record<string, unknown>) =>
      call('PATCH', `/api/integrations/${integration.id}`, { as: 'alice', body });
    const ok = await patch({ eventTypes: ['charge.dispute.created'] });
    expect(ok.status).toBe(200);
    expect((await ok.json<{ integration: { eventTypes: string[] } }>()).integration.eventTypes).toEqual([
      'charge.dispute.created',
    ]);
    expect((await patch({ eventTypes: ['push'] })).status).toBe(422);
    expect((await patch({ eventTypes: [] })).status).toBe(200);
    expect((await patch({ repo: 'acme/web' })).status).toBe(422);
    expect((await patch({ filters: {} })).status).toBe(422);
    const audit = JSON.stringify(h.db.raw.prepare('SELECT metadata_json FROM audit_events').all());
    expect(audit).toContain('charge.dispute.created');
  });

  it('GitHub integrations are untouched: GitHub event types are still validated against the GitHub catalogue', async () => {
    const res = await call('POST', '/api/integrations', {
      as: 'alice',
      body: {
        name: 'gh',
        repo: 'acme/web',
        eventTypes: ['pipeline.failed'],
        destination: 'slack',
        webhookUrl: SLACK,
      },
    });
    expect(res.status).toBe(422);
  });
});

describe('end to end through the destination adapters', () => {
  const deps: ConsumerDeps = {
    random: () => 0.5,
    now: () => Date.now(),
    newClaimToken: () => crypto.randomUUID(),
  };

  async function deliverAll() {
    const rows = h.db.raw.prepare('SELECT payload_json FROM notification_outbox ORDER BY rowid').all() as {
      payload_json: string;
    }[];
    for (const r of rows) {
      const msg = {
        body: JSON.parse(r.payload_json) as DeliveryMessage,
        attempts: 1,
        ack: vi.fn(),
        retry: vi.fn(),
      };
      await consumeDeliveries(
        { messages: [msg], retryAll: () => undefined } as unknown as MessageBatch<unknown>,
        h.env,
        deps,
      );
      expect(msg.ack).toHaveBeenCalled();
    }
  }

  it.each([
    ['slack', SLACK],
    ['lark', LARK],
    ['teams', TEAMS],
  ] as const)('a GitLab pipeline failure reaches %s as a rendered message', async (destination, url) => {
    const src = await createProviderSource('gitlab', newSigningToken(), { authMode: 'signing_token' });
    expect((await connectRaw({ sourceId: src.id, destination, webhookUrl: url })).status).toBe(201);
    const body = JSON.stringify(PIPELINE_FAILED);
    const res = await postTo(`/webhooks/gitlab/${src.endpointId}`, body, {
      'x-gitlab-event': 'Pipeline Hook',
      ...gitlabSignHeaders(src.secret, body),
    });
    expect(res.status).toBe(202);
    h.fetchMock.mockClear();
    h.fetchMock.mockResolvedValue(
      destination === 'lark'
        ? new Response(JSON.stringify({ code: 0 }), { status: 200 })
        : destination === 'teams'
          ? new Response(null, { status: 202 })
          : new Response('ok', { status: 200 }),
    );
    await deliverAll();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = h.fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(target).toBe(url);
    expect(init.body).toContain('Pipeline failed on master');
    expect(init.body).toContain('gitlab-org/gitlab-test');
    expect(init.body).toContain('https://gitlab.com/gitlab-org/gitlab-test/-/pipelines/31');
    expect(init.body).not.toContain('user_email@gitlab.com');
  });

  it('a Stripe payment failure reaches Slack with amount and no customer personal data', async () => {
    const src = await createProviderSource('stripe', newStripeSecret(), { livemode: false });
    await connectRaw({ sourceId: src.id });
    const body = JSON.stringify(INVOICE_PAYMENT_FAILED);
    const res = await postTo(`/webhooks/stripe/${src.endpointId}`, body, {
      'stripe-signature': stripeSignature(src.secret, body),
    });
    expect(res.status).toBe(202);
    h.fetchMock.mockClear();
    await deliverAll();
    const [, init] = h.fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(init.body).toContain('Invoice payment failed');
    expect(init.body).toContain('20.00 USD');
    for (const pii of ['jennyrosen', 'Jenny Rosen', '+15555550100']) expect(init.body).not.toContain(pii);
  });
});

describe('workspace lifecycle', () => {
  it('deleting a provider source deletes its integrations and its sealed key', async () => {
    const src = await createProviderSource('stripe', newStripeSecret(), { livemode: false });
    await connectRaw({ sourceId: src.id });
    expect((await call('DELETE', `/api/sources/${src.id}`, { as: 'alice' })).status).toBe(409);
    expect((await call('DELETE', `/api/sources/${src.id}?cascade=true`, { as: 'alice' })).status).toBe(204);
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM sources').get()).toEqual({ n: 0 });
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM integrations').get()).toEqual({ n: 0 });
  });
});
