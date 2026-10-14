import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOT_ENV } from '../support/boot-env';
import type { Bindings } from '../../src/env';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

/**
 * The delivery log API over the real migrations. As in the integrations tests, only Better
 * Auth's session lookup is replaced: `x-test-user` names the signed-in user.
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

function integration(id: string, org: string, name: string): void {
  db.raw
    .prepare(
      `INSERT INTO integrations(id,organization_id,name,repo,event_types,destination,destination_host,webhook_ciphertext,enabled)
       VALUES(?,?,?,?,?,?,?,'',1)`,
    )
    .run(id, org, name, 'acme/web', '["issues.opened"]', 'slack', 'hooks.slack.com');
}

interface SeedDelivery {
  id: string;
  org?: string;
  integrationId?: string;
  state?: string;
  updatedAt?: string;
  code?: string | null;
  replayOf?: string | null;
  attempts?: number;
}

/** A delivery row, plus the outbox row a replay re-sends (the stored message, no URL). */
function delivery(d: SeedDelivery): void {
  const org = d.org ?? 'org-a';
  const integrationId = d.integrationId ?? 'int-a';
  db.raw
    .prepare(
      `INSERT INTO deliveries(id,integration_id,organization_id,state,attempts,last_error_code,replay_of,created_at,updated_at,dead_lettered_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      d.id,
      integrationId,
      org,
      d.state ?? 'dead_lettered',
      d.attempts ?? 1,
      d.code === undefined ? 'destination_revoked' : d.code,
      d.replayOf ?? null,
      d.updatedAt ?? '2026-10-13 10:00:00',
      d.updatedAt ?? '2026-10-13 10:00:00',
      d.state === 'dead_lettered' || d.state === undefined ? Date.UTC(2026, 9, 13, 10) : null,
    );
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

async function call(
  method: string,
  path: string,
  options: { as?: string; origin?: string | null; contentType?: string | null; org?: string } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.contentType !== null) headers.set('content-type', options.contentType ?? 'application/json');
  if (options.as) headers.set('x-test-user', options.as);
  if (options.org) headers.set('x-test-active-org', options.org);
  if (options.origin !== null) headers.set('origin', options.origin ?? ORIGIN);
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, { method, headers, body: method === 'POST' ? '{}' : undefined }),
    env,
    { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
  );
}

interface ListBody {
  deliveries: {
    id: string;
    state: string;
    canReplay: boolean;
    integration: { name: string };
    integrationExists: boolean;
    error: { code: string; messageKey: string | null } | null;
    latestReplayState: string | null;
  }[];
  nextCursor: string | null;
}

async function json<T>(res: Response): Promise<T> {
  return await res.json();
}

async function list(query = '', as = 'bob'): Promise<ListBody> {
  const res = await call('GET', `/api/deliveries${query}`, { as });
  expect(res.status).toBe(200);
  return await json<ListBody>(res);
}

function auditActions(org: string): string[] {
  return (
    db.raw.prepare('SELECT action FROM audit_events WHERE organization_id=? ORDER BY rowid').all(org) as {
      action: string;
    }[]
  ).map((r) => r.action);
}

beforeEach(() => {
  db = createFakeD1();
  seedOrganization(db.raw, 'org-a');
  seedOrganization(db.raw, 'org-b');
  for (const id of ['alice', 'bob', 'mallory']) user(id);
  member('alice', 'org-a', 'admin');
  member('bob', 'org-a', 'member');
  member('mallory', 'org-b', 'admin');
  integration('int-a', 'org-a', 'Alerts');
  integration('int-b', 'org-b', 'Other tenant');
  env = {
    ...BOOT_ENV,
    DB: db.d1,
    APP_ORIGIN: ORIGIN,
    KEK_V1: '11'.repeat(32),
    KMS_ACTIVE_VERSION: '1',
    ENVIRONMENT_NAME: 'staging',
    KEK_CHECK_V1: '4464ea2121d3a99ebd188370f1ef6cd0',
  } as unknown as Bindings;
});

describe('GET /api/deliveries', () => {
  it('requires a session', async () => {
    expect((await call('GET', '/api/deliveries')).status).toBe(401);
  });

  it('lists only the caller’s workspace, newest first, with the integration joined', async () => {
    delivery({ id: 'd1', updatedAt: '2026-10-13 09:00:00' });
    delivery({ id: 'd2', updatedAt: '2026-10-13 11:00:00', state: 'sent', code: null });
    delivery({ id: 'x1', org: 'org-b', integrationId: 'int-b' });
    const { deliveries } = await list();
    expect(deliveries.map((d) => d.id)).toEqual(['d2', 'd1']);
    expect(deliveries[0]?.integration.name).toBe('Alerts');
    expect(deliveries[1]?.error).toMatchObject({
      code: 'destination_revoked',
      messageKey: 'errors.destination_revoked',
    });
  });

  it('does not join another workspace’s integration even if the id collides', async () => {
    delivery({ id: 'd1', integrationId: 'int-b' });
    const [row] = (await list()).deliveries;
    expect(row?.integration.name).not.toBe('Other tenant');
    expect(row?.integrationExists).toBe(false);
  });

  it('never returns payloads, URLs or secrets', async () => {
    delivery({ id: 'd1' });
    const text = await (await call('GET', '/api/deliveries', { as: 'bob' })).text();
    expect(text).not.toContain('github.com/acme');
    expect(text).not.toContain('payload');
    expect(text).not.toContain('webhook');
  });

  it('shows a member the log but not the redeliver action', async () => {
    delivery({ id: 'd1' });
    expect((await list('', 'bob')).deliveries[0]?.canReplay).toBe(false);
    expect((await list('', 'alice')).deliveries[0]?.canReplay).toBe(true);
  });

  it('only offers redelivery for dead-lettered rows', async () => {
    delivery({ id: 'd1', state: 'sent', code: null });
    delivery({ id: 'd2', state: 'retrying', code: 'destination_unavailable' });
    const rows = (await list('', 'alice')).deliveries;
    expect(rows.every((r) => !r.canReplay)).toBe(true);
  });

  it('reads the legacy `failed` state as dead_lettered, and filters it in', async () => {
    db.raw.exec('PRAGMA ignore_check_constraints=ON');
    delivery({ id: 'old', state: 'failed', code: null });
    const { deliveries } = await list('?state=dead_lettered');
    expect(deliveries).toMatchObject([{ id: 'old', state: 'dead_lettered' }]);
  });

  it('paginates by (updated_at, id) without skipping or repeating rows', async () => {
    // Several rows share a timestamp: the id is the tiebreaker.
    for (let i = 0; i < 7; i++)
      delivery({ id: `d${i}`, updatedAt: i < 4 ? '2026-10-13 10:00:00' : '2026-10-13 11:00:00' });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: ListBody = await list(`?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...page.deliveries.map((d) => d.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(['d6', 'd5', 'd4', 'd3', 'd2', 'd1', 'd0']);
  });

  it('caps the page size at 100 and refuses a forged cursor', async () => {
    for (let i = 0; i < 105; i++) delivery({ id: `d${String(i).padStart(3, '0')}` });
    expect((await list('?limit=500')).deliveries).toHaveLength(100);
    expect((await call('GET', '/api/deliveries?cursor=not-a-cursor', { as: 'bob' })).status).toBe(422);
    expect((await call('GET', '/api/deliveries?limit=0', { as: 'bob' })).status).toBe(422);
  });

  it('filters by state, integration and date range', async () => {
    integration('int-c', 'org-a', 'Second');
    delivery({ id: 'a', state: 'sent', code: null, updatedAt: '2026-10-10 10:00:00' });
    delivery({ id: 'b', integrationId: 'int-c', updatedAt: '2026-10-12 10:00:00' });
    delivery({ id: 'c', updatedAt: '2026-10-13 10:00:00' });
    expect((await list('?state=sent')).deliveries.map((d) => d.id)).toEqual(['a']);
    expect((await list('?integrationId=int-c')).deliveries.map((d) => d.id)).toEqual(['b']);
    expect((await list('?from=2026-10-12&to=2026-10-12')).deliveries.map((d) => d.id)).toEqual(['b']);
    expect((await list('?from=2026-10-12')).deliveries.map((d) => d.id)).toEqual(['c', 'b']);
    expect((await call('GET', '/api/deliveries?state=bogus', { as: 'bob' })).status).toBe(422);
    expect((await call('GET', '/api/deliveries?from=yesterday', { as: 'bob' })).status).toBe(422);
  });

  it('filtering by another workspace’s integration id returns nothing', async () => {
    delivery({ id: 'd1' });
    expect((await list('?integrationId=int-b')).deliveries).toEqual([]);
  });
});

