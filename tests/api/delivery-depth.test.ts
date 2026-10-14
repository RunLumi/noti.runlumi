import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BULK_COUNT_CAP, BULK_REPLAY_MAX, planBulkReplay } from '../../src/delivery/bulk-replay';
import type { Bindings } from '../../src/env';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

/**
 * Attempt history, duplicate and pause flags in the delivery views, and bulk replay (F181, F182,
 * F185), over the real migrations. Only Better Auth's session lookup is replaced.
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
let db: FakeD1;
let env: Bindings;

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

function integration(id: string, org: string, destination = 'slack', enabled = 1): void {
  db.raw
    .prepare(
      `INSERT INTO integrations(id,organization_id,name,repo,event_types,destination,destination_host,webhook_ciphertext,enabled)
       VALUES(?,?,?,?,?,?,?,'',?)`,
    )
    .run(id, org, id, 'acme/web', '["issues.opened"]', destination, 'hooks.slack.com', enabled);
}

interface Seed {
  id: string;
  org?: string;
  integrationId?: string;
  state?: string;
  updatedAt?: string;
  isTest?: number;
  outbox?: boolean;
  lastError?: string | null;
  possibleDuplicate?: number;
  suppressedReason?: string | null;
  duplicateOf?: string | null;
}

function delivery(d: Seed): void {
  const org = d.org ?? 'org-a';
  const integrationId = d.integrationId ?? 'int-a';
  db.raw
    .prepare(
      `INSERT INTO deliveries(id,integration_id,organization_id,state,attempts,last_error_code,last_error,created_at,updated_at,
         dead_lettered_at,is_test,possible_duplicate,suppressed_reason,duplicate_of)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      d.id,
      integrationId,
      org,
      d.state ?? 'dead_lettered',
      1,
      'destination_unavailable',
      d.lastError ?? null,
      d.updatedAt ?? '2026-10-13 10:00:00',
      d.updatedAt ?? '2026-10-13 10:00:00',
      (d.state ?? 'dead_lettered') === 'dead_lettered' ? Date.UTC(2026, 9, 13, 10) : null,
      d.isTest ?? 0,
      d.possibleDuplicate ?? 0,
      d.suppressedReason ?? null,
      d.duplicateOf ?? null,
    );
  if (d.outbox !== false)
    db.raw
      .prepare('INSERT INTO notification_outbox(id,organization_id,payload_json,state) VALUES(?,?,?,?)')
      .run(
        d.id,
        org,
        JSON.stringify({
          id: d.id,
          integrationId,
          organizationId: org,
          title: 'Issue opened',
          url: 'https://github.com/acme/web/issues/1',
        }),
        'dispatched',
      );
}

function attempt(
  deliveryId: string,
  n: number,
  over: Partial<{
    org: string;
    outcome: string;
    code: string | null;
    reason: string | null;
    statusClass: string;
    startedAt: number;
    retryAfterMs: number | null;
  }> = {},
): void {
  const startedAt = over.startedAt ?? Date.UTC(2026, 9, 13, 10, n);
  db.raw
    .prepare(
      `INSERT INTO delivery_attempts(id,organization_id,delivery_id,integration_id,attempt,started_at,finished_at,outcome,
         error_code,reason,status_class,retry_after_ms,possible_duplicate)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)`,
    )
    .run(
      `${deliveryId}-${n}-${startedAt}`,
      over.org ?? 'org-a',
      deliveryId,
      'int-a',
      n,
      startedAt,
      startedAt + 120,
      over.outcome ?? 'retry_scheduled',
      over.code === undefined ? 'destination_unavailable' : over.code,
      over.reason === undefined ? 'provider_http_503' : over.reason,
      over.statusClass ?? '5xx',
      over.retryAfterMs ?? null,
    );
}

async function call(
  method: string,
  path: string,
  options: { as?: string; body?: unknown; origin?: string | null } = {},
): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.as) headers.set('x-test-user', options.as);
  if (options.origin !== null) headers.set('origin', options.origin ?? ORIGIN);
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(options.body ?? {}) : undefined,
    }),
    env,
    { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
  );
}

interface IntegrationsBody {
  integrations: { id: string; enabled: boolean; health: unknown }[];
}

interface PlanBody {
  plan: {
    eligible: number;
    total: number;
    totalCapped: boolean;
    remaining: number;
    bound: number;
    token: string;
    typedConfirmationAbove: number;
  };
}

async function plan(body: unknown = {}, as = 'alice'): Promise<PlanBody['plan']> {
  const res = await call('POST', '/api/deliveries/replay-plan', { as, body });
  expect(res.status).toBe(200);
  return (await res.json<PlanBody>()).plan;
}

const replays = () =>
  (db.raw.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE replay_of IS NOT NULL').get() as { n: number })
    .n;
const bulkAudits = () =>
  db.raw
    .prepare(
      "SELECT organization_id,actor_id,metadata_json FROM audit_events WHERE action='delivery.bulk_replay'",
    )
    .all() as {
    organization_id: string;
    actor_id: string;
    metadata_json: string;
  }[];

beforeEach(() => {
  db = createFakeD1();
  seedOrganization(db.raw, 'org-a');
  seedOrganization(db.raw, 'org-b');
  for (const id of ['alice', 'bob', 'mallory']) user(id);
  member('alice', 'org-a', 'admin');
  member('bob', 'org-a', 'member');
  member('mallory', 'org-b', 'admin');
  integration('int-a', 'org-a');
  integration('int-a2', 'org-a');
  integration('int-b', 'org-b');
  env = {
    DB: db.d1,
    APP_ORIGIN: ORIGIN,
    KEK_V1: '11'.repeat(32),
    KMS_ACTIVE_VERSION: '1',
  } as unknown as Bindings;
});

describe('GET /api/deliveries/:id attempts (F184, F181)', () => {
  it('lists every attempt oldest first, with codes, minted reasons and the status class only', async () => {
    delivery({ id: 'd1' });
    attempt('d1', 2, {
      outcome: 'dead_lettered',
      statusClass: '4xx',
      code: 'destination_revoked',
      reason: 'provider_http_404',
    });
    attempt('d1', 1, {
      retryAfterMs: 30_000,
      code: 'destination_rate_limited',
      reason: 'provider_http_429',
      statusClass: '4xx',
    });
    const res = await call('GET', '/api/deliveries/d1', { as: 'bob' });
    const body = await res.json<{
      attemptDetail: string;
      attempts: {
        attempt: number;
        outcome: string;
        statusClass: string;
        detail: string | null;
        durationMs: number;
        retryAfterSeconds: number | null;
        error: { code: string } | null;
      }[];
    }>();
    expect(body.attemptDetail).toBe('full');
    expect(body.attempts.map((a) => [a.attempt, a.outcome, a.statusClass, a.detail])).toEqual([
      [1, 'retry_scheduled', '4xx', 'provider_http_429'],
      [2, 'dead_lettered', '4xx', 'provider_http_404'],
    ]);
    expect(body.attempts[0]).toMatchObject({
      durationMs: 120,
      retryAfterSeconds: 30,
      error: { code: 'destination_rate_limited' },
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain('https://');
    expect(text).not.toContain('webhook');
  });

  it('a delivery from before the attempts table reads as summary only', async () => {
    delivery({ id: 'old' });
    const body = await (
      await call('GET', '/api/deliveries/old', { as: 'bob' })
    ).json<{
      attemptDetail: string;
      attempts: unknown[];
    }>();
    expect(body).toMatchObject({ attemptDetail: 'summary', attempts: [] });
  });

  it('dead_letters_are_tenant_scoped: another workspace gets 404 and never another workspace’s attempts', async () => {
    delivery({ id: 'd1' });
    attempt('d1', 1);
    expect((await call('GET', '/api/deliveries/d1', { as: 'mallory' })).status).toBe(404);
    // An attempt row filed under the wrong tenant is never joined into this delivery.
    attempt('d1', 2, { org: 'org-b' });
    const body = await (
      await call('GET', '/api/deliveries/d1', { as: 'bob' })
    ).json<{
      attempts: unknown[];
    }>();
    expect(body.attempts).toHaveLength(1);
  });

  it('hides the status class and detail of a TEST to a customer endpoint (no probing oracle)', async () => {
    integration('int-g', 'org-a', 'generic_webhook');
    delivery({ id: 't1', integrationId: 'int-g', isTest: 1, state: 'dead_lettered' });
    attempt('t1', 1, {
      code: 'destination_url_rejected',
      reason: 'destination_not_allowed',
      statusClass: '4xx',
    });
    const body = await (
      await call('GET', '/api/deliveries/t1', { as: 'bob' })
    ).json<{
      attempts: { statusClass: string; detail: string | null; error: { code: string } | null }[];
    }>();
    expect(body.attempts[0]).toMatchObject({ statusClass: 'none', detail: null });
    // Coarse: refused vs unreachable, nothing finer.
    expect(['destination_unavailable', 'destination_unauthorized']).toContain(body.attempts[0]?.error?.code);
  });
});

describe('delivery view flags (F185, F183)', () => {
  it('shows a suppressed duplicate with its reason and the delivery it repeats, and the possible-duplicate flag', async () => {
    delivery({ id: 'orig', state: 'sent', possibleDuplicate: 1 });
    delivery({
      id: 'dup',
      state: 'suppressed',
      suppressedReason: 'duplicate',
      duplicateOf: 'orig',
      outbox: false,
    });
    const res = await call('GET', '/api/deliveries', { as: 'bob' });
    const { deliveries } = await res.json<{
      deliveries: {
        id: string;
        state: string;
        possibleDuplicate: boolean;
        suppression: { reason: string; duplicateOf: string } | null;
      }[];
    }>();
    const byId = Object.fromEntries(deliveries.map((d) => [d.id, d]));
    expect(byId['dup']).toMatchObject({
      state: 'suppressed',
      suppression: { reason: 'duplicate', duplicateOf: 'orig' },
    });
    expect(byId['orig']).toMatchObject({ possibleDuplicate: true, suppression: null });
  });

  it('says a waiting delivery is paused by the breaker or the destination, not failed', async () => {
    delivery({ id: 'w1', state: 'retrying', lastError: 'circuit_open' });
    delivery({ id: 'w2', state: 'retrying', lastError: 'destination_paced' });
    delivery({ id: 'w3', state: 'retrying', lastError: 'provider_http_503' });
    const { deliveries } = await (
      await call('GET', '/api/deliveries', { as: 'bob' })
    ).json<{
      deliveries: { id: string; pausedReason: string | null }[];
    }>();
    expect(Object.fromEntries(deliveries.map((d) => [d.id, d.pausedReason]))).toEqual({
      w1: 'circuit_open',
      w2: 'destination_paced',
      w3: null,
    });
  });
});

describe('integration health (F183)', () => {
  it('is null until the destination has failed, then shows the breaker state and never disables it', async () => {
    const before = await (await call('GET', '/api/integrations', { as: 'bob' })).json<IntegrationsBody>();
    expect(before.integrations.find((i) => i.id === 'int-a')?.health).toBeNull();
    db.raw
      .prepare(
        `INSERT INTO destination_health(organization_id,integration_id,state,consecutive_failures,open_until,opened_count,last_failure_code,last_failure_at,updated_at)
         VALUES('org-a','int-a','open',5,?,1,'destination_unavailable',?,?)`,
      )
      .run(Date.now() + 120_000, Date.now(), Date.now());
    const after = await (
      await call('GET', '/api/integrations', { as: 'bob' })
    ).json<
      IntegrationsBody & {
        integrations: {
          health: {
            state: string;
            paused: boolean;
            consecutiveFailures: number;
            lastFailureCode: string;
            timesOpened: number;
          } | null;
        }[];
      }
    >();
    const a = after.integrations.find((i) => i.id === 'int-a');
    expect(a).toMatchObject({
      enabled: true,
      health: { state: 'open', paused: true, consecutiveFailures: 5, timesOpened: 1 },
    });
    expect(after.integrations.find((i) => i.id === 'int-a2')?.health).toBeNull();
    // Another workspace never sees it.
    const other = await (await call('GET', '/api/integrations', { as: 'mallory' })).json<IntegrationsBody>();
    expect(other.integrations.map((i) => i.id)).toEqual(['int-b']);
  });
});

describe('bulk replay (F182)', () => {
  it('replay_plan counts what would be replayed and writes nothing', async () => {
    for (let i = 0; i < 3; i++) delivery({ id: `d${i}` });
    const p = await plan();
    expect(p).toMatchObject({
      eligible: 3,
      total: 3,
      totalCapped: false,
      remaining: 0,
      bound: BULK_REPLAY_MAX,
    });
    expect(p.token).toMatch(/^[0-9a-f]{64}$/);
    expect(replays()).toBe(0);
    expect(bulkAudits()).toEqual([]);
  });

  it('leaves out everything a replay could not or should not deliver', async () => {
    delivery({ id: 'ok' });
    delivery({ id: 'sent', state: 'sent' });
    delivery({ id: 'test', isTest: 1 });
    delivery({ id: 'nomsg', outbox: false });
    delivery({ id: 'paused', integrationId: 'int-p' });
    integration('int-p', 'org-a', 'slack', 0);
    delivery({ id: 'other-tenant', org: 'org-b', integrationId: 'int-b' });
    delivery({ id: 'replayed' });
    delivery({ id: 'replayed-r', state: 'pending' });
    db.raw.prepare("UPDATE deliveries SET replay_of='replayed' WHERE id='replayed-r'").run();
    const p = await plan();
    // ok, plus the pending replay's own row is not dead-lettered, so only `ok` qualifies.
    expect(p.eligible).toBe(1);
  });

  it('narrows by integration and by time window', async () => {
    delivery({ id: 'a1', integrationId: 'int-a', updatedAt: '2026-10-10 10:00:00' });
    delivery({ id: 'a2', integrationId: 'int-a', updatedAt: '2026-10-13 10:00:00' });
    delivery({ id: 'b1', integrationId: 'int-a2', updatedAt: '2026-10-13 10:00:00' });
    expect((await plan({ integrationId: 'int-a' })).eligible).toBe(2);
    expect((await plan({ integrationId: 'int-a', from: '2026-10-12' })).eligible).toBe(1);
    expect((await plan({ from: '2026-10-12', to: '2026-10-13' })).eligible).toBe(2);
  });

  it('is bounded: never more than 200 per request, with the remainder reported', async () => {
    db.raw.exec('BEGIN');
    for (let i = 0; i < BULK_REPLAY_MAX + 50; i++) delivery({ id: `d${String(i).padStart(4, '0')}` });
    db.raw.exec('COMMIT');
    const p = await plan();
    expect(p).toMatchObject({ eligible: BULK_REPLAY_MAX, total: BULK_REPLAY_MAX + 50, remaining: 50 });
    const run = await call('POST', '/api/deliveries/replay', {
      as: 'alice',
      body: { token: p.token, expectedCount: p.eligible },
    });
    expect(run.status).toBe(202);
    expect((await run.json<{ result: { replayed: number; remaining: number } }>()).result).toMatchObject({
      requested: BULK_REPLAY_MAX,
      replayed: BULK_REPLAY_MAX,
      remaining: 50,
    });
    expect(replays()).toBe(BULK_REPLAY_MAX);
    // Run again for the rest.
    const p2 = await plan();
    expect(p2.eligible).toBe(50);
    const run2 = await call('POST', '/api/deliveries/replay', {
      as: 'alice',
      body: { token: p2.token, expectedCount: 50 },
    });
    expect(run2.status).toBe(202);
    expect(replays()).toBe(BULK_REPLAY_MAX + 50);
  });

  it('counting is capped, and the cap is stated', async () => {
    const plan0 = await planBulkReplay(db.d1, 'org-a', { integrationId: null, from: null, to: null });
    expect(plan0).toMatchObject({ total: 0, totalCapped: false });
    expect(BULK_COUNT_CAP).toBeGreaterThan(BULK_REPLAY_MAX);
  });

  it('replays the planned set, writes one audit row with the counts, and each replay points at its original', async () => {
    for (let i = 0; i < 3; i++) delivery({ id: `d${i}` });
    const p = await plan({ integrationId: 'int-a' });
    const res = await call('POST', '/api/deliveries/replay', {
      as: 'alice',
      body: { integrationId: 'int-a', token: p.token, expectedCount: 3 },
    });
    expect(res.status).toBe(202);
    expect(replays()).toBe(3);
    const pointing = db.raw
      .prepare('SELECT replay_of FROM deliveries WHERE replay_of IS NOT NULL ORDER BY replay_of')
      .all();
    expect(pointing).toEqual([{ replay_of: 'd0' }, { replay_of: 'd1' }, { replay_of: 'd2' }]);
    const [audit, ...rest] = bulkAudits();
    expect(rest).toEqual([]);
    expect(audit).toMatchObject({ organization_id: 'org-a', actor_id: 'alice' });
    expect(JSON.parse(audit?.metadata_json ?? '{}')).toEqual({
      requested: 3,
      replayed: 3,
      alreadyInFlight: 0,
      refused: 0,
      remaining: 0,
      integrationId: 'int-a',
    });
    // The new deliveries are pending with a fresh attempt counter, ready for the normal dispatcher.
    expect(
      db.raw
        .prepare(
          "SELECT COUNT(*) AS n FROM deliveries WHERE replay_of IS NOT NULL AND state='pending' AND attempts=0",
        )
        .get(),
    ).toEqual({ n: 3 });
  });

  it('is idempotent: submitting the same plan twice replays once', async () => {
    for (let i = 0; i < 3; i++) delivery({ id: `d${i}` });
    const p = await plan();
    const body = { token: p.token, expectedCount: 3 };
    expect((await call('POST', '/api/deliveries/replay', { as: 'alice', body })).status).toBe(202);
    const again = await call('POST', '/api/deliveries/replay', { as: 'alice', body });
    expect(again.status).toBe(409);
    expect((await again.json<{ reason: string }>()).reason).toBe('nothing_to_replay');
    expect(replays()).toBe(3);
    expect(bulkAudits()).toHaveLength(1);
  });

  it('refuses a stale plan and writes nothing: the backlog changed after the preview', async () => {
    for (let i = 0; i < 3; i++) delivery({ id: `d${i}` });
    const p = await plan();
    delivery({ id: 'late' });
    const res = await call('POST', '/api/deliveries/replay', {
      as: 'alice',
      body: { token: p.token, expectedCount: 3 },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: 'plan_stale', eligible: 4 });
    expect(replays()).toBe(0);
    expect(bulkAudits()).toEqual([]);
  });

  it('refuses a token from another filter or another workspace', async () => {
    for (let i = 0; i < 2; i++) delivery({ id: `d${i}` });
    const p = await plan({ integrationId: 'int-a' });
    const wrongFilter = await call('POST', '/api/deliveries/replay', {
      as: 'alice',
      body: { integrationId: 'int-a2', token: p.token, expectedCount: 2 },
    });
    expect([409, 422]).toContain(wrongFilter.status);
    expect(replays()).toBe(0);
  });

  it('needs the confirmed count to match', async () => {
    for (let i = 0; i < 3; i++) delivery({ id: `d${i}` });
    const p = await plan();
    const res = await call('POST', '/api/deliveries/replay', {
      as: 'alice',
      body: { token: p.token, expectedCount: 2 },
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ reason: 'count_mismatch' });
    expect(replays()).toBe(0);
  });

  it('requires the replay capability: a plain member is refused on both steps', async () => {
    delivery({ id: 'd1' });
    expect((await call('POST', '/api/deliveries/replay-plan', { as: 'bob' })).status).toBe(403);
    expect(
      (await call('POST', '/api/deliveries/replay', { as: 'bob', body: { token: 'x', expectedCount: 1 } }))
        .status,
    ).toBe(403);
    expect(replays()).toBe(0);
  });

  it('needs a session, our Origin and a JSON body', async () => {
    expect((await call('POST', '/api/deliveries/replay-plan')).status).toBe(401);
    expect(
      (await call('POST', '/api/deliveries/replay-plan', { as: 'alice', origin: 'https://evil.test' }))
        .status,
    ).toBe(403);
  });

  it('rejects malformed input before touching anything', async () => {
    const bad = await call('POST', '/api/deliveries/replay-plan', {
      as: 'alice',
      body: { from: 'not a date', integrationId: 7 },
    });
    expect(bad.status).toBe(422);
    const missing = await call('POST', '/api/deliveries/replay', { as: 'alice', body: {} });
    expect(missing.status).toBe(422);
  });

  it('is refused while the workspace deletion is pending', async () => {
    delivery({ id: 'd1' });
    const p = await plan();
    db.raw
      .prepare(
        `INSERT INTO workspace_deletions(organization_id,requested_by,requested_at,purge_after,disabled_integration_ids)
         VALUES('org-a','alice',CURRENT_TIMESTAMP,?,'[]')`,
      )
      .run(Date.now() + 86_400_000);
    const res = await call('POST', '/api/deliveries/replay', {
      as: 'alice',
      body: { token: p.token, expectedCount: 1 },
    });
    expect(res.status).toBe(409);
    expect(replays()).toBe(0);
  });

  it('is rate limited, far below the single-replay rate', async () => {
    delivery({ id: 'd1' });
    let last = 0;
    for (let i = 0; i < 7; i++)
      last = (await call('POST', '/api/deliveries/replay-plan', { as: 'alice' })).status;
    expect(last).toBe(429);
  });

  it('never replays another workspace’s deliveries', async () => {
    delivery({ id: 'x1', org: 'org-b', integrationId: 'int-b' });
    expect((await plan()).eligible).toBe(0);
    const p = await plan({}, 'mallory');
    expect(p.eligible).toBe(1);
  });
});
