import { beforeEach, afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Bindings, DeliveryMessage } from '../../src/env';
import { TEST_SUMMARY, TEST_TITLE } from '../../src/api/test-send';
import { serializeFilters } from '../../src/routing/filter-input';
import { DEFAULT_NOISE, serializeNoise } from '../../src/routing/noise';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';
import { generateSigningSecret } from '../../src/connectors/sources/generic/encoding';
import { legacySeal } from '../support/legacy';

/**
 * "Send a test notification" (ADR 0018) over the real migrations, the real Worker routes, the
 * real outbox dispatcher and the real queue consumer. Only Better Auth's session lookup and the
 * provider `fetch` are replaced. Every URL and response below is a fixture.
 */
vi.mock('../../src/auth/better-auth', () => ({
  createAuth: () => ({
    api: {
      getSession: ({ headers }: { headers: Headers }) => {
        const id = headers.get('x-test-user');
        return Promise.resolve(
          id
            ? {
                user: { id, email: `${id}@example.test`, emailVerified: true, name: id },
                session: { activeOrganizationId: headers.get('x-test-active-org') },
              }
            : null,
        );
      },
    },
    handler: () => new Response(null, { status: 404 }),
  }),
}));

const { default: worker } = await import('../../src/index');

const ORIGIN = 'https://noti.test';
const K_LEGACY = 'aa'.repeat(32);
const URLS = {
  lark: 'https://open.larksuite.com/open-apis/bot/v2/hook/test-fixture',
  slack: 'https://hooks.slack.com/services/T000/B000/TestFixtureToken',
  teams:
    'https://prod-12.westus.logic.azure.com/workflows/abc123/triggers/manual/paths/invoke?sig=TestFixtureSig',
  discord: 'https://discord.com/api/webhooks/123456789012345678/TestFixtureToken',
} as const;
type Kind = keyof typeof URLS;

const ok: Record<Kind, () => Response> = {
  lark: () => new Response(JSON.stringify({ code: 0 }), { status: 200 }),
  slack: () => new Response('ok', { status: 200 }),
  teams: () => new Response(null, { status: 202 }),
  discord: () => new Response('{"id":"1"}', { status: 200 }),
};

let db: FakeD1;
let env: Bindings;
let queued: DeliveryMessage[];
let fetchMock: Mock<typeof fetch>;