describe('GET /api/deliveries/:id', () => {
  it('returns the row, a honest summary timeline, and its replays', async () => {
    delivery({ id: 'd1', attempts: 3 });
    delivery({ id: 'r1', state: 'pending', code: null, replayOf: 'd1' });
    const res = await call('GET', '/api/deliveries/d1', { as: 'bob' });
    const body = await json<{
      delivery: { id: string; attempts: number };
      timeline: { kind: string }[];
      attemptDetail: string;
      replays: { id: string; state: string }[];
    }>(res);
    expect(res.status).toBe(200);
    expect(body.delivery).toMatchObject({ id: 'd1', attempts: 3 });
    expect(body.attemptDetail).toBe('summary');
    expect(body.timeline.map((t) => t.kind)).toEqual(['created', 'dead_lettered']);
    expect(body.replays).toMatchObject([{ id: 'r1', state: 'pending' }]);
  });

  it('answers 404 for another workspace’s delivery and for a missing one alike', async () => {
    delivery({ id: 'x1', org: 'org-b', integrationId: 'int-b' });
    const other = await call('GET', '/api/deliveries/x1', { as: 'bob' });
    const missing = await call('GET', '/api/deliveries/nope', { as: 'bob' });
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual(await missing.json());
  });

  it('refuses ?org= for a workspace the caller does not belong to', async () => {
    delivery({ id: 'd1' });
    expect((await call('GET', '/api/deliveries/d1?org=org-b', { as: 'bob' })).status).toBe(404);
    expect((await call('GET', '/api/deliveries?org=org-b', { as: 'bob' })).status).toBe(404);
  });
});

