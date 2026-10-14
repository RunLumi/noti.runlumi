import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOT_ENV } from '../support/boot-env';
import type { Bindings } from '../../src/env';
import { AUDIT_TOTAL_CAP, changesOf, parseAuditFilters, buildAuditQuery } from '../../src/api/audit-view';
import { diffMetadata } from '../../src/audit/diff';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

/**
 * The audit read side (REMAINING 1.32, F222): actor, target and request filters, a total, field diffs,
 * and fail-closed reads. The base behaviour (admin only, tenant scope, allow-list) is in audit.test.ts.
 */
vi.mock('../../src/auth/better-auth', () => ({
  createAuth: () => ({
    api: {
      getSession: ({ headers }: { headers: Headers }) => {
        const id = headers.get('x-test-user');
        return Promise.resolve(
          id
            ? {
                user: { id, email: `${id}@example.test`, emailVerified: true, name: `Name of ${id}` },
                session: { id: `sess-${id}`, activeOrganizationId: null },
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

function request(method: string, path: string, as: string, body?: unknown, bindings: Partial<Bindings> = {}) {
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        'x-test-user': as,
        ...(body === undefined ? {} : { 'content-type': 'application/json', origin: ORIGIN }),
        ...(method === 'GET' ? {} : { origin: ORIGIN }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...env, ...bindings },
    { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
  );
}
const get = (path: string, as = 'alice', bindings: Partial<Bindings> = {}) =>
  request('GET', path, as, undefined, bindings);

interface Seed {
  id: string;
  org: string | null;
  actor?: string | null;
  action?: string;
  outcome?: string;
  at: string;
  metadata?: unknown;
  subject?: string | null;
  subjectType?: string;
  correlation?: string | null;
}

function event(e: Seed): void {
  db.raw
    .prepare(
      `INSERT INTO audit_events(id,organization_id,actor_id,action,subject_type,subject_id,outcome,ip,user_agent,metadata_json,created_at,correlation_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      e.id,
      e.org,
      e.actor ?? null,
      e.action ?? 'integration.update',
      e.subjectType ?? 'integration',
      e.subject === undefined ? 'int-1' : e.subject,
      e.outcome ?? 'success',
      '203.0.113.9',
      'Probe/1.0',
      JSON.stringify(e.metadata ?? {}),
      e.at,
      e.correlation ?? null,
    );
}

beforeEach(() => {
  db = createFakeD1();
  for (const id of ['alice', 'bob', 'carol', 'dave']) {
    db.raw
      .prepare('INSERT INTO "user"(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(id, `Name of ${id}`, `${id}@example.test`, 1, 1, 1);
  }
  seedOrganization(db.raw, 'org-a');
  seedOrganization(db.raw, 'org-b');
  const join = db.raw.prepare(
    'INSERT INTO "member"(id,user_id,organization_id,role,created_at) VALUES(?,?,?,?,?)',
  );
  join.run('m1', 'alice', 'org-a', 'admin', 1);
  join.run('m2', 'bob', 'org-a', 'member', 1);
  join.run('m3', 'carol', 'org-b', 'admin', 1);
  env = { ...BOOT_ENV, DB: db.d1, APP_ORIGIN: ORIGIN } as unknown as Bindings;
});

const ids = async (query: string, as = 'alice') =>
  (await (await get(`/api/audit${query}`, as)).json<{ events: { id: string }[] }>()).events.map((e) => e.id);

describe('actor, target and request filters', () => {
  beforeEach(() => {
    event({ id: 'e1', org: 'org-a', actor: 'alice', at: '2026-10-01 10:00:00', subject: 'int-1' });
    event({ id: 'e2', org: 'org-a', actor: 'bob', at: '2026-10-02 10:00:00', subject: 'int-2' });
    event({
      id: 'e3',
      org: 'org-a',
      actor: null,
      at: '2026-10-03 10:00:00',
      action: 'integration.auto_pause',
      subject: 'int-1',
    });
    event({
      id: 'e4',
      org: 'org-a',
      actor: 'alice',
      at: '2026-10-04 10:00:00',
      action: 'source.update',
      subjectType: 'source',
      subject: 'src-1',
      correlation: 'req-abc-1234',
    });
    event({
      id: 'e5',
      org: 'org-a',
      actor: 'dave',
      at: '2026-10-05 10:00:00',
      action: 'access.denied',
      outcome: 'denied',
      subjectType: 'capability',
      subject: 'delivery.replay',
    });
    event({ id: 'b1', org: 'org-b', actor: 'carol', at: '2026-10-06 10:00:00', subject: 'int-1' });
  });

  it('filters by a current member, and by the system for events no person took', async () => {
    expect(await ids('?actor=alice')).toEqual(['e4', 'e1']);
    expect(await ids('?actor=bob')).toEqual(['e2']);
    expect(await ids('?actor=system')).toEqual(['e3']);
  });

  it('matches nothing for someone who is not a member here, so it cannot probe other workspaces', async () => {
    // dave's probe is in this log, but dave never belonged to it; carol is a member of ANOTHER workspace.
    expect(await ids('?actor=dave')).toEqual([]);
    expect(await ids('?actor=carol')).toEqual([]);
    expect(await ids('?actor=nobody-at-all')).toEqual([]);
  });

  it('filters by the thing an event is about, by id and by kind', async () => {
    expect(await ids('?target=int-1')).toEqual(['e3', 'e1']);
    expect(await ids('?targetType=source')).toEqual(['e4']);
    expect(await ids('?targetType=integration&target=int-2')).toEqual(['e2']);
    expect(await ids('?target=delivery.replay&targetType=capability')).toEqual(['e5']);
  });

  it('filters by request id, and an id from another workspace finds nothing here', async () => {
    expect(await ids('?correlationId=req-abc-1234')).toEqual(['e4']);
    event({ id: 'b2', org: 'org-b', at: '2026-10-07 10:00:00', correlation: 'req-only-b-1' });
    expect(await ids('?correlationId=req-only-b-1')).toEqual([]);
    expect(await ids('?correlationId=req-only-b-1', 'carol')).toEqual(['b2']);
  });

  it('combines filters and still stays inside the workspace', async () => {
    expect(await ids('?actor=alice&targetType=integration')).toEqual(['e1']);
    expect(await ids('?actor=alice&action=source.update&from=2026-10-04&to=2026-10-04')).toEqual(['e4']);
  });

  it('rejects malformed values with field errors and never puts them into SQL', async () => {
    for (const bad of [
      '?actor=a b',
      `?actor=${'x'.repeat(65)}`,
      '?actor=x%27%20OR%201%3D1',
      '?targetType=nope',
      `?target=${'y'.repeat(201)}`,
      '?target=a%00b',
      '?correlationId=%27%3B--',
      '?correlationId=ab',
    ]) {
      expect((await get(`/api/audit${bad}`)).status, bad).toBe(422);
    }
    const parsed = parseAuditFilters((n) => ({ actor: "x' OR 1=1" })[n]);
    expect(parsed.ok).toBe(false);
  });

  it('binds every filter value and starts from the workspace', () => {
    const parsed = parseAuditFilters(
      (n) => ({ actor: 'alice', target: 'int-1', correlationId: 'req-abc-1234' })[n],
    );
    if (!parsed.ok) throw new Error('should parse');
    const q = buildAuditQuery('org-a', parsed.value);
    expect(q.sql).toContain('e.organization_id = ?');
    expect(q.sql).not.toContain('alice');
    expect(q.sql).not.toContain('int-1');
    expect(q.values[0]).toBe('org-a');
    // The member lookup repeats the tenant predicate.
    expect(q.sql).toContain('m.organization_id = e.organization_id');
  });
});

describe('total', () => {
  beforeEach(() => {
    for (let i = 0; i < 7; i++)
      event({ id: `t${i}`, org: 'org-a', actor: 'alice', at: `2026-10-0${i + 1} 10:00:00` });
    event({ id: 'tb', org: 'org-b', actor: 'carol', at: '2026-10-01 10:00:00' });
  });

  it('counts what the filters match in this workspace only, on the first page', async () => {
    const first = await (
      await get('/api/audit?limit=3')
    ).json<{
      total: number;
      totalCapped: boolean;
      nextCursor: string;
    }>();
    expect(first.total).toBe(7);
    expect(first.totalCapped).toBe(false);
    const filtered = await (await get('/api/audit?from=2026-10-05')).json<{ total: number }>();
    expect(filtered.total).toBe(3);
    const none = await (await get('/api/audit?action=source.delete')).json<{ total: number }>();
    expect(none.total).toBe(0);
  });

  it('is not recomputed on later pages', async () => {
    const first = await (await get('/api/audit?limit=3')).json<{ nextCursor: string }>();
    const next = await (
      await get(`/api/audit?limit=3&cursor=${first.nextCursor}`)
    ).json<{
      total: number | null;
      events: unknown[];
    }>();
    expect(next.total).toBeNull();
    expect(next.events).toHaveLength(3);
  });

  it('is bounded: past the cap it says "at least", and the count stops there', async () => {
    const insert = db.raw.prepare(
      `INSERT INTO audit_events(id,organization_id,action,subject_type,outcome,created_at) VALUES(?,?,?,?,?,?)`,
    );
    db.raw.exec('BEGIN');
    for (let i = 0; i < AUDIT_TOTAL_CAP + 5; i++)
      insert.run(`bulk${i}`, 'org-a', 'integration.update', 'integration', 'success', '2026-09-01 00:00:00');
    db.raw.exec('COMMIT');
    const body = await (await get('/api/audit?limit=1')).json<{ total: number; totalCapped: boolean }>();
    expect(body.total).toBe(AUDIT_TOTAL_CAP);
    expect(body.totalCapped).toBe(true);
  });
});

describe('field diff', () => {
  it('rebuilds before and after from the stored keys, for the non-secret fields only', () => {
    const meta = JSON.stringify({
      fields: ['enabled', 'repo', 'eventTypes', 'credentials'],
      enabled: false,
      previousEnabled: true,
      repo: 'acme/new',
      previousRepo: 'acme/old',
      eventTypesAdded: ['push'],
      eventTypesRemoved: ['issues.opened'],
      webhookUrl: 'https://hooks.example/never-shown',
    });
    expect(changesOf('integration.update', meta)).toEqual([
      { field: 'enabled', kind: 'value', before: true, after: false },
      { field: 'repo', kind: 'value', before: 'acme/old', after: 'acme/new' },
      { field: 'eventTypes', kind: 'list', added: ['push'], removed: ['issues.opened'] },
    ]);
    expect(JSON.stringify(changesOf('integration.update', meta))).not.toContain('never-shown');
  });

  it('shows nothing it cannot back: missing or mistyped before values, other actions, bad JSON', () => {
    expect(changesOf('integration.update', JSON.stringify({ enabled: true }))).toEqual([]);
    expect(
      changesOf('integration.update', JSON.stringify({ enabled: true, previousEnabled: 'yes' })),
    ).toEqual([]);
    expect(changesOf('integration.update', JSON.stringify({ enabled: true, previousEnabled: true }))).toEqual(
      [],
    );
    expect(
      changesOf('integration.delete', JSON.stringify({ enabled: true, previousEnabled: false })),
    ).toEqual([]);
    expect(changesOf('source.update', JSON.stringify({ repo: 'a/b', previousRepo: 'a/c' }))).toEqual([]);
    expect(changesOf('integration.update', '{not json')).toEqual([]);
    expect(changesOf('integration.update', '[]')).toEqual([]);
  });

  it('is written by the writer only for fields that really changed', () => {
    expect(
      diffMetadata({ enabled: true, repo: 'a/b', eventTypes: ['x'] }, { enabled: true, repo: 'a/b' }),
    ).toEqual({});
    expect(diffMetadata({ enabled: true }, { enabled: false })).toEqual({ previousEnabled: true });
    expect(diffMetadata({ eventTypes: ['a', 'b'] }, { eventTypes: ['b', 'c', 'c'] })).toEqual({
      eventTypesAdded: ['c'],
      eventTypesRemoved: ['a'],
    });
    const many = Array.from({ length: 30 }, (_, i) => `t${i}`);
    expect((diffMetadata({ eventTypes: [] }, { eventTypes: many }).eventTypesAdded as string[]).length).toBe(
      10,
    );
  });

  it('is shown through the API from a real update, with the secret fields left out', async () => {
    // The row is written by the real route; here the metadata is what an update records.
    event({
      id: 'u1',
      org: 'org-a',
      actor: 'alice',
      at: '2026-10-01 10:00:00',
      metadata: { fields: ['enabled', 'credentials'], enabled: false, previousEnabled: true },
    });
    const body = await (
      await get('/api/audit')
    ).json<{
      events: { changes: unknown[]; summary: { key: string }[] }[];
    }>();
    expect(body.events[0]?.changes).toEqual([
      { field: 'enabled', kind: 'value', before: true, after: false },
    ]);
    expect(JSON.stringify(body)).not.toContain('previousEnabled');
  });
});

describe('request ids', () => {
  it('stamps the request id on the audit row of a change and returns it', async () => {
    const created = await request('POST', '/api/sources', 'alice', { name: 'CI pipeline' });
    expect(created.status).toBe(201);
    const sourceId = (await created.json<{ source: { id: string } }>()).source.id;
    const res = await request('PATCH', `/api/sources/${sourceId}`, 'alice', { enabled: false });
    const requestId = res.headers.get('x-request-id');
    expect(res.status).toBe(200);
    expect(requestId).toBeTruthy();
    const row = db.raw
      .prepare(
        "SELECT correlation_id AS c, metadata_json AS m FROM audit_events WHERE action='source.update'",
      )
      .get() as { c: string; m: string };
    expect(row.c).toBe(requestId);
    expect(JSON.parse(row.m)).toMatchObject({ enabled: false, previousEnabled: true });
    // And it can be found again by that id, with the diff.
    const found = await (
      await get(`/api/audit?correlationId=${requestId}`)
    ).json<{
      events: { correlationId: string; changes: unknown[] }[];
      total: number;
    }>();
    expect(found.total).toBe(1);
    expect(found.events[0]?.correlationId).toBe(requestId);
    expect(found.events[0]?.changes).toEqual([
      { field: 'enabled', kind: 'value', before: true, after: false },
    ]);
  });

  it('leaves it null for rows written before it was recorded', async () => {
    event({ id: 'old', org: 'org-a', actor: 'alice', at: '2026-10-01 10:00:00' });
    const body = await (await get('/api/audit')).json<{ events: { correlationId: string | null }[] }>();
    expect(body.events[0]?.correlationId).toBeNull();
  });
});

describe('fails closed', () => {
  it('answers 503 with no events, and no detail, when the read fails', async () => {
    event({ id: 'a1', org: 'org-a', actor: 'alice', at: '2026-10-01 10:00:00' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    db.raw.exec('ALTER TABLE audit_events RENAME TO audit_events_gone');
    const res = await get('/api/audit');
    expect(res.status).toBe(503);
    const text = await res.text();
    const body = JSON.parse(text) as { error: string; correlation_id: string; events?: unknown };
    expect(body.events).toBeUndefined();
    expect(body.correlation_id).toBe(res.headers.get('x-request-id'));
    expect(text).not.toMatch(/audit_events|sqlite|SELECT/i);
    const logged = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('audit_read_failed');
    expect(logged).not.toMatch(/SELECT/);
    error.mockRestore();
  });

  it('answers 503, not a smaller page, when the count cannot be produced', async () => {
    event({ id: 'a1', org: 'org-a', actor: 'alice', at: '2026-10-01 10:00:00' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const real = db.d1;
    const failingCount = new Proxy(real, {
      get: (target, prop, receiver) =>
        prop === 'prepare'
          ? (sql: string) =>
              /SELECT COUNT\(\*\) AS n FROM \(SELECT 1 FROM audit_events/.test(sql)
                ? { bind: () => ({ first: () => Promise.reject(new Error('D1 down')) }) }
                : target.prepare(sql)
          : (Reflect.get(target, prop, receiver) as unknown),
    });
    const res = await get('/api/audit', 'alice', { DB: failingCount });
    error.mockRestore();
    expect(res.status).toBe(503);
    expect(await res.json()).not.toHaveProperty('events');
  });

  it('refuses the whole page when a row is not this workspace’s, however it got there', async () => {
    event({ id: 'a1', org: 'org-a', actor: 'alice', at: '2026-10-01 10:00:00' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const real = db.d1;
    // A query that ignores the tenant predicate would return another workspace's row; simulate it.
    const leaky = new Proxy(real, {
      get: (target, prop, receiver) =>
        prop === 'prepare'
          ? (sql: string) => {
              const stmt = target.prepare(sql);
              if (!/FROM audit_events e\s+LEFT JOIN/.test(sql)) return stmt;
              return {
                bind: (...v: unknown[]) => ({
                  all: async () => {
                    const out = await stmt.bind(...v).all<{ organization_id: string }>();
                    return {
                      ...out,
                      results: out.results.map((r) => ({ ...r, organization_id: 'org-b' })),
                    };
                  },
                }),
              };
            }
          : (Reflect.get(target, prop, receiver) as unknown),
    });
    const res = await get('/api/audit', 'alice', { DB: leaky });
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain('a1');
    expect(error.mock.calls.map((c) => String(c[0])).join('')).toContain('tenant_mismatch');
    error.mockRestore();
  });

  it('keeps answering 429 for a limited reader, and 403 for a non-admin, exactly as before', async () => {
    expect((await get('/api/audit', 'bob')).status).toBe(403);
    let last = 200;
    for (let i = 0; i < 121; i++) last = (await get('/api/audit')).status;
    expect(last).toBe(429);
  });
});
