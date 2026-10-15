import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOT_ENV } from '../support/boot-env';
import type { Bindings } from '../../src/env';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

/**
 * GET /api/workspace/invitations and POST /api/workspace/invitations/:id/cancel (ADR 0045).
 *
 * The session is read from the real `session` row, as Better Auth does, and the rest is the real Worker over
 * the real migrations. What is asserted: only an admin of the workspace named by `?org=` sees or cancels its
 * invitations; a workspace the caller is not in answers exactly like one that does not exist; an invitation
 * of another workspace is never read or changed; a cancel and its audit row commit together.
 */
const state: { raw: FakeD1['raw'] | null } = vi.hoisted(() => ({ raw: null }));

vi.mock('../../src/auth/better-auth', () => ({
  createAuth: () => ({
    api: {
      getSession: ({ headers }: { headers: Headers }) => {
        const id = headers.get('x-test-user');
        if (!id) return Promise.resolve(null);
        const row = state.raw
          ?.prepare('SELECT active_organization_id AS a FROM "session" WHERE id=?')
          .get(`sess-${id}`) as { a: string | null } | undefined;
        return Promise.resolve({
          user: { id, email: `${id}@example.test`, emailVerified: true, name: id },
          session: { id: `sess-${id}`, activeOrganizationId: row?.a ?? null },
        });
      },
    },
    handler: () => new Response(null, { status: 404 }),
  }),
}));

const { default: worker } = await import('../../src/index');

const ORIGIN = 'https://noti.test';
const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;
// The schema stores timestamps as epoch milliseconds (`timestamp_ms`).
const NOW = Date.now();
const DAY = 86_400_000;
const SEC = 1000;

let db: FakeD1;
let env: Bindings;

async function call(
  method: 'GET' | 'POST',
  path: string,
  as: string | null,
  init: { origin?: string | null } = {},
): Promise<Response> {
  const headers = new Headers();
  if (as) headers.set('x-test-user', as);
  if (init.origin !== null) headers.set('origin', init.origin ?? ORIGIN);
  if (method === 'POST') headers.set('content-type', 'application/json');
  return await worker.fetch(
    new Request(`${ORIGIN}${path}`, { method, headers, body: method === 'POST' ? '{}' : null }),
    env,
    ctx,
  );
}

const list = (as: string | null, org?: string) =>
  call('GET', `/api/workspace/invitations${org ? `?org=${org}` : ''}`, as);
const cancel = (as: string | null, id: string, org?: string, init?: { origin?: string | null }) =>
  call(
    'POST',
    `/api/workspace/invitations/${encodeURIComponent(id)}/cancel${org ? `?org=${org}` : ''}`,
    as,
    init,
  );

const statusOf = (id: string) =>
  (db.raw.prepare('SELECT status FROM invitation WHERE id=?').get(id) as { status: string }).status;

interface AuditRow {
  action: string;
  actor_id: string | null;
  organization_id: string | null;
  subject_type: string;
  subject_id: string | null;
  outcome: string;
  metadata_json: string;
}
const auditRows = (action: string): AuditRow[] =>
  db.raw
    .prepare(
      'SELECT action, actor_id, organization_id, subject_type, subject_id, outcome, metadata_json FROM audit_events WHERE action=? ORDER BY created_at, rowid',
    )
    .all(action) as unknown as AuditRow[];

function invite(
  id: string,
  org: string,
  email: string,
  opts: { role?: string | null; status?: string; createdAgo?: number; expiresIn?: number } = {},
) {
  db.raw
    .prepare(
      'INSERT INTO invitation(id,organization_id,email,role,status,expires_at,inviter_id,created_at) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run(
      id,
      org,
      email,
      opts.role === undefined ? 'member' : opts.role,
      opts.status ?? 'pending',
      NOW + (opts.expiresIn ?? 7 * DAY),
      'admin',
      NOW - (opts.createdAgo ?? 3600 * SEC),
    );
}