describe('GET /api/deliveries/summary', () => {
  it('counts the last 24 hours by state, in this workspace only', async () => {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    delivery({ id: 'a', state: 'sent', code: null, updatedAt: now });
    delivery({ id: 'b', state: 'sent', code: null, updatedAt: now });
    delivery({ id: 'c', updatedAt: now });
    delivery({ id: 'old', state: 'sent', code: null, updatedAt: '2020-01-01 00:00:00' });
    delivery({ id: 'x', org: 'org-b', integrationId: 'int-b', state: 'sent', code: null, updatedAt: now });
    const res = await call('GET', '/api/deliveries/summary', { as: 'bob' });
    const body = await json<{ counts: Record<string, number>; windowHours: number }>(res);
    expect(body.windowHours).toBe(24);
    expect(body.counts).toMatchObject({ sent: 2, dead_lettered: 1, retrying: 0 });
  });
});

describe('POST /api/deliveries/:id/replay', () => {
  const replay = (id: string, as = 'alice', extra: Parameters<typeof call>[2] = {}) =>
    call('POST', `/api/deliveries/${id}/replay`, { as, ...extra });

  const rowsReplaying = (id: string) =>
    db.raw.prepare('SELECT id,state,attempts FROM deliveries WHERE replay_of=?').all(id);

  it('is admin only, and the refusal is audited', async () => {
    delivery({ id: 'd1' });
    const res = await replay('d1', 'bob');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Missing capability: delivery.replay' });
    expect(rowsReplaying('d1')).toHaveLength(0);
    expect(auditActions('org-a')).toEqual(['access.denied']);
  });

  it('creates one new pending row, leaves the original untouched, and audits it', async () => {
    delivery({ id: 'd1', attempts: 13 });
    const res = await replay('d1');
    expect(res.status).toBe(202);
    const { replay: r } = await json<{ replay: { deliveryId: string; created: boolean } }>(res);
    expect(r.created).toBe(true);
    expect(
      db.raw.prepare('SELECT state,attempts,replay_of FROM deliveries WHERE id=?').get(r.deliveryId),
    ).toMatchObject({ state: 'pending', attempts: 0, replay_of: 'd1' });
    expect(db.raw.prepare('SELECT state,attempts FROM deliveries WHERE id=?').get('d1')).toMatchObject({
      state: 'dead_lettered',
      attempts: 13,
    });
    expect(auditActions('org-a')).toEqual(['delivery.replay']);
    const audit = db.raw
      .prepare('SELECT actor_id,subject_type,subject_id,outcome FROM audit_events WHERE action=?')
      .get('delivery.replay');
    expect(audit).toMatchObject({
      actor_id: 'alice',
      subject_type: 'delivery',
      subject_id: 'd1',
      outcome: 'success',
    });
  });

  it('is idempotent: a double POST makes one new row and one audit entry', async () => {
    delivery({ id: 'd1' });
    const first = await replay('d1');
    const second = await replay('d1');
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    const a = await json<{ replay: { deliveryId: string } }>(first);
    const b = await json<{ replay: { deliveryId: string; created: boolean } }>(second);
    expect(b.replay).toMatchObject({ deliveryId: a.replay.deliveryId, created: false });
    expect(rowsReplaying('d1')).toHaveLength(1);
    expect(auditActions('org-a')).toEqual(['delivery.replay']);
  });

  it('concurrent requests also make one row', async () => {
    delivery({ id: 'd1' });
    await Promise.all([replay('d1'), replay('d1')]);
    expect(rowsReplaying('d1')).toHaveLength(1);
  });

  it('allows another replay once the previous one dead-lettered too', async () => {
    delivery({ id: 'd1' });
    const first = await json<{ replay: { deliveryId: string } }>(await replay('d1'));
    db.raw.prepare("UPDATE deliveries SET state='dead_lettered' WHERE id=?").run(first.replay.deliveryId);
    expect((await replay('d1')).status).toBe(202);
    expect(rowsReplaying('d1')).toHaveLength(2);
  });

  it('refuses everything that is not dead-lettered, and a missing payload', async () => {
    delivery({ id: 's', state: 'sent', code: null });
    delivery({ id: 'a', state: 'accepted', code: null });
    delivery({ id: 'r', state: 'retrying', code: 'destination_unavailable' });
    delivery({ id: 'p', state: 'pending', code: null });
    expect((await replay('s')).status).toBe(409);
    expect((await json<{ reason: string }>(await replay('a'))).reason).toBe('already_delivered');
    expect((await json<{ reason: string }>(await replay('r'))).reason).toBe('not_replayable');
    expect((await json<{ reason: string }>(await replay('p'))).reason).toBe('not_replayable');
    delivery({ id: 'gone' });
    db.raw.prepare('DELETE FROM notification_outbox WHERE id=?').run('gone');
    expect((await json<{ reason: string }>(await replay('gone'))).reason).toBe('payload_unavailable');
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE replay_of IS NOT NULL').get()).toEqual({
      n: 0,
    });
    expect(auditActions('org-a')).toEqual([]);
  });

  it('cannot replay another workspace’s delivery', async () => {
    delivery({ id: 'x1', org: 'org-b', integrationId: 'int-b' });
    expect((await replay('x1')).status).toBe(404);
    expect(rowsReplaying('x1')).toHaveLength(0);
  });

  it('enforces the CSRF checks', async () => {
    delivery({ id: 'd1' });
    expect((await replay('d1', 'alice', { origin: 'https://evil.test' })).status).toBe(403);
    expect((await replay('d1', 'alice', { origin: null })).status).toBe(403);
    expect((await replay('d1', 'alice', { contentType: 'text/plain' })).status).toBe(415);
    expect((await replay('d1', 'alice', { contentType: null })).status).toBe(415);
    expect(rowsReplaying('d1')).toHaveLength(0);
  });

  it('is refused while the workspace deletion is pending', async () => {
    delivery({ id: 'd1' });
    db.raw
      .prepare(
        `INSERT INTO workspace_deletions(organization_id,requested_by,requested_at,purge_after,disabled_integration_ids)
         VALUES('org-a','alice',CURRENT_TIMESTAMP,?,'[]')`,
      )
      .run(Date.now() + 86_400_000);
    expect((await replay('d1')).status).toBe(409);
    expect(rowsReplaying('d1')).toHaveLength(0);
  });

  it('is rate limited like other mutations', async () => {
    for (let i = 0; i < 31; i++) delivery({ id: `d${i}` });
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await replay(`d${i}`)).status;
    expect(last).toBe(429);
  });
});

