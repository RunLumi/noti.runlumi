import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapGitlab } from '../../src/connectors/sources/gitlab/map';
import { ENDPOINT_PREAUTH_LIMIT_PER_MINUTE, subscribed } from '../../src/connectors/sources/provider-route';
import { computeSummary } from '../../src/observability/slis';
import { scrubString } from '../../src/platform/redact';
import { SOURCE_INGRESS_LIMIT_PER_MINUTE } from '../../src/security/rate-limit';
import { applyMigration, createFakeD1 } from '../support/d1';
import { SLACK, setup, type Harness } from './harness';
import { ISSUE, MERGE_REQUEST, PIPELINE_FAILED, PUSH } from './fixtures/gitlab';
import {
  gitlabSignHeaders,
  newSecretToken,
  newSigningToken,
  providerHelpers,
  type ProviderSource,
} from './provider-harness';

vi.mock('../../src/auth/better-auth', async () => (await import('./harness')).mockAuth());
const { default: worker } = await import('../../src/index');

let h: Harness;
const { call, createProviderSource, postTo } = providerHelpers(worker, () => h);

beforeEach(() => {
  h = setup();
});
afterEach(() => vi.unstubAllGlobals());

const map = (event: string, body: unknown) =>
  mapGitlab({ headers: new Headers({ 'x-gitlab-event': event }), body, source: { livemode: null } });

