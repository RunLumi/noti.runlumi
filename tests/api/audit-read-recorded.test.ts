import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOT_ENV } from '../support/boot-env';
import type { Bindings } from '../../src/env';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

/**
 * F236 (ADR 0039): every read of the audit log is itself an audit row, written before the rows are read.
 * The row names the filter fields and whether the page is a later one, never their values, and it is
 * tenant-scoped like everything else. A read that cannot be recorded returns nothing.
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

function get(path: string, as: string) {
  return worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { 'x-test-user': as } }), env, {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext);
}

interface ReadRow {
  id: string;
  organization_id: string;
  actor_id: string;
  action: string;
  subject_type: string;
  subject_id: string;
  outcome: string;
  metadata_json: string;
  correlation_id: string | null;
}

/** The first row of a read, failing the test clearly when there is none. */
function firstRow(rows: ReadRow[]): ReadRow {
  const row = rows[0];
  if (!row) throw new Error('expected an audit.read row');
  return row;
}

const readRows = (org: string): ReadRow[] =>
  db.raw
    .prepare(
      "SELECT id, organization_id, actor_id, action, subject_type, subject_id, outcome, metadata_json, correlation_id FROM audit_events WHERE action='audit.read' AND organization_id=? ORDER BY rowid",
    )
    .all(org) as unknown as ReadRow[];

function seedEvent(id: string, org: string, at: string): void {
  db.raw
    .prepare(
      'INSERT INTO audit_events(id,organization_id,actor_id,action,subject_type,subject_id,outcome,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    )
    .run(id, org, 'alice', 'integration.update', 'integration', 'int-1', 'success', '{}', at);
}

beforeEach(() => {
  // A fixed clock for the rate-limit window; the rows the tests read are seeded with explicit dates.
  vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 14, 12));
  db = createFakeD1();
  for (const id of ['alice', 'bob', 'carol']) {
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an admin read is recorded', () => {
  it('writes one audit.read row for the workspace, naming the filter fields and never their values', async () => {
    seedEvent('e1', 'org-a', '2026-10-01 10:00:00');
    const res = await get('/api/audit?action=integration.update&actor=alice', 'alice');
    expect(res.status).toBe(200);
    const rows = readRows('org-a');
    expect(rows).toHaveLength(1);
    const row = firstRow(rows);
    expect(row).toMatchObject({
      organization_id: 'org-a',
      actor_id: 'alice',
      action: 'audit.read',
      subject_type: 'organization',
      subject_id: 'org-a',
      outcome: 'success',
    });
    expect(JSON.parse(row.metadata_json)).toEqual({ filters: ['action', 'actor'], continued: false });
    // No filter value (an id, an action name typed by a person) and no seeded row reaches the metadata.
    expect(row.metadata_json).not.toMatch(/alice|integration\.update|e1/);
    // The request id of the read, so the read can be found from its own response.
    expect(row.correlation_id).toBeTruthy();
    expect(res.headers.get('x-request-id')).toBe(row.correlation_id);
  });

  it('records a read with no filter as an empty filter list, not as a missing row', async () => {
    seedEvent('e1', 'org-a', '2026-10-01 10:00:00');
    await get('/api/audit', 'alice');
    expect(JSON.parse(firstRow(readRows('org-a')).metadata_json)).toEqual({ filters: [], continued: false });
  });

  it('names a later page as continued, and each page is its own row', async () => {
    for (let i = 1; i <= 3; i++) seedEvent(`e${i}`, 'org-a', `2026-10-0${i} 10:00:00`);
    const first = await (await get('/api/audit?limit=1', 'alice')).json<{ nextCursor: string }>();
    await get(`/api/audit?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`, 'alice');
    const rows = readRows('org-a').map((r) => JSON.parse(r.metadata_json) as { continued: boolean });
    expect(rows.map((r) => r.continued)).toEqual([false, true]);
  });

  it('shows the read in the log to the admins of that workspace, with its filter names', async () => {
    seedEvent('e1', 'org-a', '2026-10-01 10:00:00');
    await get('/api/audit?outcome=success', 'alice');
    const body = await (
      await get('/api/audit?action=audit.read', 'alice')
    ).json<{
      events: { action: string; summary: { key: string; value: unknown }[] }[];
    }>();
    expect(body.events).toHaveLength(2);
    // The earlier read used `outcome`; the listing above is itself a read that used `action`.
    const newest = body.events.find((e) =>
      e.summary.some((s) => s.key === 'filters' && JSON.stringify(s.value) === JSON.stringify(['outcome'])),
    );
    expect(newest?.summary).toEqual(
      expect.arrayContaining([
        { key: 'filters', value: ['outcome'] },
        { key: 'continued', value: false },
      ]),
    );
  });

  it('is tenant-scoped: each workspace holds its own reads, and nothing of another', async () => {
    await get('/api/audit', 'alice');
    await get('/api/audit', 'carol');
    expect(readRows('org-a').map((r) => r.actor_id)).toEqual(['alice']);
    expect(readRows('org-b').map((r) => r.actor_id)).toEqual(['carol']);
    const carol = await (
      await get('/api/audit?action=audit.read', 'carol')
    ).json<{ organizationId: string; events: { id: string }[] }>();
    expect(carol.organizationId).toBe('org-b');
    // The listing is itself a read, so it holds both of carol's reads (the earlier one and this one), and nothing of org-a.
    expect(carol.events.map((e) => e.id).sort()).toEqual(
      readRows('org-b')
        .map((r) => r.id)
        .sort(),
    );
    expect(readRows('org-b')).toHaveLength(2);
  });
});

describe('what is not recorded', () => {
  it('a member refused the log writes no read row, and the refusal is itself recorded as access.denied', async () => {
    const res = await get('/api/audit', 'bob');
    expect(res.status).toBe(403);
    expect(readRows('org-a')).toEqual([]);
    const denied = db.raw
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_events WHERE action='access.denied' AND organization_id='org-a'",
      )
      .get() as { n: number };
    expect(denied.n).toBeGreaterThanOrEqual(1);
  });

  it('a read refused by the rate limit returns nothing and writes no row', async () => {
    for (let i = 0; i < 120; i++) expect((await get('/api/audit', 'alice')).status).toBe(200);
    const limited = await get('/api/audit', 'alice');
    expect(limited.status).toBe(429);
    expect(readRows('org-a')).toHaveLength(120);
  });
});

describe('a read that cannot be recorded is not answered', () => {
  it('answers 503 with no events, and the log says why in one word', async () => {
    seedEvent('evidence-row-1', 'org-a', '2026-10-01 10:00:00');
    db.raw.exec(
      "CREATE TRIGGER refuse_read_audit BEFORE INSERT ON audit_events WHEN NEW.action='audit.read' BEGIN SELECT RAISE(ABORT,'audit down'); END",
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await get('/api/audit', 'alice');
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain('evidence-row-1');
    expect(JSON.parse(text)).toEqual(expect.objectContaining({ correlation_id: expect.any(String) }));
    expect(JSON.parse(text)).not.toHaveProperty('events');
    const logged = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('read_not_recorded');
    expect(logged).not.toMatch(/INSERT|audit down/);
  });
});