describe('replay needs a usable integration (M1)', () => {
  const replay = (id: string) => call('POST', `/api/deliveries/${id}/replay`, { as: 'alice' });
  const replayRows = () =>
    db.raw.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE replay_of IS NOT NULL').get();
  const adminRow = async () =>
    (await json<ListBody>(await call('GET', '/api/deliveries', { as: 'alice' }))).deliveries[0];

  const breakIt: [string, string, () => void][] = [
    ['paused', 'disabled', () => db.raw.prepare("UPDATE integrations SET enabled=0 WHERE id='int-a'").run()],
    [
      'quarantined',
      'quarantined',
      () =>
        db.raw
          .prepare("UPDATE integrations SET credentials_quarantined_at=CURRENT_TIMESTAMP WHERE id='int-a'")
          .run(),
    ],
    ['deleted', 'missing', () => db.raw.prepare("DELETE FROM integrations WHERE id='int-a'").run()],
  ];

  it.each(breakIt)(
    'a %s integration: no replay, a clear 409, no offer in the log',
    async (_n, status, act) => {
      delivery({ id: 'd1' });
      act();
      const row = await adminRow();
      expect((row as unknown as { integrationStatus: string }).integrationStatus).toBe(status);
      expect(row?.canReplay).toBe(false);
      const res = await replay('d1');
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ reason: 'integration_unavailable' });
      expect(replayRows()).toEqual({ n: 0 });
      expect(auditActions('org-a')).toEqual([]);
      expect(db.raw.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get()).toEqual({ n: 1 });
    },
  );

  it('offers replay when the integration is usable', async () => {
    delivery({ id: 'd1' });
    const row = await adminRow();
    expect((row as unknown as { integrationStatus: string }).integrationStatus).toBe('available');
    expect(row?.canReplay).toBe(true);
    expect((await replay('d1')).status).toBe(202);
  });
});

