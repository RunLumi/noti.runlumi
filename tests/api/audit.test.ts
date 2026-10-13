import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../../src/env';
import { AUDIT_ACTIONS } from '../../src/audit/audit';
import { SUMMARY_FIELDS, safeText, summarise } from '../../src/api/audit-view';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

/** GET /api/audit: admin only, workspace-scoped, paged, allow-listed, no PII beyond a name. */
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

function get(path: string, as: string | null, bindings: Partial<Bindings> = {}) {
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, { headers: as ? { 'x-test-user': as } : {} }),
    { ...env, ...bindings },
    { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
  );
}

interface Seed {
  id: string;
  org: string | null;
  actor?: string | null;
  action?: string;
  outcome?: string;
  at: string;
  metadata?: unknown;
  subject?: string | null;
}

function event(e: Seed): void {
  db.raw
    .prepare(
      `INSERT INTO audit_events(id,organization_id,actor_id,action,subject_type,subject_id,outcome,ip,user_agent,metadata_json,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      e.id,
      e.org,
      e.actor ?? null,
      e.action ?? 'integration.update',
      'integration',
      e.subject === undefined ? 'int-1' : e.subject,
      e.outcome ?? 'success',
      '203.0.113.9',
      'Mozilla/5.0 (X11) Probe/1.0',
      JSON.stringify(e.metadata ?? {}),
      e.at,
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
  env = { DB: db.d1, APP_ORIGIN: ORIGIN } as unknown as Bindings;
});

describe('authorization', () => {
  it('refuses a plain member, naming the capability, and audits the denial', async () => {
    const res = await get('/api/audit', 'bob');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Missing capability: audit.read' });
    const denial = db.raw
      .prepare(
        "SELECT action,subject_id AS s,organization_id AS o FROM audit_events WHERE action='access.denied'",
      )
      .get();
    expect(denial).toEqual({ action: 'access.denied', s: 'audit.read', o: 'org-a' });
  });

  it('requires a session', async () => {
    expect((await get('/api/audit', null)).status).toBe(401);
  });

  it('answers a workspace the caller is not in with a plain 404', async () => {
    expect((await get('/api/audit?org=org-b', 'alice')).status).toBe(404);
  });
});

describe('tenant isolation', () => {
  it('returns only the events of the resolved workspace, whatever the filters say', async () => {
    event({ id: 'a1', org: 'org-a', actor: 'alice', at: '2026-10-01 10:00:00' });
    event({ id: 'b1', org: 'org-b', actor: 'carol', at: '2026-10-01 10:00:01', subject: 'secret-b' });
    event({ id: 'n1', org: null, actor: 'carol', at: '2026-10-01 10:00:02' });
    const res = await get('/api/audit?limit=100', 'alice');
    const body = await res.json<{ organizationId: string; events: { id: string }[] }>();
    expect(body.organizationId).toBe('org-a');
    expect(body.events.map((e) => e.id)).toEqual(['a1']);
    const other = await (await get('/api/audit', 'carol')).json<{ events: { id: string }[] }>();
    expect(other.events.map((e) => e.id)).toEqual(['b1']);
  });

  it('does not let a cursor reach into another workspace', async () => {
    for (const n of [1, 2, 3])
      event({ id: `a${n}`, org: 'org-a', actor: 'alice', at: `2026-10-0${n} 10:00:00` });
    event({ id: 'b1', org: 'org-b', at: '2026-10-01 09:00:00' });
    const first = await (await get('/api/audit?limit=1', 'alice')).json<{ nextCursor: string }>();
    const page = await (
      await get(`/api/audit?limit=5&cursor=${first.nextCursor}`, 'alice')
    ).json<{
      events: { id: string }[];
    }>();
    expect(page.events.map((e) => e.id)).toEqual(['a2', 'a1']);
  });
});

describe('paging and filters', () => {
  beforeEach(() => {
    event({
      id: 'e1',
      org: 'org-a',
      actor: 'alice',
      at: '2026-10-01 10:00:00',
      action: 'integration.create',
    });
    event({ id: 'e2', org: 'org-a', actor: 'alice', at: '2026-10-02 10:00:00', action: 'source.create' });
    event({
      id: 'e3',
      org: 'org-a',
      actor: 'bob',
      at: '2026-10-02 10:00:00',
      action: 'access.denied',
      outcome: 'denied',
    });
    event({
      id: 'e4',
      org: 'org-a',
      actor: 'alice',
      at: '2026-10-03 10:00:00',
      action: 'integration.delete',
    });
  });

  const ids = async (query: string) =>
    (await (await get(`/api/audit${query}`, 'alice')).json<{ events: { id: string }[] }>()).events.map(
      (e) => e.id,
    );

  it('is newest first, ordered by (created_at, id)', async () => {
    expect(await ids('')).toEqual(['e4', 'e3', 'e2', 'e1']);
  });

  it('pages by cursor without skipping or repeating rows that share a timestamp', async () => {
    const seen: string[] = [];
    let cursor = '';
    for (let i = 0; i < 5; i++) {
      const body = await (
        await get(`/api/audit?limit=1${cursor}`, 'alice')
      ).json<{
        events: { id: string }[];
        nextCursor: string | null;
      }>();
      seen.push(...body.events.map((e) => e.id));
      if (!body.nextCursor) break;
      cursor = `&cursor=${body.nextCursor}`;
    }
    expect(seen).toEqual(['e4', 'e3', 'e2', 'e1']);
  });

  it('filters by action, outcome and date range', async () => {
    expect(await ids('?action=source.create')).toEqual(['e2']);
    expect(await ids('?outcome=denied')).toEqual(['e3']);
    expect(await ids('?from=2026-10-02&to=2026-10-02')).toEqual(['e3', 'e2']);
    expect(await ids('?from=2026-10-03')).toEqual(['e4']);
  });

  it('caps the page size at 100 and rejects invalid input with field errors', async () => {
    for (let i = 0; i < 105; i++)
      event({ id: `x${String(i).padStart(3, '0')}`, org: 'org-a', at: '2026-09-01 00:00:00' });
    const body = await (
      await get('/api/audit?limit=1000', 'alice')
    ).json<{
      events: unknown[];
      nextCursor: string | null;
    }>();
    expect(body.events).toHaveLength(100);
    expect(body.nextCursor).not.toBeNull();
    for (const bad of ['?action=nope', '?outcome=maybe', '?from=yesterday', '?cursor=zzz', '?limit=0']) {
      expect((await get(`/api/audit${bad}`, 'alice')).status).toBe(422);
    }
  });

  it('is rate limited', async () => {
    let last = 200;
    for (let i = 0; i < 121; i++) last = (await get('/api/audit', 'alice')).status;
    expect(last).toBe(429);
  });

  it('states the retention it applies', async () => {
    const body = await (
      await get('/api/audit', 'alice', { AUDIT_RETENTION_DAYS: '400' })
    ).json<{
      retentionDays: number;
    }>();
    expect(body.retentionDays).toBe(400);
  });
});

describe('what a row discloses', () => {
  it('shows a current member by name only, never an email, and never an IP or user agent', async () => {
    event({ id: 'a1', org: 'org-a', actor: 'bob', at: '2026-10-01 10:00:00' });
    const text = await (await get('/api/audit', 'alice')).text();
    expect(text).toContain('Name of bob');
    expect(text).not.toContain('@example.test');
    expect(text).not.toContain('203.0.113.9');
    expect(text).not.toContain('Probe/1.0');
    expect(text).not.toMatch(/"ip"|user_?agent/i);
  });

  it('hides the identity of an outsider whose probe was recorded here and of a former member', async () => {
    event({
      id: 'probe',
      org: 'org-a',
      actor: 'dave',
      at: '2026-10-01 10:00:00',
      action: 'access.denied',
      outcome: 'denied',
    });
    event({ id: 'gone', org: 'org-a', actor: 'carol', at: '2026-10-01 10:00:01' });
    event({ id: 'system', org: 'org-a', actor: null, at: '2026-10-01 10:00:02' });
    const body = await (
      await get('/api/audit', 'alice')
    ).json<{
      events: { id: string; actor: unknown }[];
    }>();
    const actor = (id: string) => body.events.find((e) => e.id === id)?.actor;
    expect(actor('probe')).toEqual({ kind: 'other' });
    expect(actor('gone')).toEqual({ kind: 'other' });
    expect(actor('system')).toEqual({ kind: 'system' });
    const text = JSON.stringify(body);
    expect(text).not.toContain('Name of dave');
    expect(text).not.toContain('Name of carol');
  });

  it('returns metadata only through the allow-list', async () => {
    event({
      id: 'm1',
      org: 'org-a',
      actor: 'alice',
      at: '2026-10-01 10:00:00',
      action: 'integration.create',
      metadata: {
        repo: 'acme/web',
        destination: 'slack',
        destinationHost: 'hooks.slack.com',
        signed: true,
        eventTypes: ['push'],
        webhookUrl: 'https://hooks.slack.com/services/never/shown',
        token: 'never-shown',
        nested: { a: 1 },
      },
    });
    const text = await (await get('/api/audit', 'alice')).text();
    expect(text).toContain('acme/web');
    expect(text).toContain('hooks.slack.com');
    expect(text).not.toContain('never');
    expect(text).not.toContain('nested');
  });
});

describe('summarise', () => {
  it('drops wrong types, unknown keys, unknown actions and malformed JSON', () => {
    expect(summarise('integration.delete', '{"repo":5,"destination":"slack","x":1}')).toEqual([
      { key: 'destination', value: 'slack' },
    ]);
    expect(summarise('from.the.future', '{"repo":"a/b"}')).toEqual([]);
    expect(summarise('integration.delete', '{not json')).toEqual([]);
    expect(summarise('integration.delete', '[1,2]')).toEqual([]);
    expect(summarise('integration.delete', '{"__proto__":{"repo":"x"}}')).toEqual([]);
  });

  it('truncates long values and lists, and strips control and bidi characters', () => {
    const [item] = summarise('integration.delete', JSON.stringify({ repo: 'a'.repeat(500) }));
    expect((item?.value as string).length).toBeLessThanOrEqual(120);
    const list = summarise(
      'github.installation.lifecycle',
      JSON.stringify({ added: Array.from({ length: 50 }, (_, i) => `r${i}`) }),
    );
    expect((list[0]?.value as string[]).length).toBe(10);
    expect(safeText('ab\u202ecd\u0007\u200bef\nxy')).toBe('abcdefxy');
  });

  it('has an allow-list entry for every action the application records', () => {
    expect(Object.keys(SUMMARY_FIELDS).sort()).toEqual([...AUDIT_ACTIONS].sort());
  });
});