beforeEach(() => {
  db = createFakeD1();
  state.raw = db.raw;
  for (const id of ['admin', 'member', 'outsider']) {
    db.raw
      .prepare('INSERT INTO "user"(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(id, id, `${id}@example.test`, 1, 1, 1);
    db.raw
      .prepare('INSERT INTO "session"(id,user_id,token,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(`sess-${id}`, id, `t-${id}`, 9_999_999_999, 1, 1);
  }
  for (const org of ['org-a', 'org-b', 'org-private']) seedOrganization(db.raw, org);
  const join = db.raw.prepare(
    'INSERT INTO "member"(id,user_id,organization_id,role,created_at) VALUES(?,?,?,?,?)',
  );
  join.run('m1', 'admin', 'org-a', 'admin', 1);
  join.run('m2', 'admin', 'org-b', 'admin', 2);
  join.run('m3', 'member', 'org-a', 'member', 1);
  join.run('m4', 'outsider', 'org-private', 'admin', 1);
  db.raw.prepare('UPDATE "session" SET active_organization_id=? WHERE id=?').run('org-a', 'sess-admin');

  invite('inv-a-new', 'org-a', 'new@example.test', {
    role: 'admin',
    createdAgo: 100 * SEC,
    expiresIn: 2 * DAY,
  });
  invite('inv-a-old', 'org-a', 'old@example.test', { createdAgo: 9 * DAY, expiresIn: -DAY });
  invite('inv-a-done', 'org-a', 'done@example.test', { status: 'accepted' });
  invite('inv-a-gone', 'org-a', 'gone@example.test', { status: 'canceled' });
  invite('inv-b-1', 'org-b', 'b-only@example.test');
  invite('inv-private', 'org-private', 'private@example.test');

  env = { ...BOOT_ENV, DB: db.d1, APP_ORIGIN: ORIGIN } as unknown as Bindings;
});

describe('GET /api/workspace/invitations', () => {
  it('lists only the pending invitations of the workspace, newest first, with role, sent and expiry', async () => {
    const res = await list('admin', 'org-a');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json<{
      organizationId: string;
      invitations: {
        id: string;
        email: string;
        role: string | null;
        createdAt: string;
        expiresAt: string;
        expired: boolean;
      }[];
      truncated: boolean;
    }>();
    expect(body.organizationId).toBe('org-a');
    expect(body.truncated).toBe(false);
    expect(body.invitations.map((i) => i.id)).toEqual(['inv-a-new', 'inv-a-old']);
    expect(body.invitations[0]).toEqual({
      id: 'inv-a-new',
      email: 'new@example.test',
      role: 'admin',
      createdAt: new Date(NOW - 100 * SEC).toISOString(),
      expiresAt: new Date(NOW + 2 * DAY).toISOString(),
      expired: false,
    });
    expect(body.invitations[1]?.expired).toBe(true);
  });

  it('never shows another workspace, accepted, rejected or cancelled invitations', async () => {
    const text = await (await list('admin', 'org-a')).text();
    for (const hidden of [
      'b-only@example.test',
      'private@example.test',
      'done@example.test',
      'gone@example.test',
    ])
      expect(text).not.toContain(hidden);
  });

  it('answers a workspace the caller is not in exactly like one that does not exist', async () => {
    const real = await list('outsider', 'org-a');
    const missing = await list('outsider', 'org-does-not-exist');
    expect(real.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await real.text()).toBe(await missing.text());
  });

  it('refuses a plain member of the workspace, and records the refusal in that workspace log', async () => {
    const res = await list('member', 'org-a');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Missing capability: invitation.read' });
    const denials = db.raw
      .prepare("SELECT organization_id, actor_id, subject_id FROM audit_events WHERE action='access.denied'")
      .all() as { organization_id: string; actor_id: string; subject_id: string }[];
    expect(denials).toEqual([
      { organization_id: 'org-a', actor_id: 'member', subject_id: 'invitation.read' },
    ]);
  });

  it('decides by the role in the workspace asked for: admin of org-a, member of org-b is refused in org-b', async () => {
    // Another admin keeps org-b administered (the last-admin trigger refuses a demotion otherwise).
    db.raw
      .prepare('INSERT INTO "user"(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run('b-admin', 'b-admin', 'b-admin@example.test', 1, 1, 1);
    db.raw
      .prepare('INSERT INTO "member"(id,user_id,organization_id,role,created_at) VALUES(?,?,?,?,?)')
      .run('m5', 'b-admin', 'org-b', 'admin', 1);
    db.raw.prepare('UPDATE member SET role=? WHERE id=?').run('member', 'm2');
    expect((await list('admin', 'org-a')).status).toBe(200);
    expect((await list('admin', 'org-b')).status).toBe(403);
  });

  it('requires a verified session', async () => {
    expect((await list(null, 'org-a')).status).toBe(401);
  });

  it('pages at 100 and says so when there are more', async () => {
    for (let i = 0; i < 101; i++)
      invite(`inv-bulk-${i}`, 'org-a', `bulk${i}@example.test`, { createdAgo: 1000 + i });
    const body = await (await list('admin', 'org-a')).json<{ invitations: unknown[]; truncated: boolean }>();
    expect(body.invitations).toHaveLength(100);
    expect(body.truncated).toBe(true);
  });
});

describe('POST /api/workspace/invitations/:id/cancel', () => {
  it('cancels a pending invitation and writes its audit row in the same change', async () => {
    const res = await cancel('admin', 'inv-a-new', 'org-a');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: true, id: 'inv-a-new' });
    expect(statusOf('inv-a-new')).toBe('canceled');
    expect(auditRows('member.invite.cancel')).toEqual([
      {
        action: 'member.invite.cancel',
        actor_id: 'admin',
        organization_id: 'org-a',
        subject_type: 'invitation',
        subject_id: 'inv-a-new',
        outcome: 'success',
        metadata_json: '{"role":"admin"}',
      },
    ]);
    const after = await (await list('admin', 'org-a')).json<{ invitations: { id: string }[] }>();
    expect(after.invitations.map((i) => i.id)).toEqual(['inv-a-old']);
  });

  it('can cancel an expired invitation, so an admin can clear it out', async () => {
    expect((await cancel('admin', 'inv-a-old', 'org-a')).status).toBe(200);
    expect(statusOf('inv-a-old')).toBe('canceled');
  });

  it('changes nothing and writes no second row when the invitation is already finished or cancelled again', async () => {
    expect((await cancel('admin', 'inv-a-done', 'org-a')).status).toBe(404);
    expect(statusOf('inv-a-done')).toBe('accepted');
    expect((await cancel('admin', 'inv-a-new', 'org-a')).status).toBe(200);
    expect((await cancel('admin', 'inv-a-new', 'org-a')).status).toBe(404);
    expect(auditRows('member.invite.cancel')).toHaveLength(1);
  });

  it('refuses a plain member, changes nothing, and records the refusal', async () => {
    const res = await cancel('member', 'inv-a-new', 'org-a');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Missing capability: invitation.cancel' });
    expect(statusOf('inv-a-new')).toBe('pending');
    expect(auditRows('member.invite.cancel')).toHaveLength(0);
    expect(
      db.raw
        .prepare(
          "SELECT COUNT(*) AS n FROM audit_events WHERE action='access.denied' AND actor_id='member' AND organization_id='org-a'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });

  it('does not cancel another workspace invitation by naming it under this workspace', async () => {
    const res = await cancel('admin', 'inv-b-1', 'org-a');
    expect(res.status).toBe(404);
    expect(statusOf('inv-b-1')).toBe('pending');
    expect(auditRows('member.invite.cancel')).toHaveLength(0);
    // Recorded in the caller's own workspace log, with no id and nothing of the other workspace.
    const denial = db.raw
      .prepare(
        "SELECT organization_id, subject_id, metadata_json FROM audit_events WHERE action='access.denied'",
      )
      .all() as { organization_id: string; subject_id: string | null; metadata_json: string }[];
    expect(denial).toEqual([
      { organization_id: 'org-a', subject_id: null, metadata_json: '{"reason":"not_in_workspace"}' },
    ]);
  });

  it('answers a foreign invitation id exactly like a missing one', async () => {
    const foreign = await cancel('admin', 'inv-b-1', 'org-a');
    const missing = await cancel('admin', 'no-such-invitation', 'org-a');
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).toBe(await missing.text());
  });

  it('refuses a caller who is not in the workspace named, and cancels nothing in it', async () => {
    const res = await cancel('outsider', 'inv-a-new', 'org-a');
    expect(res.status).toBe(404);
    expect(statusOf('inv-a-new')).toBe('pending');
    expect(auditRows('member.invite.cancel')).toHaveLength(0);
  });

  it('refuses a cross-site request and a missing Origin, changing nothing', async () => {
    expect((await cancel('admin', 'inv-a-new', 'org-a', { origin: 'https://evil.test' })).status).toBe(403);
    expect((await cancel('admin', 'inv-a-new', 'org-a', { origin: null })).status).toBe(403);
    expect(statusOf('inv-a-new')).toBe('pending');
  });

  it('requires a verified session', async () => {
    expect((await cancel(null, 'inv-a-new', 'org-a')).status).toBe(401);
  });

  it('is atomic: when the audit row cannot be written, the invitation stays pending', async () => {
    db.raw.exec(
      "CREATE TRIGGER fail_cancel_audit BEFORE INSERT ON audit_events WHEN NEW.action='member.invite.cancel' BEGIN SELECT RAISE(ABORT, 'audit refused'); END",
    );
    const res = await cancel('admin', 'inv-a-new', 'org-a');
    expect(res.status).toBe(500);
    expect(statusOf('inv-a-new')).toBe('pending');
  });

  it('is rate limited per person', async () => {
    let last = 200;
    for (let i = 0; i < 31; i++) last = (await cancel('admin', `missing-${i}`, 'org-a')).status;
    expect(last).toBe(429);
    expect((await cancel('outsider', 'inv-private', 'org-private')).status).toBe(200);
  });
});