function user(id: string): void {
  db.raw
    .prepare('INSERT INTO "user"(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(id, id, `${id}@example.test`, 1, 1, 1);
}

function member(userId: string, org: string, role: 'admin' | 'member'): void {
  db.raw
    .prepare('INSERT INTO "member"(id,user_id,organization_id,role,created_at) VALUES(?,?,?,?,?)')
    .run(`${userId}-${org}`, userId, org, role, 1);
}

async function integration(
  id: string,
  kind: Kind,
  options: { org?: string; enabled?: number; quarantined?: boolean; filters?: string; noise?: string } = {},
): Promise<void> {
  db.raw
    .prepare(
      `INSERT INTO integrations(id,organization_id,repo,event_types,destination,destination_host,webhook_ciphertext,
         enabled,credentials_quarantined_at,filters_json,noise_json)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      options.org ?? 'org-a',
      'acme/web',
      '["workflow_run.failure"]',
      kind,
      new URL(URLS[kind]).hostname,
      await legacySeal(URLS[kind], K_LEGACY),
      options.enabled ?? 1,
      options.quarantined ? '2026-10-01 00:00:00' : null,
      options.filters ?? null,
      options.noise ?? null,
    );
}

async function post(
  id: string,
  options: { as?: string; origin?: string | null; contentType?: string | null; org?: string } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.contentType !== null) headers.set('content-type', options.contentType ?? 'application/json');
  const as = 'as' in options ? options.as : 'bob';
  if (as) headers.set('x-test-user', as);
  if (options.org) headers.set('x-test-active-org', options.org);
  if (options.origin !== null) headers.set('origin', options.origin ?? ORIGIN);
  const waits: Promise<unknown>[] = [];
  const res = await worker.fetch(
    new Request(`${ORIGIN}/api/integrations/${id}/test`, { method: 'POST', headers, body: '{}' }),
    env,
    {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext,
  );
  await Promise.all(waits);
  return res;
}

/** The first provider call: its address and its body, as strings. */
const callUrl = (): string => {
  const [url] = fetchMock.mock.calls[0] ?? [];
  return typeof url === 'string' ? url : url instanceof URL ? url.href : (url?.url ?? '');
};
const callBody = (): string => {
  const body = fetchMock.mock.calls[0]?.[1]?.body;
  return typeof body === 'string' ? body : '';
};

async function json<T>(res: Response): Promise<T> {
  return await res.json();
}

async function get(path: string, as = 'bob'): Promise<Response> {
  return worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { 'x-test-user': as } }), env, {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext);
}

interface FakeMessage {
  body: unknown;
  attempts: number;
  acked: boolean;
  retried: { delaySeconds?: number } | null;
  ack(): void;
  retry(o?: { delaySeconds?: number }): void;
}

/** Hand every queued message to the real consumer, as the queue would. */
async function consumeQueued(attempts = 1): Promise<FakeMessage[]> {
  const messages: FakeMessage[] = queued.splice(0).map((body): FakeMessage => ({
    body,
    attempts,
    acked: false,
    retried: null,
    ack() {
      this.acked = true;
    },
    retry(o = {}) {
      this.retried = o;
    },
  }));
  await worker.queue({ messages, retryAll: () => undefined } as unknown as MessageBatch<unknown>, env);
  return messages;
}

async function sendTest(id: string, as = 'bob'): Promise<string> {
  const res = await post(id, { as });
  expect(res.status).toBe(202);
  return (await json<{ deliveryId: string }>(res)).deliveryId;
}

interface DeliveryBody {
  delivery: {
    id: string;
    state: string;
    isTest: boolean;
    error: { code: string; messageKey: string | null; retryable: boolean } | null;
    integration: { destination: string | null };
  };
}

async function view(id: string): Promise<DeliveryBody['delivery']> {
  const res = await get(`/api/deliveries/${id}`);
  expect(res.status).toBe(200);
  return (await json<DeliveryBody>(res)).delivery;
}

const rows = (sql: string, ...args: string[]) =>
  db.raw.prepare(sql).all(...args) as Record<string, unknown>[];
const count = (table: string): number =>
  (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(async () => {
  db = createFakeD1();
  queued = [];
  seedOrganization(db.raw, 'org-a');
  seedOrganization(db.raw, 'org-b');
  for (const id of ['alice', 'bob', 'mallory']) user(id);
  member('alice', 'org-a', 'admin');
  member('bob', 'org-a', 'member');
  member('mallory', 'org-b', 'admin');
  env = {
    DB: db.d1,
    DELIVERY_QUEUE: {
      send: (m: DeliveryMessage) => {
        queued.push(m);
        return Promise.resolve();
      },
    } as unknown as Queue<DeliveryMessage>,
    APP_ORIGIN: ORIGIN,
    GITHUB_WEBHOOK_SECRET: 'unused',
    GITHUB_APP_ID: '777',
    ENCRYPTION_KEY: K_LEGACY,
    KEK_V1: '11'.repeat(32),
    KEK_V2: '',
    KMS_ACTIVE_VERSION: '1',
    ENVIRONMENT_NAME: 'staging',
    KEK_CHECK_V1: '4464ea2121d3a99ebd188370f1ef6cd0',
    GENERIC_WEBHOOK_ENABLED: 'true',
  } as Bindings;
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  await integration('int-lark', 'lark');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/integrations/:id/test: access control', () => {
  it('requires a session', async () => {
    expect((await post('int-lark', { as: '' })).status).toBe(401);
    expect(count('deliveries')).toBe(0);
  });

  it('a member may test (integration.update); the response carries only the delivery id', async () => {
    const res = await post('int-lark', { as: 'bob' });
    expect(res.status).toBe(202);
    const text = await res.text();
    expect(Object.keys(JSON.parse(text) as object)).toEqual(['deliveryId']);
    expect(text).not.toMatch(/https?:|hook|secret|token/i);
  });

  it('another workspace’s integration is a 404, indistinguishable from a missing one, and burns no budget', async () => {
    const other = await post('int-lark', { as: 'mallory' });
    const missing = await post('nope', { as: 'mallory' });
    expect(other.status).toBe(404);
    expect(await other.text()).toBe(await missing.text());
    expect(count('deliveries')).toBe(0);
    expect(count('notification_outbox')).toBe(0);
    expect(rows("SELECT key FROM api_rate_limits WHERE key LIKE 'test-send:%'")).toEqual([]);
  });

  it('refuses a cross-site request (Origin) and a non-JSON body (CSRF, F23)', async () => {
    expect((await post('int-lark', { origin: 'https://evil.test' })).status).toBe(403);
    expect((await post('int-lark', { origin: null })).status).toBe(403);
    expect((await post('int-lark', { contentType: 'text/plain' })).status).toBe(415);
    expect(count('deliveries')).toBe(0);
  });

  it('refuses while the workspace is scheduled for deletion', async () => {
    db.raw
      .prepare(
        "INSERT INTO workspace_deletions(organization_id,requested_by,purge_after) VALUES('org-a','alice',9999999999999)",
      )
      .run();
    const res = await post('int-lark');
    expect(res.status).toBe(409);
    expect((await json<{ reason: string }>(res)).reason).toBe('deletion_pending');
    expect(count('deliveries')).toBe(0);
  });

  it('refuses a paused integration', async () => {
    await integration('int-off', 'slack', { enabled: 0 });
    const res = await post('int-off');
    expect(res.status).toBe(409);
    expect((await json<{ reason: string }>(res)).reason).toBe('disabled');
    expect(count('deliveries')).toBe(0);
  });

  it('refuses an integration whose credentials are quarantined', async () => {
    await integration('int-q', 'slack', { quarantined: true });
    const res = await post('int-q');
    expect(res.status).toBe(409);
    expect((await json<{ reason: string }>(res)).reason).toBe('quarantined');
    expect(count('deliveries')).toBe(0);
  });
});

/** Finish every test so the in-flight guard does not mask the limit under test. */
const settle = (): void => {
  db.raw.prepare("UPDATE deliveries SET state='sent' WHERE is_test=1").run();
};

describe('rate limits', () => {
  it('5 per integration per minute, then 429 with Retry-After; nothing more is queued', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await post('int-lark')).status).toBe(202);
      settle();
    }
    const res = await post('int-lark');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect((await json<{ reason: string }>(res)).reason).toBe('rate_limited');
    expect(count('deliveries')).toBe(5);
  });

  /** Each integration gets its own host, so only the limit under test can fire. */
  async function distinctHosts(n: number, org = 'org-a'): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = `h-${org}-${i}`;
      await integration(id, 'slack', { org });
      db.raw
        .prepare('UPDATE integrations SET destination_host=? WHERE id=?')
        .run(`host-${org}-${i}.test`, id);
      ids.push(id);
    }
    return ids;
  }

  it('20 per user per minute across integrations', async () => {
    const ids = await distinctHosts(20);
    for (const id of ids) {
      expect((await post(id)).status).toBe(202);
      settle();
    }
    await integration('extra', 'slack');
    db.raw.prepare("UPDATE integrations SET destination_host='extra.test' WHERE id='extra'").run();
    expect((await post('extra')).status).toBe(429);
    // Another user is unaffected.
    expect((await post('extra', { as: 'alice' })).status).toBe(202);
  });

  it('30 per workspace per minute, however many members and integrations', async () => {
    const ids = await distinctHosts(31);
    for (const [i, id] of ids.slice(0, 30).entries()) {
      expect((await post(id, { as: i % 2 ? 'alice' : 'bob' })).status).toBe(202);
      settle();
    }
    const res = await post(ids[30] ?? '', { as: 'alice' });
    expect(res.status).toBe(429);
    expect(count('deliveries')).toBe(30);
  });

  it('10 per destination host per minute across ALL workspaces', async () => {
    for (let i = 0; i < 5; i++) await integration(`a-${i}`, 'slack');
    for (let i = 0; i < 5; i++) await integration(`b-${i}`, 'slack', { org: 'org-b' });
    // Same host (hooks.slack.com) in two tenants.
    for (let i = 0; i < 5; i++) {
      expect((await post(`a-${i}`)).status).toBe(202);
      expect((await post(`b-${i}`, { as: 'mallory' })).status).toBe(202);
      settle();
    }
    await integration('a-extra', 'slack');
    const res = await post('a-extra');
    expect(res.status).toBe(429);
    expect((await post('b-0', { as: 'mallory' })).status).toBe(429);
    // A different host is unaffected.
    expect((await post('int-lark')).status).toBe(202);
  });
});

describe('in-flight guard', () => {
  it('a second click while a test is pending is refused (409 test_in_flight) and spends no budget', async () => {
    expect((await post('int-lark')).status).toBe(202);
    const res = await post('int-lark');
    expect(res.status).toBe(409);
    expect((await json<{ reason: string }>(res)).reason).toBe('test_in_flight');
    expect(count('deliveries')).toBe(1);
    const budget = rows("SELECT count FROM api_rate_limits WHERE key LIKE 'test-send:integration:%'");
    expect(budget).toEqual([{ count: 1 }]);
  });

  it.each(['claimed', 'retrying'])('still blocks while the test is %s', async (state) => {
    await post('int-lark');
    db.raw.prepare('UPDATE deliveries SET state=? WHERE is_test=1').run(state);
    expect((await post('int-lark')).status).toBe(409);
  });

  it('a finished test does not block, and neither does a stale one (retries cannot stack forever)', async () => {
    await post('int-lark');
    settle();
    expect((await post('int-lark')).status).toBe(202);
    db.raw.prepare("UPDATE deliveries SET state='retrying', created_at='2020-01-01 00:00:00'").run();
    expect((await post('int-lark')).status).toBe(202);
  });

  it('is atomic in the insert: a test that appears after the read still wins', async () => {
    const real = db.d1.batch.bind(db.d1);
    vi.spyOn(db.d1, 'batch').mockImplementationOnce((statements) => {
      db.raw
        .prepare(
          "INSERT INTO deliveries(id,integration_id,organization_id,state,is_test,created_at) VALUES('race','int-lark','org-a','pending',1,CURRENT_TIMESTAMP)",
        )
        .run();
      return real(statements);
    });
    const res = await post('int-lark');
    expect(res.status).toBe(409);
    expect((await json<{ reason: string }>(res)).reason).toBe('test_in_flight');
    expect(count('deliveries')).toBe(1);
    expect(count('notification_outbox')).toBe(0);
  });

  it('is per integration: another integration can be tested meanwhile', async () => {
    await integration('other', 'lark');
    db.raw.prepare("UPDATE integrations SET destination_host='other.test' WHERE id='other'").run();
    await post('int-lark');
    expect((await post('other')).status).toBe(202);
  });
});

describe('a test to a custom webhook reveals only three buckets', () => {
  async function genericIntegration(): Promise<void> {
    db.raw
      .prepare(
        `INSERT INTO integrations(id,organization_id,repo,event_types,destination,destination_host,webhook_ciphertext,lark_secret_ciphertext,enabled)
         VALUES('int-gen','org-a','acme/web','[]','generic_webhook','hooks.example.com',?,?,1)`,
      )
      .run(
        await legacySeal('https://hooks.example.com/noti/inbound', K_LEGACY),
        await legacySeal(generateSigningSecret(), K_LEGACY),
      );
  }

  it.each([
    [401, 'destination_unauthorized'],
    [403, 'destination_unauthorized'],
    [404, 'destination_unauthorized'],
    [410, 'destination_unauthorized'],
  ])('HTTP %i is shown as the single "refused" bucket, not as its status class', async (status, code) => {
    await genericIntegration();
    fetchMock.mockResolvedValueOnce(new Response('', { status }));
    const id = await sendTest('int-gen');
    await consumeQueued();
    const v = await view(id);
    expect(v.state).toBe('dead_lettered');
    expect(v.error?.code).toBe(code);
  });

  it('a connection failure is the single "unreachable" bucket', async () => {
    await genericIntegration();
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const id = await sendTest('int-gen');
    await consumeQueued();
    expect((await view(id)).error?.code).toBe('destination_unavailable');
  });

  it('other destinations keep their real classification', async () => {
    await integration('int-slack', 'slack');
    fetchMock.mockResolvedValueOnce(new Response('no_service', { status: 404 }));
    const id = await sendTest('int-slack');
    await consumeQueued();
    expect((await view(id)).error?.code).toBe('destination_revoked');
  });
});

describe('what is written', () => {
  it('a normal delivery and outbox row, marked as a test, with a labelled canonical message', async () => {
    const id = await sendTest('int-lark');
    expect(rows('SELECT id,integration_id,organization_id,state,is_test FROM deliveries')).toEqual([
      { id, integration_id: 'int-lark', organization_id: 'org-a', state: 'pending', is_test: 1 },
    ]);
    // The inline dispatcher already published and marked it.
    expect(queued).toHaveLength(1);
    expect(queued[0]).toEqual({
      id,
      integrationId: 'int-lark',
      organizationId: 'org-a',
      title: TEST_TITLE,
      url: '',
      status: 'info',
      eventType: 'test',
      summary: TEST_SUMMARY,
      correlationId: expect.any(String),
    });
    expect(rows('SELECT state FROM notification_outbox WHERE id=?', id)).toEqual([{ state: 'dispatched' }]);
  });

  it('every click is a new delivery (per-request nonce)', async () => {
    const a = await sendTest('int-lark');
    settle();
    const b = await sendTest('int-lark');
    expect(a).not.toBe(b);
    expect(count('deliveries')).toBe(2);
  });

  it('writes one audit row with ids only', async () => {
    const id = await sendTest('int-lark');
    const audit = rows(
      "SELECT actor_id,action,subject_id,metadata_json FROM audit_events WHERE action='integration.test'",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: 'bob', subject_id: 'int-lark' });
    expect(JSON.parse(String(audit[0]?.metadata_json))).toEqual({ deliveryId: id });
  });

  it('a pause that lands after the reads wins: the batch guard writes nothing', async () => {
    // Simulate the race by pausing between the route's read and its write.
    const real = db.d1.batch.bind(db.d1);
    vi.spyOn(db.d1, 'batch').mockImplementationOnce((statements) => {
      db.raw.prepare("UPDATE integrations SET enabled=0 WHERE id='int-lark'").run();
      return real(statements);
    });
    const res = await post('int-lark');
    expect(res.status).toBe(409);
    expect(count('deliveries')).toBe(0);
    expect(count('notification_outbox')).toBe(0);
    expect(rows("SELECT id FROM audit_events WHERE action='integration.test'")).toEqual([]);
  });
});

describe('end to end through the real consumer and adapters', () => {
  it.each(['lark', 'slack', 'teams', 'discord'] as const)(
    '%s: sent to the documented host, with the test text and no credentials in the API view',
    async (kind) => {
      if (kind !== 'lark') await integration(`int-${kind}`, kind);
      fetchMock.mockImplementation(() => Promise.resolve(ok[kind]()));
      const id = await sendTest(`int-${kind}`);
      await consumeQueued();
      const sentTo = new URL(callUrl());
      expect(sentTo.hostname).toBe(new URL(URLS[kind]).hostname);
      const body = callBody();
      expect(body).toContain(TEST_TITLE);
      const v = await view(id);
      // Teams Workflows only ever reach "accepted": the dashboard must not call it delivered.
      expect(v).toMatchObject({ state: kind === 'teams' ? 'accepted' : 'sent', isTest: true, error: null });
      const text = JSON.stringify(v);
      expect(text).not.toContain(URLS[kind]);
      expect(text).not.toMatch(/TestFixture|sig=/);
    },
  );

  it('a permanent provider failure is classified, dead-lettered, never retried, and explained by the taxonomy', async () => {
    await integration('int-slack', 'slack');
    fetchMock.mockResolvedValueOnce(new Response('no_service', { status: 404 }));
    const id = await sendTest('int-slack');
    const [msg] = await consumeQueued();
    expect(msg).toMatchObject({ acked: true, retried: null });
    const v = await view(id);
    expect(v.state).toBe('dead_lettered');
    expect(v.error).toMatchObject({
      code: 'destination_revoked',
      messageKey: 'errors.destination_revoked',
      retryable: false,
    });
  });

  it('a transient failure is retried by the normal policy (state retrying, queue retry scheduled)', async () => {
    await integration('int-slack', 'slack');
    fetchMock.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '30' } }));
    const id = await sendTest('int-slack');
    const [msg] = await consumeQueued();
    expect(msg?.retried?.delaySeconds).toBeGreaterThanOrEqual(30);
    const v = await view(id);
    expect(v.state).toBe('retrying');
    expect(v.error).toMatchObject({ code: 'destination_rate_limited', retryable: true });
    // The retry then succeeds through the same path.
    fetchMock.mockImplementationOnce(() => Promise.resolve(ok.slack()));
    queued.push(
      JSON.parse(
        String(rows('SELECT payload_json FROM notification_outbox WHERE id=?', id)[0]?.payload_json),
      ),
    );
    db.raw.prepare('UPDATE deliveries SET next_attempt_at=1 WHERE id=?').run(id);
    await consumeQueued(2);
    expect((await view(id)).state).toBe('sent');
  });

  it('the SSRF/allowlist policy still applies: a stored URL outside the allowlist is never fetched', async () => {
    await integration('int-bad', 'slack');
    db.raw
      .prepare('UPDATE integrations SET webhook_ciphertext=? WHERE id=?')
      .run(await legacySeal('https://169.254.169.254/latest/meta-data', K_LEGACY), 'int-bad');
    const id = await sendTest('int-bad');
    await consumeQueued();
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await view(id)).error?.code).toBe('destination_url_rejected');
  });

  it('a Discord webhook that no longer exists is a permanent failure and pauses the integration, as for any event', async () => {
    await integration('int-discord', 'discord');
    fetchMock.mockResolvedValueOnce(new Response('{"code":10015}', { status: 404 }));
    const id = await sendTest('int-discord');
    await consumeQueued();
    expect((await view(id)).state).toBe('dead_lettered');
    expect(rows("SELECT enabled FROM integrations WHERE id='int-discord'")).toEqual([{ enabled: 0 }]);
  });
});

describe('a test never reaches noise control or routing filters', () => {
  it('quiet hours, digest and grouping do not hold it, and a deny filter does not block it', async () => {
    const noise = serializeNoise({
      ...DEFAULT_NOISE,
      quietHours: { start: '00:00', end: '23:59' },
      groupWindowSec: 900,
      digest: 'daily',
    });
    const filters = serializeFilters({ branch: { allow: ['never-matches'], deny: [] } });
    expect(noise).not.toBeNull();
    expect(filters).not.toBeNull();
    await integration('int-n', 'slack', { noise: noise ?? undefined, filters: filters ?? undefined });
    fetchMock.mockImplementation(() => Promise.resolve(ok.slack()));
    const id = await sendTest('int-n');
    expect(count('held_events')).toBe(0);
    await consumeQueued();
    expect((await view(id)).state).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('test deliveries in reporting', () => {
  it('are labelled in the log and excluded from the 24 h summary and the SLIs', async () => {
    await integration('int-slack', 'slack');
    fetchMock.mockImplementation(() => Promise.resolve(ok.slack()));
    const id = await sendTest('int-slack');
    await consumeQueued();
    const log = await json<{ deliveries: { id: string; isTest: boolean }[] }>(await get('/api/deliveries'));
    expect(log.deliveries).toEqual([expect.objectContaining({ id, isTest: true })]);
    const summary = await json<{ counts: Record<string, number> }>(await get('/api/deliveries/summary'));
    expect(Object.values(summary.counts).reduce((a, b) => a + b, 0)).toBe(0);
    const slis = await json<{
      deliveries: { total: number };
      successRatio: { value: number | null };
      byDestination: unknown[];
    }>(await get('/api/observability/summary?window=24h', 'alice'));
    expect(slis.deliveries.total).toBe(0);
    expect(slis.successRatio.value).toBeNull();
    expect(slis.byDestination).toEqual([]);
  });

  it('a replay of a test stays a test', async () => {
    await integration('int-slack', 'slack');
    fetchMock.mockResolvedValueOnce(new Response('no_service', { status: 404 }));
    const id = await sendTest('int-slack');
    await consumeQueued();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/deliveries/${id}/replay`, {
        method: 'POST',
        headers: { 'x-test-user': 'bob', origin: ORIGIN, 'content-type': 'application/json' },
        body: '{}',
      }),
      env,
      { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
    );
    // A member lacks delivery.replay; an admin may.
    expect(res.status).toBe(403);
    const admin = await worker.fetch(
      new Request(`${ORIGIN}/api/deliveries/${id}/replay`, {
        method: 'POST',
        headers: { 'x-test-user': 'alice', origin: ORIGIN, 'content-type': 'application/json' },
        body: '{}',
      }),
      env,
      { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
    );
    expect(admin.status).toBe(202);
    expect(rows('SELECT is_test FROM deliveries WHERE replay_of=?', id)).toEqual([{ is_test: 1 }]);
  });
});