describe('the replay audit row is atomic with the replay (M2, L1, L2)', () => {
  const replay = (id: string) => call('POST', `/api/deliveries/${id}/replay`, { as: 'alice' });
  const count = (sql: string) => (db.raw.prepare(sql).get() as { n: number }).n;

  it('has exactly one audit row per created replay, including under concurrency', async () => {
    delivery({ id: 'd1' });
    await Promise.all([replay('d1'), replay('d1'), replay('d1')]);
    await replay('d1');
    expect(count('SELECT COUNT(*) AS n FROM deliveries WHERE replay_of IS NOT NULL')).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM audit_events WHERE action='delivery.replay'")).toBe(1);
    const meta = db.raw
      .prepare("SELECT metadata_json FROM audit_events WHERE action='delivery.replay'")
      .get() as { metadata_json: string };
    const created = db.raw.prepare('SELECT id FROM deliveries WHERE replay_of=?').get('d1') as { id: string };
    expect(JSON.parse(meta.metadata_json)).toEqual({ replayDeliveryId: created.id });
  });

  it('writes neither the replay nor its outbox row when the audit write fails', async () => {
    delivery({ id: 'd1' });
    db.raw.exec(
      `CREATE TRIGGER fail_replay_audit BEFORE INSERT ON audit_events WHEN NEW.action='delivery.replay'
       BEGIN SELECT RAISE(ABORT,'audit down'); END`,
    );
    const res = await replay('d1');
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(count('SELECT COUNT(*) AS n FROM deliveries WHERE replay_of IS NOT NULL')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM notification_outbox')).toBe(1);
    expect(db.raw.prepare('SELECT replay_count FROM deliveries WHERE id=?').get('d1')).toEqual({
      replay_count: 0,
    });
  });

  it('does not touch the original row’s updated_at, so cursors stay stable', async () => {
    delivery({ id: 'd1', updatedAt: '2026-10-13 10:00:00' });
    await replay('d1');
    expect(db.raw.prepare('SELECT updated_at, replay_count FROM deliveries WHERE id=?').get('d1')).toEqual({
      updated_at: '2026-10-13 10:00:00',
      replay_count: 1,
    });
  });

  it('refuses inside the write itself when a deletion was requested after the checks', async () => {
    delivery({ id: 'd1' });
    db.raw
      .prepare(
        `INSERT INTO workspace_deletions(organization_id,requested_by,requested_at,purge_after,disabled_integration_ids)
         VALUES('org-a','alice',CURRENT_TIMESTAMP,?,'[]')`,
      )
      .run(Date.now() + 86_400_000);
    const { redeliver } = await import('../../src/delivery/redeliver');
    const result = await redeliver(db.d1, {
      organizationId: 'org-a',
      deliveryId: 'd1',
      audit: { actorId: 'alice' },
    });
    expect(result).toEqual({ ok: false, error: 'deletion_pending' });
    expect(count('SELECT COUNT(*) AS n FROM deliveries WHERE replay_of IS NOT NULL')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM audit_events')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM notification_outbox')).toBe(1);
  });
});

