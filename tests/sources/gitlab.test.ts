import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GITLAB_EVENT_TYPES } from '../../src/connectors/sources/gitlab/catalog';
import { mapGitlab } from '../../src/connectors/sources/gitlab/map';
import { verifyGitlab } from '../../src/connectors/sources/gitlab/verify';
import { SOURCE_INGRESS_LIMIT_PER_MINUTE } from '../../src/security/rate-limit';
import { constantTimeEqual } from '../../src/lib/timing';
import type { DeliveryMessage } from '../../src/env';
import { SLACK, setup, type Harness } from './harness';
import { ISSUE, MERGE_REQUEST, PIPELINE, PIPELINE_FAILED, PUSH } from './fixtures/gitlab';
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

const NOW = 1_800_000_000;
const headersOf = (event: string, extra: Record<string, string> = {}) =>
  new Headers({ 'x-gitlab-event': event, ...extra });
const map = (event: string, body: unknown, extra: Record<string, string> = {}) =>
  mapGitlab({ headers: headersOf(event, extra), body, source: { livemode: null } });

describe('constantTimeEqual', () => {
  it('is true only for equal strings, whatever their lengths', async () => {
    expect(await constantTimeEqual('abc', 'abc')).toBe(true);
    expect(await constantTimeEqual('abc', 'abd')).toBe(false);
    expect(await constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(await constantTimeEqual('', '')).toBe(true);
    expect(await constantTimeEqual('', 'x')).toBe(false);
  });
});

describe('verification: signing token (Standard Webhooks, shared core)', () => {
  const token = newSigningToken();
  const body = JSON.stringify(PUSH);
  const verify = (headers: Record<string, string>, raw = body, now = NOW, secret = token) =>
    verifyGitlab({
      secret,
      authMode: 'signing_token',
      headers: new Headers(headers),
      raw: new TextEncoder().encode(raw),
      nowSeconds: now,
    });

  it('accepts a valid signature and returns the signed webhook-id as the event id', async () => {
    const headers = gitlabSignHeaders(token, body, { id: 'msg_1', ts: NOW });
    expect(await verify(headers)).toEqual({ ok: true, eventId: 'msg_1' });
  });

  it('base64-decodes the whsec_ token before the HMAC (a key built from the raw text fails)', async () => {
    const { createHmac } = await import('node:crypto');
    const mac = createHmac('sha256', token).update(`msg_2.${NOW}.${body}`).digest('base64');
    const wrong = {
      'webhook-id': 'msg_2',
      'webhook-timestamp': String(NOW),
      'webhook-signature': `v1,${mac}`,
    };
    expect((await verify(wrong)).ok).toBe(false);
  });

  it('rejects tamper, a wrong token, stale and malformed requests', async () => {
    const headers = gitlabSignHeaders(token, body, { id: 'msg_3', ts: NOW });
    expect((await verify(headers, body + ' ')).ok).toBe(false);
    expect((await verify(headers, body, NOW, newSigningToken())).ok).toBe(false);
    expect(await verify(headers, body, NOW + 301)).toEqual({ ok: false, reason: 'stale' });
    expect((await verify({})).ok).toBe(false);
  });

  it('never falls back to X-Gitlab-Token when no signature is present, nor rescues a bad signature', async () => {
    const good = gitlabSignHeaders(token, body, { id: 'msg_4', ts: NOW });
    const noSignature = { 'x-gitlab-token': token };
    expect((await verify(noSignature)).ok).toBe(false);
    expect((await verify({ ...good, 'webhook-signature': 'v1,AAAA', 'x-gitlab-token': token })).ok).toBe(
      false,
    );
  });
});

describe('verification: secret token (X-Gitlab-Token)', () => {
  const secret = newSecretToken();
  const verify = (headers: Record<string, string>) =>
    verifyGitlab({
      secret,
      authMode: 'secret_token',
      headers: new Headers(headers),
      raw: new TextEncoder().encode('{}'),
      nowSeconds: NOW,
    });

  it('accepts the exact token and uses Idempotency-Key as the corroborating id', async () => {
    expect(await verify({ 'x-gitlab-token': secret, 'idempotency-key': 'abc-123' })).toEqual({
      ok: true,
      eventId: 'abc-123',
    });
    expect(await verify({ 'x-gitlab-token': secret })).toEqual({ ok: true, eventId: null });
  });

  it('rejects a missing, empty, wrong or near-miss token', async () => {
    for (const headers of [
      {} as Record<string, string>,
      { 'x-gitlab-token': '' },
      { 'x-gitlab-token': secret + 'x' },
      { 'x-gitlab-token': secret.slice(1) },
    ])
      expect((await verify(headers)).ok).toBe(false);
  });

  it('does not accept a Standard Webhooks signature in place of the token', async () => {
    const headers = gitlabSignHeaders(newSigningToken(), '{}', { id: 'm', ts: NOW });
    expect((await verify(headers)).ok).toBe(false);
  });
});

describe('mapping the documented payloads', () => {
  it('push: branch, newest commit, count, handle only (no email)', () => {
    const r = map('Push Hook', PUSH);
    expect(r).toMatchObject({
      outcome: 'deliver',
      display: {
        eventType: 'push',
        title: 'Push to master',
        status: 'info',
        repo: 'mike/diaspora',
        actor: 'jsmith',
        url: 'https://gitlab.com/mike/diaspora/commit/da1560886d4f094c3e6c9ef40349f7d38b5d27d7',
        summary: '4 commits · fixed readme',
      },
    });
    expect(JSON.stringify(r)).not.toContain('john@example.com');
  });

  it('push: a deleted branch and a push with no commits', () => {
    const zero = '0'.repeat(40);
    expect(map('Push Hook', { ...PUSH, after: zero, commits: [], total_commits_count: 0 })).toMatchObject({
      display: { title: 'Branch master deleted', status: 'warning' },
    });
    const empty = map('Push Hook', { ...PUSH, commits: [], total_commits_count: 0 });
    expect(empty).toMatchObject({ outcome: 'deliver', display: { title: 'Push to master' } });
  });

  it('tag push', () => {
    const r = map('Tag Push Hook', { ...PUSH, object_kind: 'tag_push', ref: 'refs/tags/v1.2.0' });
    expect(r).toMatchObject({ display: { eventType: 'tag_push', title: 'Tag v1.2.0 pushed' } });
  });

  it('merge request: open, with the action taken from the body', () => {
    expect(map('Merge Request Hook', MERGE_REQUEST)).toMatchObject({
      outcome: 'deliver',
      display: {
        eventType: 'merge_request.opened',
        title: '!16 opened: Add input validation to booking form',
        url: 'https://gitlab.com/flightjs/flight-management/-/merge_requests/16',
        repo: 'flightjs/flight-management',
        actor: 'agarcia',
        summary: 'feature/booking-validation → main',
      },
    });
  });

  it.each([
    ['merge', 'merge_request.merged', 'success'],
    ['close', 'merge_request.closed', 'warning'],
    ['reopen', 'merge_request.reopened', 'info'],
  ])('merge request action %s', (action, eventType, status) => {
    const body = { ...MERGE_REQUEST, object_attributes: { ...MERGE_REQUEST.object_attributes, action } };
    expect(map('Merge Request Hook', body)).toMatchObject({ display: { eventType, status } });
  });

  it.each(['update', 'approval', 'approved', 'unapproval', 'unapproved', 'bogus'])(
    'merge request action %s is acknowledged and ignored',
    (action) => {
      const body = { ...MERGE_REQUEST, object_attributes: { ...MERGE_REQUEST.object_attributes, action } };
      expect(map('Merge Request Hook', body)).toEqual({ outcome: 'ignore', reason: 'action_not_notified' });
    },
  );

  it('issue: opened with labels; confidential issues never copy the title', () => {
    expect(map('Issue Hook', ISSUE)).toMatchObject({
      display: {
        eventType: 'issue.opened',
        title: 'Issue #23 opened: New API: create/update/delete file',
        summary: 'Labels: API',
      },
    });
    const secret = { ...ISSUE, object_attributes: { ...ISSUE.object_attributes, confidential: true } };
    const r = map('Issue Hook', secret);
    expect(r).toMatchObject({ display: { title: 'Confidential issue #23 opened' } });
    expect(JSON.stringify(r)).not.toContain('New API');
  });

  it('pipeline: success and failure (failed job names listed), other statuses ignored', () => {
    expect(map('Pipeline Hook', PIPELINE)).toMatchObject({
      display: {
        eventType: 'pipeline.succeeded',
        title: 'Pipeline succeeded on master',
        status: 'success',
        summary: 'test · 63s',
      },
    });
    expect(map('Pipeline Hook', PIPELINE_FAILED)).toMatchObject({
      display: {
        eventType: 'pipeline.failed',
        status: 'failure',
        summary: 'test · Failed: test-image · 63s',
      },
    });
    const running = { ...PIPELINE, object_attributes: { ...PIPELINE.object_attributes, status: 'running' } };
    expect(map('Pipeline Hook', running)).toEqual({ outcome: 'ignore', reason: 'action_not_notified' });
  });

  it('every delivered event type is in the closed catalogue', () => {
    const seen = new Set<string>();
    const cases: [string, unknown][] = [
      ['Push Hook', PUSH],
      ['Tag Push Hook', { ...PUSH, ref: 'refs/tags/v1' }],
      ['Merge Request Hook', MERGE_REQUEST],
      ['Issue Hook', ISSUE],
      ['Pipeline Hook', PIPELINE],
      ['Pipeline Hook', PIPELINE_FAILED],
    ];
    for (const [event, body] of cases) {
      const r = map(event, body);
      if (r.outcome === 'deliver' && r.display.eventType) seen.add(r.display.eventType);
    }
    for (const t of seen) expect(GITLAB_EVENT_TYPES).toContain(t);
  });

  it('is deterministic', () => {
    expect(map('Push Hook', PUSH)).toEqual(map('Push Hook', PUSH));
  });

  it('sanitises untrusted text and drops non-https links', () => {
    const body = {
      ...MERGE_REQUEST,
      object_attributes: {
        ...MERGE_REQUEST.object_attributes,
        title: 'a\u0000b‮c\nd',
        url: 'javascript:alert(1)',
      },
    };
    const r = map('Merge Request Hook', body);
    expect(r).toMatchObject({ display: { title: '!16 opened: a b c d', url: '' } });
    expect(JSON.stringify(r)).not.toContain('‮');
  });

  it('bounds every field', () => {
    const body = {
      ...PIPELINE_FAILED,
      builds: Array.from({ length: 50 }, (_, i) => ({
        name: `job-${i}-${'x'.repeat(100)}`,
        status: 'failed',
      })),
      commit: { title: 'y'.repeat(5000) },
    };
    const r = map('Pipeline Hook', body);
    expect(r.outcome).toBe('deliver');
    if (r.outcome === 'deliver') expect((r.display.summary ?? '').length).toBeLessThanOrEqual(280);
  });

  it('missing event header is a 400, an unknown event is ignored, a non-GitLab.com instance is refused', () => {
    expect(mapGitlab({ headers: new Headers(), body: PUSH, source: { livemode: null } })).toMatchObject({
      outcome: 'reject',
      status: 400,
    });
    expect(map('Wiki Page Hook', {})).toEqual({ outcome: 'ignore', reason: 'event_not_supported' });
    expect(map('constructor', {})).toEqual({ outcome: 'ignore', reason: 'event_not_supported' });
    expect(map('Push Hook', PUSH, { 'x-gitlab-instance': 'gitlab.example.org' })).toMatchObject({
      outcome: 'reject',
      status: 401,
    });
    expect(map('Push Hook', PUSH, { 'x-gitlab-instance': 'GitLab.com' }).outcome).toBe('deliver');
  });
});

describe('ingress end to end', () => {
  async function connect(src: ProviderSource, eventTypes?: string[], as = 'alice'): Promise<string> {
    const res = await call('POST', '/api/integrations', {
      as,
      body: {
        name: 'to slack',
        sourceId: src.id,
        destination: 'slack',
        webhookUrl: SLACK,
        ...(eventTypes ? { eventTypes } : {}),
      },
    });
    expect(res.status).toBe(201);
    return (await res.json<{ integration: { id: string } }>()).integration.id;
  }
  const outbox = () =>
    (
      h.db.raw.prepare('SELECT payload_json FROM notification_outbox ORDER BY rowid').all() as {
        payload_json: string;
      }[]
    ).map((r) => JSON.parse(r.payload_json) as DeliveryMessage);
  const count = (table: string, where = '1=1') =>
    (h.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;

  const signedPost = (
    src: ProviderSource,
    event: string,
    payload: unknown,
    opts: { id?: string; ts?: number } = {},
  ) => {
    const body = JSON.stringify(payload);
    return postTo(`/webhooks/gitlab/${src.endpointId}`, body, {
      'x-gitlab-event': event,
      ...gitlabSignHeaders(src.secret, body, opts),
    });
  };

  it('signing-token source: verifies, persists, acknowledges with 202 and renders the canonical message', async () => {
    const src = await createProviderSource('gitlab', newSigningToken(), { authMode: 'signing_token' });
    expect(src.endpointUrl).toBe(`https://noti.test/webhooks/gitlab/${src.endpointId}`);
    const integration = await connect(src);
    const res = await signedPost(src, 'Pipeline Hook', PIPELINE_FAILED);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, persisted: 1 });
    expect(outbox()).toEqual([
      expect.objectContaining({
        integrationId: integration,
        organizationId: 'org-a',
        eventType: 'pipeline.failed',
        status: 'failure',
        repo: 'gitlab-org/gitlab-test',
        actor: 'root',
      }),
    ]);
    const touched = h.db.raw.prepare('SELECT last_received_at FROM sources WHERE id=?').get(src.id) as {
      last_received_at: string | null;
    };
    expect(touched.last_received_at).not.toBeNull();
  });

  it('secret-token source works with X-Gitlab-Token and rejects a wrong one', async () => {
    const src = await createProviderSource('gitlab', newSecretToken(), { authMode: 'secret_token' });
    await connect(src);
    const body = JSON.stringify(PUSH);
    const ok = await postTo(`/webhooks/gitlab/${src.endpointId}`, body, {
      'x-gitlab-event': 'Push Hook',
      'x-gitlab-token': src.secret,
      'idempotency-key': 'idem-1',
    });
    expect(ok.status).toBe(202);
    const bad = await postTo(`/webhooks/gitlab/${src.endpointId}`, body, {
      'x-gitlab-event': 'Push Hook',
      'x-gitlab-token': src.secret + 'x',
    });
    expect(bad.status).toBe(401);
    expect(count('deliveries')).toBe(1);
  });

  it('a signing-token source refuses a request that only carries the token', async () => {
    const src = await createProviderSource('gitlab', newSigningToken(), { authMode: 'signing_token' });
    await connect(src);
    const res = await postTo(`/webhooks/gitlab/${src.endpointId}`, JSON.stringify(PUSH), {
      'x-gitlab-event': 'Push Hook',
      'x-gitlab-token': src.secret,
    });
    expect(res.status).toBe(401);
    expect(count('deliveries')).toBe(0);
  });

  it('tamper, stale timestamp, wrong content type and oversize are refused before any routing', async () => {
    const src = await createProviderSource('gitlab', newSigningToken(), { authMode: 'signing_token' });
    await connect(src);
    const body = JSON.stringify(PUSH);
    const headers = { 'x-gitlab-event': 'Push Hook', ...gitlabSignHeaders(src.secret, body) };
    expect((await postTo(`/webhooks/gitlab/${src.endpointId}`, body + ' ', headers)).status).toBe(401);
    const stale = {
      'x-gitlab-event': 'Push Hook',
      ...gitlabSignHeaders(src.secret, body, { ts: Math.floor(Date.now() / 1000) - 3600 }),
    };
    expect((await postTo(`/webhooks/gitlab/${src.endpointId}`, body, stale)).status).toBe(401);
    expect((await postTo(`/webhooks/gitlab/${src.endpointId}`, body, headers, 'text/plain')).status).toBe(
      415,
    );
    const big = 'x'.repeat(1024 * 1024 + 1);
    expect((await postTo(`/webhooks/gitlab/${src.endpointId}`, big, headers)).status).toBe(413);
    expect(count('deliveries')).toBe(0);
  });

  it('a retry with the same webhook-id is a duplicate, not a second delivery', async () => {
    const src = await createProviderSource('gitlab', newSigningToken(), { authMode: 'signing_token' });
    await connect(src);
    expect((await signedPost(src, 'Push Hook', PUSH, { id: 'msg_retry' })).status).toBe(202);
    const again = await signedPost(src, 'Push Hook', PUSH, { id: 'msg_retry' });
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ accepted: true, persisted: 0, duplicate: true });
    expect(count('deliveries', "state != 'suppressed'")).toBe(1);
    expect(count('deliveries', "state = 'suppressed'")).toBe(1);
    expect(count('notification_outbox')).toBe(1);
  });

  it('the event UUID is not identity: two events with different webhook-ids both deliver', async () => {
    const src = await createProviderSource('gitlab', newSigningToken(), { authMode: 'signing_token' });
    await connect(src);
    const body = JSON.stringify(PUSH);
    for (const id of ['m1', 'm2']) {
      const res = await postTo(`/webhooks/gitlab/${src.endpointId}`, body, {
        'x-gitlab-event': 'Push Hook',
        'x-gitlab-event-uuid': 'same-uuid-for-recursive-hooks',
        ...gitlabSignHeaders(src.secret, body, { id }),
      });
      expect(res.status).toBe(202);
    }
    expect(count('deliveries')).toBe(2);
  });

  it('an unsupported event is acknowledged with 200 and routes nothing; a wrong instance is 401', async () => {
    const src = await createProviderSource('gitlab', newSigningToken(), { authMode: 'signing_token' });
    await connect(src);
    const wiki = await signedPost(src, 'Wiki Page Hook', { object_kind: 'wiki_page' });
    expect(wiki.status).toBe(200);
    expect(await wiki.json()).toEqual({ accepted: true, ignored: 'event_not_supported' });
    const body = JSON.stringify(PUSH);
    const selfManaged = await postTo(`/webhooks/gitlab/${src.endpointId}`, body, {
      'x-gitlab-event': 'Push Hook',
      'x-gitlab-instance': 'gitlab.internal.example',
      ...gitlabSignHeaders(src.secret, body),
    });
    expect(selfManaged.status).toBe(401);
    expect(count('deliveries')).toBe(0);
  });

  it('integrations select event types from the GitLab catalogue; empty means all', async () => {
    const src = await createProviderSource('gitlab', newSigningToken(), { authMode: 'signing_token' });
    const onlyPipelines = await connect(src, ['pipeline.failed']);
    const everything = await connect(src);
    const push = await signedPost(src, 'Push Hook', PUSH);
    expect(await push.json()).toEqual({ accepted: true, persisted: 1 });
    const failed = await signedPost(src, 'Pipeline Hook', PIPELINE_FAILED);
    expect(await failed.json()).toEqual({ accepted: true, persisted: 2 });
    const byIntegration = outbox().map((m) => [m.integrationId, m.eventType]);
    expect(byIntegration).toEqual(
      expect.arrayContaining([
        [everything, 'push'],
        [everything, 'pipeline.failed'],
        [onlyPipelines, 'pipeline.failed'],
      ]),
    );
    expect(byIntegration).toHaveLength(3);
  });

  it('unknown, disabled and wrong-kind endpoints are one identical 404', async () => {
    const src = await createProviderSource('gitlab', newSigningToken(), { authMode: 'signing_token' });
    const body = JSON.stringify(PUSH);
    const headers = { 'x-gitlab-event': 'Push Hook', ...gitlabSignHeaders(src.secret, body) };
    await call('PATCH', `/api/sources/${src.id}`, { as: 'alice', body: { enabled: false } });
    const disabled = await postTo(`/webhooks/gitlab/${src.endpointId}`, body, headers);
    const unknown = await postTo(`/webhooks/gitlab/${'A'.repeat(24)}`, body, headers);
    const malformed = await postTo('/webhooks/gitlab/short', body, headers);
    const wrongKind = await postTo(`/webhooks/stripe/${src.endpointId}`, body, headers);
    for (const r of [disabled, unknown, malformed, wrongKind]) expect(r.status).toBe(404);
    expect(
      new Set(await Promise.all([disabled, unknown, malformed, wrongKind].map((r) => r.text()))),
    ).toEqual(new Set(['Not found']));
  });

  it('never delivers one workspace’s event to another workspace', async () => {
    const a = await createProviderSource('gitlab', newSigningToken(), { authMode: 'signing_token' }, 'alice');
    const b = await createProviderSource(
      'gitlab',
      newSigningToken(),
      { authMode: 'signing_token' },
      'mallory',
    );
    const intoB = await connect(b, undefined, 'mallory');
    // Signed with A's secret but sent to B's endpoint: refused, and nothing reaches B's chat.
    const body = JSON.stringify(PUSH);
    const res = await postTo(`/webhooks/gitlab/${b.endpointId}`, body, {
      'x-gitlab-event': 'Push Hook',
      ...gitlabSignHeaders(a.secret, body),
    });
    expect(res.status).toBe(401);
    expect(count('deliveries')).toBe(0);
    // A's own event with no chat connected creates nothing for B.
    expect((await signedPost(a, 'Push Hook', PUSH)).status).toBe(202);
    expect(count('deliveries')).toBe(0);
    expect(intoB).toBeTruthy();
  });

  it('absorbs a flood with a 2xx instead of a 4xx (GitLab disables webhooks after repeated failures)', async () => {
    const src = await createProviderSource('gitlab', newSigningToken(), { authMode: 'signing_token' });
    await connect(src);
    const window = Math.floor(Date.now() / 60_000);
    h.db.raw
      .prepare('INSERT INTO api_rate_limits(key,window_start,count) VALUES(?,?,?)')
      .run(`ingress:source:${src.id}`, window * 60_000, SOURCE_INGRESS_LIMIT_PER_MINUTE);
    const res = await signedPost(src, 'Push Hook', PUSH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: false, dropped: 'rate_limited' });
    expect(count('deliveries')).toBe(0);
  });

  it('flood limiting happens only after authentication', async () => {
    const src = await createProviderSource('gitlab', newSigningToken(), { authMode: 'signing_token' });
    for (let i = 0; i < 3; i++)
      expect(
        (await postTo(`/webhooks/gitlab/${src.endpointId}`, '{}', { 'x-gitlab-event': 'Push Hook' })).status,
      ).toBe(401);
    const used = h.db.raw
      .prepare('SELECT COUNT(*) AS n FROM api_rate_limits WHERE key=?')
      .get(`ingress:source:${src.id}`) as { n: number };
    expect(used.n).toBe(0);
  });

  it('a verified body that is not JSON is a 400, only after verification', async () => {
    const src = await createProviderSource('gitlab', newSigningToken(), { authMode: 'signing_token' });
    const raw = 'not json';
    const res = await postTo(`/webhooks/gitlab/${src.endpointId}`, raw, {
      'x-gitlab-event': 'Push Hook',
      ...gitlabSignHeaders(src.secret, raw),
    });
    expect(res.status).toBe(400);
  });
});