describe('M1: links must be on gitlab.com', () => {
  const EVIL = [
    'https://evil.example/x',
    'https://gitlab.com.evil.io/x',
    'https://evilgitlab.com/x',
    'http://gitlab.com/x',
    'javascript:alert(1)',
    'https://user:pw@gitlab.com/x',
  ];

  it.each(EVIL)('drops %s but still delivers the event', (url) => {
    const withCommitUrl = {
      ...PUSH,
      commits: [{ ...PUSH.commits[0], url }],
    };
    const mr = {
      ...MERGE_REQUEST,
      object_attributes: { ...MERGE_REQUEST.object_attributes, url },
    };
    const issue = { ...ISSUE, object_attributes: { ...ISSUE.object_attributes, url } };
    const pipeline = {
      ...PIPELINE_FAILED,
      object_attributes: { ...PIPELINE_FAILED.object_attributes, url },
    };
    for (const [event, body] of [
      ['Push Hook', withCommitUrl],
      ['Merge Request Hook', mr],
      ['Issue Hook', issue],
      ['Pipeline Hook', pipeline],
    ] as const) {
      const r = map(event, body);
      expect(r.outcome, event).toBe('deliver');
      if (r.outcome === 'deliver') expect(r.display.url, event).toBe('');
    }
  });

  it('keeps a genuine gitlab.com link and a subdomain of it', () => {
    const r = map('Merge Request Hook', MERGE_REQUEST);
    expect(r).toMatchObject({
      display: { url: expect.stringMatching(/^https:\/\/gitlab\.com\//) as string },
    });
    const sub = {
      ...MERGE_REQUEST,
      object_attributes: { ...MERGE_REQUEST.object_attributes, url: 'https://docs.gitlab.com/x' },
    };
    expect(map('Merge Request Hook', sub)).toMatchObject({ display: { url: 'https://docs.gitlab.com/x' } });
  });
});

describe('L4: a confidential issue builds no label text', () => {
  it('has no labels in the summary or anywhere in the result', () => {
    const body = { ...ISSUE, object_attributes: { ...ISSUE.object_attributes, confidential: true } };
    const text = JSON.stringify(map('Issue Hook', body));
    expect(text).not.toContain('Labels');
    expect(text).not.toContain('API related');
  });
});

describe('M2: a dropped event is counted and visible', () => {
  async function floodedSource(): Promise<ProviderSource> {
    const src = await createProviderSource('gitlab', newSigningToken(), { authMode: 'signing_token' });
    h.db.raw
      .prepare('INSERT INTO api_rate_limits(key,window_start,count) VALUES(?,?,?)')
      .run(
        `ingress:source:${src.id}`,
        Math.floor(Date.now() / 60_000) * 60_000,
        SOURCE_INGRESS_LIMIT_PER_MINUTE,
      );
    return src;
  }
  const send = (src: ProviderSource) => {
    const body = JSON.stringify(PUSH);
    return postTo(`/webhooks/gitlab/${src.endpointId}`, body, {
      'x-gitlab-event': 'Push Hook',
      ...gitlabSignHeaders(src.secret, body),
    });
  };

  it('increments the counter, shows it in the API, the export and the SLI summary', async () => {
    const src = await floodedSource();
    for (let i = 0; i < 2; i++)
      expect(await (await send(src)).json()).toEqual({ accepted: false, dropped: 'rate_limited' });
    const row = h.db.raw
      .prepare('SELECT dropped_events,last_dropped_at FROM sources WHERE id=?')
      .get(src.id) as {
      dropped_events: number;
      last_dropped_at: string | null;
    };
    expect(row.dropped_events).toBe(2);
    expect(row.last_dropped_at).not.toBeNull();

    const view = await (
      await call('GET', `/api/sources/${src.id}`, { as: 'alice' })
    ).json<{
      source: { droppedEvents: number; lastDroppedAt: string | null };
    }>();
    expect(view.source.droppedEvents).toBe(2);
    expect(view.source.lastDroppedAt).not.toBeNull();

    const summary = await computeSummary(h.db.d1, 'org-a', 24 * 60 * 60 * 1000);
    expect(summary.ingressDropped).toEqual({ total: 2, sourcesInWindow: 1 });
    // Another workspace sees none of it.
    expect((await computeSummary(h.db.d1, 'org-b', 24 * 60 * 60 * 1000)).ingressDropped).toEqual({
      total: 0,
      sourcesInWindow: 0,
    });
  });

  it('an unflooded source reports zero', async () => {
    const src = await createProviderSource('gitlab', newSigningToken(), { authMode: 'signing_token' });
    expect((await send(src)).status).toBe(202);
    const summary = await computeSummary(h.db.d1, 'org-a', 24 * 60 * 60 * 1000);
    expect(summary.ingressDropped).toEqual({ total: 0, sourcesInWindow: 0 });
  });
});

describe('migration 0020', () => {
  it('adds the counters with a zero default and keeps existing rows', () => {
    const { raw } = createFakeD1({ before: '0020' });
    raw.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES('o','o','o',1)").run();
    raw
      .prepare(
        `INSERT INTO sources(id,organization_id,kind,name,endpoint_id,secret_envelope,key_salt,dek_wrapped,kek_version)
         VALUES('s','o','gitlab','n',?,x'00',x'00',x'00',1)`,
      )
      .run('a'.repeat(24));
    applyMigration(raw, '0020_source_dropped_events.sql');
    expect(raw.prepare('SELECT id,dropped_events,last_dropped_at FROM sources').all()).toEqual([
      { id: 's', dropped_events: 0, last_dropped_at: null },
    ]);
  });
});

describe('L1: coarse limiter in front of the secret unwrap', () => {
  it('answers 429 before opening the secret, signed or not, once the endpoint budget is spent', async () => {
    const src = await createProviderSource('gitlab', newSigningToken(), { authMode: 'signing_token' });
    h.db.raw
      .prepare('INSERT INTO api_rate_limits(key,window_start,count) VALUES(?,?,?)')
      .run(
        `ingress:endpoint:${src.endpointId}`,
        Math.floor(Date.now() / 60_000) * 60_000,
        ENDPOINT_PREAUTH_LIMIT_PER_MINUTE,
      );
    const body = JSON.stringify(PUSH);
    const signed = await postTo(`/webhooks/gitlab/${src.endpointId}`, body, {
      'x-gitlab-event': 'Push Hook',
      ...gitlabSignHeaders(src.secret, body),
    });
    const unsigned = await postTo(`/webhooks/gitlab/${src.endpointId}`, body, {
      'x-gitlab-event': 'Push Hook',
    });
    for (const res of [signed, unsigned]) {
      expect(res.status).toBe(429);
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    }
  });

  it('counts every request to a live endpoint but never creates counters for dead ones', async () => {
    const src = await createProviderSource('gitlab', newSecretToken(), { authMode: 'secret_token' });
    await postTo(`/webhooks/gitlab/${src.endpointId}`, '{}', { 'x-gitlab-event': 'Push Hook' });
    await postTo(`/webhooks/gitlab/${'C'.repeat(24)}`, '{}', {});
    const keys = (
      h.db.raw.prepare("SELECT key FROM api_rate_limits WHERE key LIKE 'ingress:endpoint:%'").all() as {
        key: string;
      }[]
    ).map((r) => r.key);
    expect(keys).toEqual([`ingress:endpoint:${src.endpointId}`]);
  });

  it('an honest sender within the post-auth limit is never near the coarse one', () => {
    expect(ENDPOINT_PREAUTH_LIMIT_PER_MINUTE).toBeGreaterThan(SOURCE_INGRESS_LIMIT_PER_MINUTE);
  });
});

describe('L3: unreadable event_types deliver nothing', () => {
  it('parses [] as all, a list as a set, anything else as invalid', () => {
    expect(subscribed('[]')).toBeNull();
    expect(subscribed('["push"]')).toEqual(new Set(['push']));
    for (const bad of ['not json', '{"a":1}', '[1]', '"push"', 'null', '', '[null]'])
      expect(subscribed(bad)).toBe('invalid');
  });

  it('a corrupted selection delivers nothing and logs a redacted warning; the others still deliver', async () => {
    const src = await createProviderSource('gitlab', newSigningToken(), { authMode: 'signing_token' });
    const connect = async () =>
      (
        await (
          await call('POST', '/api/integrations', {
            as: 'alice',
            body: { name: 'c', sourceId: src.id, destination: 'slack', webhookUrl: SLACK },
          })
        ).json<{ integration: { id: string } }>()
      ).integration.id;
    const broken = await connect();
    const fine = await connect();
    h.db.raw.prepare("UPDATE integrations SET event_types='{oops' WHERE id=?").run(broken);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const body = JSON.stringify(PUSH);
    const res = await postTo(`/webhooks/gitlab/${src.endpointId}`, body, {
      'x-gitlab-event': 'Push Hook',
      ...gitlabSignHeaders(src.secret, body),
    });
    expect(await res.json()).toEqual({ accepted: true, persisted: 1 });
    const ids = (
      h.db.raw.prepare('SELECT integration_id FROM deliveries').all() as { integration_id: string }[]
    ).map((r) => r.integration_id);
    expect(ids).toEqual([fine]);
    warn.mockRestore();
    stderr.mockRestore();
  });
});

describe('L5: export carries mode columns and still no credential material', () => {
  it('lists auth_mode, livemode and the drop counters, never a secret, key or envelope', async () => {
    const token = newSigningToken();
    await createProviderSource('gitlab', token, { authMode: 'signing_token' });
    const res = await call('GET', '/api/workspace/export', { as: 'alice' });
    const text = await res.text();
    const body = JSON.parse(text) as { sources: Record<string, unknown>[] };
    expect(Object.keys(body.sources[0] ?? {}).sort()).toEqual([
      'auth_mode',
      'created_at',
      'credential_fingerprint',
      'credentials_revoked',
      'dropped_events',
      'enabled',
      'endpoint_id',
      'id',
      'kind',
      'last_dropped_at',
      'last_received_at',
      'livemode',
      'name',
      'secret_rotated_at',
      'updated_at',
    ]);
    expect(body.sources[0]).toMatchObject({ auth_mode: 'signing_token', livemode: null });
    expect(text).not.toContain(token.slice(6));
  });
});

describe('L6: whsec_ secrets are scrubbed from diagnostics', () => {
  it('redacts a signing secret anywhere in free text', () => {
    const secret = 'whsec' + '_' + 'Ab12Cd34Ef56Gh78Ij90+/=';
    const out = scrubString(`failed to verify with ${secret} for source`);
    expect(out).not.toContain('Ab12Cd34');
    expect(out).toContain('[redacted]');
    expect(scrubString('whsec_')).toBe('whsec_');
  });
});

describe('L7: downgrading GitLab from a signing token needs explicit confirmation', () => {
  const rotate = (id: string, body: Record<string, unknown>) =>
    call('POST', `/api/sources/${id}/rotate`, { as: 'alice', body });

  it('refuses signing_token to secret_token without confirmDowngrade, accepts it with', async () => {
    const src = await createProviderSource('gitlab', newSigningToken(), { authMode: 'signing_token' });
    const plain = newSecretToken();
    const refused = await rotate(src.id, { authMode: 'secret_token', secret: plain });
    expect(refused.status).toBe(422);
    expect((await refused.json<{ fields: { field: string }[] }>()).fields.map((f) => f.field)).toEqual([
      'confirmDowngrade',
    ]);
    expect(
      (await rotate(src.id, { authMode: 'secret_token', secret: plain, confirmDowngrade: 'yes' })).status,
    ).toBe(422);
    // Nothing changed: the signing token still verifies.
    const body = JSON.stringify(PUSH);
    const stillSigned = await postTo(`/webhooks/gitlab/${src.endpointId}`, body, {
      'x-gitlab-event': 'Push Hook',
      ...gitlabSignHeaders(src.secret, body),
    });
    expect(stillSigned.status).toBe(202);

    const ok = await rotate(src.id, { authMode: 'secret_token', secret: plain, confirmDowngrade: true });
    expect(ok.status).toBe(200);
    expect((await ok.json<{ source: { authMode: string } }>()).source.authMode).toBe('secret_token');
    const audit = h.db.raw
      .prepare("SELECT metadata_json FROM audit_events WHERE action='source.secret.rotate'")
      .get() as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toMatchObject({ downgrade: true });
    expect(audit.metadata_json).not.toContain(plain);
  });

  it('upgrades and same-mode rotations need no confirmation', async () => {
    const src = await createProviderSource('gitlab', newSecretToken(), { authMode: 'secret_token' });
    expect((await rotate(src.id, { authMode: 'secret_token', secret: newSecretToken() })).status).toBe(200);
    expect((await rotate(src.id, { authMode: 'signing_token', secret: newSigningToken() })).status).toBe(200);
    expect((await rotate(src.id, { authMode: 'signing_token', secret: newSigningToken() })).status).toBe(200);
  });
});