describe('read rate limit (L3)', () => {
  it('answers 429 with Retry-After past the per-user ceiling, and only for that user', async () => {
    let last: Response | undefined;
    for (let i = 0; i < 301; i++) last = await call('GET', '/api/deliveries/summary', { as: 'bob' });
    expect(last?.status).toBe(429);
    expect(Number(last?.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect((await call('GET', '/api/deliveries/summary', { as: 'alice' })).status).toBe(200);
  });
});

describe('delivery log indexes (M3)', () => {
  const plan = (sql: string, values: readonly (string | number)[]) =>
    (db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(values as never[])) as { detail: string }[])
      .map((r) => r.detail)
      .join('\n');

  it('serves the list from the (organization, updated_at, id) index without a sort', async () => {
    const { buildListQuery } = await import('../../src/api/delivery-queries');
    const q = buildListQuery('org-a', {
      state: null,
      integrationId: null,
      correlationId: null,
      from: null,
      to: null,
      cursor: null,
      limit: 25,
    });
    const text = plan(q.sql, q.values);
    expect(text).toContain('deliveries_org_updated');
    expect(text).not.toContain('USE TEMP B-TREE FOR ORDER BY');
  });

  it('serves the summary from the (organization, created_at) index', async () => {
    const { SUMMARY_SQL } = await import('../../src/api/delivery-queries');
    expect(plan(SUMMARY_SQL, ['org-a', '2026-10-13 00:00:00', '2026-10-13 00:00:00'])).toContain(
      'deliveries_org_created',
    );
  });

  it('still counts rows without created_at by updated_at', async () => {
    delivery({ id: 'old', state: 'sent', updatedAt: '2000-01-01 00:00:00' });
    delivery({
      id: 'legacy',
      state: 'sent',
      updatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    });
    db.raw.prepare("UPDATE deliveries SET created_at=NULL WHERE id IN ('old','legacy')").run();
    const res = await call('GET', '/api/deliveries/summary', { as: 'alice' });
    expect((await json<{ counts: { sent: number } }>(res)).counts.sent).toBe(1);
  });
});
