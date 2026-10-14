import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../../src/env';
import { RETENTION_MATRIX } from '../../src/compliance/retention';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

/**
 * Data-subject access and erasure for the signed-in person (spec 15 F238, docs/DSAR.md).
 * The session is faked through a header; everything else is the real route over the real migrations.
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
                session: {
                  id: `sess-${id}`,
                  activeOrganizationId: null,
                  // Signed in `x-test-session-age-ms` ago (default: just now).
                  createdAt: new Date(Date.now() - Number(headers.get('x-test-session-age-ms') ?? 0)),
                },
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
const sent: Array<{ to: string; subject: string; text: string }> = [];

function call(
  path: string,
  options: {
    as?: string;
    method?: string;
    body?: unknown;
    origin?: string | null;
    ageMs?: number;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.as) headers.set('x-test-user', options.as);
  if (options.ageMs !== undefined) headers.set('x-test-session-age-ms', String(options.ageMs));
  for (const [k, v] of Object.entries(options.headers ?? {})) headers.set(k, v);
  if (options.origin !== null && (options.method ?? 'GET') !== 'GET')
    headers.set('origin', options.origin ?? ORIGIN);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return Promise.resolve(
    worker.fetch(
      new Request(`${ORIGIN}${path}`, {
        method: options.method ?? 'GET',
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      }),
      env,
      { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
    ),
  );
}

const count = (sql: string, ...args: (string | number)[]): number =>
  Number((db.raw.prepare(sql).get(...args) as { n: number }).n);

function addUser(id: string): void {
  db.raw
    .prepare(
      'INSERT INTO "user"(id,name,email,email_verified,image,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
    )
    .run(id, `Name ${id}`, `${id}@example.test`, 1, null, 1, 2);
  db.raw
    .prepare(
      'INSERT INTO "session"(id,user_id,token,expires_at,created_at,updated_at,ip_address,user_agent) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run(`s-${id}`, id, `secret-token-${id}`, 9_999_999_999_999, 1, 1, '203.0.113.9', 'TestAgent/1');
  db.raw
    .prepare(
      'INSERT INTO "account"(id,account_id,provider_id,user_id,password,access_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run(`a-${id}`, id, 'credential', id, 'hash-value-do-not-leak', 'oauth-token-do-not-leak', 1, 1);
  db.raw
    .prepare(
      'INSERT INTO passkey(id,name,public_key,user_id,credential_id,counter,device_type,backed_up,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    )
    .run(`p-${id}`, 'Laptop', 'public-key-do-not-leak', id, `cred-${id}`, 7, 'singleDevice', 0, 1);
}

function join(user: string, org: string, role: 'admin' | 'member'): void {
  db.raw
    .prepare('INSERT INTO "member"(id,user_id,organization_id,role,created_at) VALUES(?,?,?,?,?)')
    .run(`m-${user}-${org}`, user, org, role, 1);
}

beforeEach(() => {
  db = createFakeD1();
  for (const id of ['alice', 'bob', 'solo']) addUser(id);
  seedOrganization(db.raw, 'org-shared');
  seedOrganization(db.raw, 'org-solo');
  join('alice', 'org-shared', 'member');
  join('bob', 'org-shared', 'admin');
  join('solo', 'org-solo', 'admin');
  db.raw
    .prepare(
      `INSERT INTO audit_events(id,organization_id,actor_id,action,subject_type,subject_id,outcome,ip,user_agent,metadata_json)
       VALUES('ev-alice','org-shared','alice','integration.create','integration','int-secret','success','203.0.113.9','TestAgent/1','{"repo":"private/repo"}'),
             ('ev-bob','org-shared','bob','integration.delete','integration','int-bob','success','198.51.100.1','BobAgent','{}')`,
    )
    .run();
  db.raw
    .prepare(
      `INSERT INTO invitation(id,organization_id,email,role,status,expires_at,inviter_id,created_at)
       VALUES('inv-sent','org-shared','third.party@example.test','member','pending',9,'bob',1),
             ('inv-to-alice','org-solo','alice@example.test','member','pending',9,'solo',1)`,
    )
    .run();
  sent.length = 0;
  env = {
    DB: db.d1,
    APP_ORIGIN: ORIGIN,
    AUTH_FROM_EMAIL: 'noreply@example.test',
    AUTH_EMAIL: {
      send: (message: { to: string; subject: string; text: string }) => {
        sent.push(message);
        return Promise.resolve();
      },
    },
  } as unknown as Bindings;
});

describe('GET /api/workspace/me/data-export', () => {
  it('requires a session', async () => {
    expect((await call('/api/workspace/me/data-export')).status).toBe(401);
  });

  it("exports the caller's own data only, with no credential and nobody else's data", async () => {
    const res = await call('/api/workspace/me/data-export', { as: 'alice' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;

    expect(body).toMatchObject({
      format: 'lumi-noti-account-export/v1',
      credentialsIncluded: false,
      user: { id: 'alice', email: 'alice@example.test' },
      memberships: [{ workspace_id: 'org-shared', role: 'member' }],
      sessions: [{ ip_address: '203.0.113.9', user_agent: 'TestAgent/1' }],
      signInMethods: [{ provider_id: 'credential' }],
      passkeys: [{ name: 'Laptop', device_type: 'singleDevice' }],
      auditEventsAsActor: [{ action: 'integration.create', ip: '203.0.113.9' }],
    });

    // Credentials and anything that belongs to someone else never appear anywhere in the body.
    for (const forbidden of [
      'secret-token-alice',
      'hash-value-do-not-leak',
      'oauth-token-do-not-leak',
      'public-key-do-not-leak',
      'cred-alice',
      'int-secret',
      'private/repo',
      'bob@example.test',
      'BobAgent',
      '198.51.100.1',
      'third.party@example.test',
      'solo@example.test',
    ])
      expect(text, forbidden).not.toContain(forbidden);
  });

  it('exports invitations the person sent without the invitee address', async () => {
    const res = await call('/api/workspace/me/data-export', { as: 'bob' });
    const body = await res.json<{ invitationsSent: Array<Record<string, unknown>> }>();
    expect(body.invitationsSent).toEqual([
      { workspace_id: 'org-shared', role: 'member', status: 'pending', expires_at: 9, created_at: 1 },
    ]);
  });

  it('refuses a request the browser marks as cross-site (L2), but not same-origin or typed-in', async () => {
    for (const site of ['cross-site', 'same-site'])
      expect(
        (await call('/api/workspace/me/data-export', { as: 'alice', headers: { 'sec-fetch-site': site } }))
          .status,
        site,
      ).toBe(403);
    for (const site of ['same-origin', 'none'])
      expect(
        (await call('/api/workspace/me/data-export', { as: 'alice', headers: { 'sec-fetch-site': site } }))
          .status,
        site,
      ).toBe(200);
  });

  it('is audited and rate limited', async () => {
    for (let i = 0; i < 5; i++)
      expect((await call('/api/workspace/me/data-export', { as: 'alice' })).status).toBe(200);
    const limited = await call('/api/workspace/me/data-export', { as: 'alice' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect(
      count("SELECT COUNT(*) AS n FROM audit_events WHERE action='account.export' AND actor_id='alice'"),
    ).toBe(5);
    // Another person's budget is separate.
    expect((await call('/api/workspace/me/data-export', { as: 'bob' })).status).toBe(200);
  });
});

describe('DELETE /api/workspace/me', () => {
  const erase = (as: string, confirm: unknown, origin?: string | null) =>
    call('/api/workspace/me', {
      as,
      method: 'DELETE',
      body: { confirm },
      ...(origin !== undefined && { origin }),
    });

  it('requires a session, a same-origin request and the typed email', async () => {
    expect((await call('/api/workspace/me', { method: 'DELETE', body: {}, origin: null })).status).toBe(403);
    expect((await erase('alice', 'alice@example.test', 'https://evil.test')).status).toBe(403);
    expect((await call('/api/workspace/me', { method: 'DELETE', body: {}, origin: ORIGIN })).status).toBe(
      401,
    );
    expect((await erase('alice', 'wrong@example.test')).status).toBe(422);
    expect((await erase('alice', undefined)).status).toBe(422);
    expect(count('SELECT COUNT(*) AS n FROM "user" WHERE id=?', 'alice')).toBe(1);
  });

  it('refuses while the person is the only admin, and names the way out', async () => {
    const res = await erase('solo', 'solo@example.test');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      blockers: [{ workspaceId: 'org-solo', action: 'delete_workspace', otherMembers: 0 }],
    });

    join('alice', 'org-solo', 'member');
    const again = await erase('solo', 'solo@example.test');
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({
      blockers: [{ workspaceId: 'org-solo', action: 'transfer_admin_role', otherMembers: 1 }],
    });
    expect(count('SELECT COUNT(*) AS n FROM "user" WHERE id=?', 'solo')).toBe(1);
  });

  it('lets an admin go once another admin exists', async () => {
    join('alice', 'org-solo', 'admin');
    expect((await erase('solo', 'solo@example.test')).status).toBe(200);
    expect(count('SELECT COUNT(*) AS n FROM member WHERE organization_id=?', 'org-solo')).toBe(1);
  });

  it("erases the person and leaves the workspace and everyone else's data intact", async () => {
    const res = await erase('alice', 'Alice@Example.test');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(res.headers.get('clear-site-data')).toBe('"cookies"');

    expect(count('SELECT COUNT(*) AS n FROM "user" WHERE id=?', 'alice')).toBe(0);
    for (const table of ['"session"', '"account"', 'passkey', 'member'])
      expect(count(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`, 'alice'), table).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM invitation WHERE lower(email)='alice@example.test'")).toBe(0);

    // The workspace, its other member and everything of theirs survive.
    expect(count('SELECT COUNT(*) AS n FROM organization WHERE id=?', 'org-shared')).toBe(1);
    expect(
      count('SELECT COUNT(*) AS n FROM member WHERE organization_id=? AND user_id=?', 'org-shared', 'bob'),
    ).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM "user" WHERE id IN (?,?)', 'bob', 'solo')).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM audit_events WHERE id='ev-bob'")).toBe(1);

    // Audit rows are kept (append-only) and the erasure itself is recorded against the workspace.
    expect(count("SELECT COUNT(*) AS n FROM audit_events WHERE id='ev-alice'")).toBe(1);
    expect(
      count(
        "SELECT COUNT(*) AS n FROM audit_events WHERE action='account.delete' AND organization_id='org-shared'",
      ),
    ).toBe(1);
  });

  it('removes the person from every store the retention matrix names account erasure for', async () => {
    db.raw
      .prepare(
        "INSERT INTO github_auth_states(state_hash,purpose,organization_id,user_id,expires_at) VALUES('h','install','org-shared','alice',9)",
      )
      .run();
    expect((await erase('alice', 'alice@example.test')).status).toBe(200);
    const claimed = RETENTION_MATRIX.filter((r) => r.deletion.some((d) => d.kind === 'account_erasure')).map(
      (r) => r.table,
    );
    expect(new Set(claimed)).toEqual(
      new Set(['user', 'session', 'account', 'passkey', 'member', 'invitation', 'github_auth_states']),
    );
    expect(count('SELECT COUNT(*) AS n FROM github_auth_states WHERE user_id=?', 'alice')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM passkey WHERE user_id=?', 'alice')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM "account" WHERE user_id=?', 'alice')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM "session" WHERE user_id=?', 'alice')).toBe(0);
  });

  it('keeps pending invitations an erased admin sent, handing them to another admin (M1)', async () => {
    join('alice', 'org-solo', 'admin');
    join('solo', 'org-shared', 'member');
    db.raw
      .prepare(
        `INSERT INTO invitation(id,organization_id,email,role,status,expires_at,inviter_id,created_at)
         VALUES('inv-by-solo','org-solo','invitee@example.test','member','pending',9,'solo',1),
               ('inv-accepted','org-solo','old@example.test','member','accepted',9,'solo',1)`,
      )
      .run();
    expect((await erase('solo', 'solo@example.test')).status).toBe(200);
    // The invitee can still accept: the row survives, now owned by the remaining admin.
    expect(
      db.raw.prepare("SELECT inviter_id FROM invitation WHERE id='inv-by-solo'").get() as {
        inviter_id: string;
      },
    ).toEqual({ inviter_id: 'alice' });
    // History that is not pending is not kept, and invitations from other people are untouched.
    expect(count("SELECT COUNT(*) AS n FROM invitation WHERE id='inv-accepted'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM invitation WHERE id='inv-sent'")).toBe(1);
  });

  it('deletes invitations addressed to the erased email, whoever sent them', async () => {
    expect((await erase('alice', 'alice@example.test')).status).toBe(200);
    expect(count("SELECT COUNT(*) AS n FROM invitation WHERE id='inv-to-alice'")).toBe(0);
  });

  it('refuses a stale session with reauth_required and changes nothing (H1)', async () => {
    const res = await call('/api/workspace/me', {
      as: 'alice',
      method: 'DELETE',
      body: { confirm: 'alice@example.test' },
      ageMs: 11 * 60 * 1000,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'reauth_required' });
    expect(count('SELECT COUNT(*) AS n FROM "user" WHERE id=?', 'alice')).toBe(1);
    expect(sent).toEqual([]);
    // A session from a few minutes ago is fresh enough.
    const ok = await call('/api/workspace/me', {
      as: 'alice',
      method: 'DELETE',
      body: { confirm: 'alice@example.test' },
      ageMs: 9 * 60 * 1000,
    });
    expect(ok.status).toBe(200);
  });

  it('does not burn erasure attempts on a stale session', async () => {
    for (let i = 0; i < 6; i++)
      expect(
        (
          await call('/api/workspace/me', {
            as: 'alice',
            method: 'DELETE',
            body: { confirm: 'x' },
            ageMs: 5e9,
          })
        ).status,
      ).toBe(403);
    expect((await erase('alice', 'alice@example.test')).status).toBe(200);
  });

  it('sends the address on file a notice before deleting, and still deletes if the send fails', async () => {
    expect((await erase('alice', 'alice@example.test')).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'alice@example.test' });
    expect(sent[0]?.text).not.toMatch(/https?:\/\/\S*(token|reset|verify)/i);
  });

  it('is not refused by a failing mail send', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    env = {
      ...env,
      AUTH_EMAIL: { send: () => Promise.reject(new Error('mail down')) },
    };
    expect((await erase('alice', 'alice@example.test')).status).toBe(200);
    expect(count('SELECT COUNT(*) AS n FROM "user" WHERE id=?', 'alice')).toBe(0);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('account_deletion_notice_failed');
    warn.mockRestore();
  });

  it('writes the erasure audit row without IP address or user agent (L5)', async () => {
    expect((await erase('alice', 'alice@example.test')).status).toBe(200);
    expect(
      db.raw.prepare("SELECT ip, user_agent FROM audit_events WHERE action='account.delete'").get(),
    ).toEqual({ ip: null, user_agent: null });
  });

  it('answers 409 only for the last-admin trigger, when a second admin disappears mid-request (M2)', async () => {
    join('alice', 'org-solo', 'admin'); // solo has a second admin, so the pre-check passes
    const real = db.d1;
    env = {
      ...env,
      DB: new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === 'batch')
            return (statements: D1PreparedStatement[]) => {
              // Between the pre-check and the batch, the other admin leaves.
              db.raw.exec("DELETE FROM member WHERE id='m-alice-org-solo'");
              return target.batch(statements);
            };
          return Reflect.get(target, prop, receiver) as unknown;
        },
      }),
    };
    const res = await erase('solo', 'solo@example.test');
    expect(res.status).toBe(409);
    expect(count('SELECT COUNT(*) AS n FROM "user" WHERE id=?', 'solo')).toBe(1);
  });

  it('answers 500, not 409, for any other database fault, and logs it (M2)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    env = {
      ...env,
      DB: new Proxy(db.d1, {
        get(target, prop, receiver) {
          if (prop === 'batch') return () => Promise.reject(new Error('D1_ERROR: disk on fire'));
          return Reflect.get(target, prop, receiver) as unknown;
        },
      }),
    };
    expect((await erase('alice', 'alice@example.test')).status).toBe(500);
    expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toContain('account_erase_failed');
    expect(count('SELECT COUNT(*) AS n FROM "user" WHERE id=?', 'alice')).toBe(1);
    error.mockRestore();
  });

  it('is rate limited', async () => {
    for (let i = 0; i < 5; i++) expect((await erase('alice', 'wrong')).status).toBe(422);
    expect((await erase('alice', 'alice@example.test')).status).toBe(429);
    expect(count('SELECT COUNT(*) AS n FROM "user" WHERE id=?', 'alice')).toBe(1);
  });
});
