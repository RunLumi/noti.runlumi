import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOT_ENV } from '../support/boot-env';
import type { Bindings } from '../../src/env';
import { PURGE_ROWS_PER_TICK, purgeDueWorkspace, TENANT_TABLES } from '../../src/pipeline/purge';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

/** Workspace export and two-phase deletion (F30), over the real migrations. */
vi.mock('../../src/auth/better-auth', () => ({
  createAuth: () => ({
    api: {
      getSession: ({ headers }: { headers: Headers }) => {
        const id = headers.get('x-test-user');
        return Promise.resolve(
          id
            ? {
                user: { id, email: `${id}@example.test`, emailVerified: true, name: id },
                session: { activeOrganizationId: null },
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
const SLACK = 'https://hooks.slack.com/services/T000/B000/SecretTokenPath';
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

async function call(method: string, path: string, as: string, body?: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { 'x-test-user': as, origin: ORIGIN, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
  );
}

async function createIntegration(as: string, name = 'Alerts'): Promise<string> {
  const res = await call('POST', '/api/integrations', as, {
    name,
    repo: 'acme/web',
    eventTypes: ['issues.opened'],
    destination: 'slack',
    webhookUrl: SLACK,
  });
  expect(res.status).toBe(201);
  return (await res.json<{ integration: { id: string } }>()).integration.id;
}

function enabledIds(org: string): string[] {
  return (
    db.raw
      .prepare('SELECT id FROM integrations WHERE organization_id=? AND enabled=1 ORDER BY id')
      .all(org) as {
      id: string;
    }[]
  ).map((r) => r.id);
}

function count(sql: string, ...params: string[]): number {
  return (db.raw.prepare(sql).get(...params) as { n: number }).n;
}

beforeEach(() => {
  db = createFakeD1();
  // The organization name is what an admin types to confirm deletion.
  seedOrganization(db.raw, 'org-a');
  seedOrganization(db.raw, 'org-b');
  for (const id of ['alice', 'bob', 'mallory']) user(id);
  member('alice', 'org-a', 'admin');
  member('bob', 'org-a', 'member');
  member('mallory', 'org-b', 'admin');
  for (const [org, inst] of [
    ['org-a', '1'],
    ['org-b', '2'],
  ] as const) {
    db.raw
      .prepare(
        `INSERT INTO github_installations(id,organization_id,installation_id,app_id,account_login,account_type,repository_selection)
         VALUES(?,?,?,?,?,?,?)`,
      )
      .run(`gi-${inst}`, org, inst, '1', 'acme', 'Organization', 'all');
  }
  env = {
    ...BOOT_ENV,
    DB: db.d1,
    APP_ORIGIN: ORIGIN,
    KEK_V1: '11'.repeat(32),
    KEK_V2: '',
    KMS_ACTIVE_VERSION: '1',
    ENVIRONMENT_NAME: 'staging',
    KEK_CHECK_V1: '4464ea2121d3a99ebd188370f1ef6cd0',
    ENCRYPTION_KEY: '',
    GITHUB_APP_ID: '1',
  } as unknown as Bindings;
});

afterEach(() => vi.unstubAllGlobals());

describe('workspace deletion', () => {
  it('is admin only', async () => {
    expect((await call('POST', '/api/workspace/deletion', 'bob', { confirm: 'org-a' })).status).toBe(403);
    expect((await call('GET', '/api/workspace/export', 'bob')).status).toBe(403);
  });

  it('requires typing the workspace name', async () => {
    expect((await call('POST', '/api/workspace/deletion', 'alice', { confirm: 'org' })).status).toBe(422);
    expect((await call('POST', '/api/workspace/deletion', 'alice')).status).toBe(422);
  });

  it('soft-stops the workspace at once and blocks new work', async () => {
    const a = await createIntegration('alice');
    await createIntegration('mallory');
    const res = await call('POST', '/api/workspace/deletion', 'alice', { confirm: 'org-a' });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ scheduled: true, purgeStarted: false });

    expect(enabledIds('org-a')).toEqual([]);
    expect(enabledIds('org-b')).toHaveLength(1);
    expect((await call('POST', '/api/integrations', 'alice', {})).status).toBe(409);
    expect((await call('PATCH', `/api/integrations/${a}`, 'alice', { enabled: true })).status).toBe(409);
    expect((await call('POST', '/api/workspace/deletion', 'alice', { confirm: 'org-a' })).status).toBe(409);
  });

  it('cancelling restores exactly the integrations that were enabled', async () => {
    const on = await createIntegration('alice', 'On');
    const off = await createIntegration('alice', 'Off');
    await call('PATCH', `/api/integrations/${off}`, 'alice', { enabled: false });
    await call('POST', '/api/workspace/deletion', 'alice', { confirm: 'org-a' });

    expect((await call('DELETE', '/api/workspace/deletion', 'alice')).status).toBe(200);
    expect(enabledIds('org-a')).toEqual([on]);
    expect(await (await call('GET', '/api/workspace/deletion', 'alice')).json()).toEqual({
      scheduled: false,
    });
  });

  it('purges every tenant row and the organization after the window, leaving other tenants alone', async () => {
    await createIntegration('alice');
    await createIntegration('mallory');
    db.raw
      .prepare(
        "INSERT INTO deliveries(id,integration_id,organization_id,state) VALUES('d1','x','org-a','pending')",
      )
      .run();
    await call('POST', '/api/workspace/deletion', 'alice', { confirm: 'org-a' });

    expect((await purgeDueWorkspace(db.d1, Date.now())).organizationId).toBeNull();
    const report = await purgeDueWorkspace(db.d1, Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(report).toMatchObject({ organizationId: 'org-a', completed: true });

    for (const table of [
      'integrations',
      'deliveries',
      'notification_outbox',
      'github_installations',
      'audit_events',
      'member',
    ])
      expect(count(`SELECT COUNT(*) AS n FROM ${table} WHERE organization_id=?`, 'org-a')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM organization WHERE id=?', 'org-a')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM integrations WHERE organization_id=?', 'org-b')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM member WHERE organization_id=?', 'org-b')).toBe(1);
    // The ledger outlives the organization as evidence of the purge.
    expect(count('SELECT COUNT(*) AS n FROM workspace_deletions WHERE purged_at IS NOT NULL')).toBe(1);
  });

  it('purges in bounded, resumable ticks', async () => {
    const insert = db.raw.prepare(
      "INSERT INTO deliveries(id,integration_id,organization_id,state) VALUES(?,'x','org-a','pending')",
    );
    for (let i = 0; i < PURGE_ROWS_PER_TICK * 2 + 10; i++) insert.run(`d${i}`);
    await call('POST', '/api/workspace/deletion', 'alice', { confirm: 'org-a' });
    const later = Date.now() + 8 * 24 * 60 * 60 * 1000;

    const ticks: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await purgeDueWorkspace(db.d1, later);
      if (!r.organizationId) break;
      ticks.push(r.completed);
    }
    expect(ticks).toEqual([false, false, true]);
    expect(count('SELECT COUNT(*) AS n FROM deliveries')).toBe(0);
  });

  it('cannot be cancelled once the purge has started', async () => {
    const insert = db.raw.prepare(
      "INSERT INTO deliveries(id,integration_id,organization_id,state) VALUES(?,'x','org-a','pending')",
    );
    for (let i = 0; i < PURGE_ROWS_PER_TICK + 1; i++) insert.run(`d${i}`);
    await call('POST', '/api/workspace/deletion', 'alice', { confirm: 'org-a' });
    await purgeDueWorkspace(db.d1, Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect((await call('DELETE', '/api/workspace/deletion', 'alice')).status).toBe(409);
  });

  it('a cancel that lands before the purge claims the row means nothing is deleted', async () => {
    const id = await createIntegration('alice');
    await call('POST', '/api/workspace/deletion', 'alice', { confirm: 'org-a' });
    await call('DELETE', '/api/workspace/deletion', 'alice');
    const report = await purgeDueWorkspace(db.d1, Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(report.organizationId).toBeNull();
    expect(enabledIds('org-a')).toEqual([id]);
  });

  it('a second request while one is pending cannot overwrite the restore snapshot', async () => {
    const id = await createIntegration('alice');
    await call('POST', '/api/workspace/deletion', 'alice', { confirm: 'org-a' });
    expect((await call('POST', '/api/workspace/deletion', 'alice', { confirm: 'org-a' })).status).toBe(409);
    await call('DELETE', '/api/workspace/deletion', 'alice');
    expect(enabledIds('org-a')).toEqual([id]);
  });

  it('can be requested again after a cancel', async () => {
    await createIntegration('alice');
    await call('POST', '/api/workspace/deletion', 'alice', { confirm: 'org-a' });
    await call('DELETE', '/api/workspace/deletion', 'alice');
    expect((await call('POST', '/api/workspace/deletion', 'alice', { confirm: 'org-a' })).status).toBe(202);
    expect(enabledIds('org-a')).toEqual([]);
  });

  it('blocks deleting an integration while the workspace deletion is pending', async () => {
    const id = await createIntegration('alice');
    await call('POST', '/api/workspace/deletion', 'alice', { confirm: 'org-a' });
    expect((await call('DELETE', `/api/integrations/${id}`, 'alice')).status).toBe(409);
  });

  it('drains a large audit log in bounded ticks and records the purge with no organization', async () => {
    const insert = db.raw.prepare(
      "INSERT INTO audit_events(id,organization_id,action,subject_type,outcome) VALUES(?,'org-a','access.denied','organization','denied')",
    );
    for (let i = 0; i < PURGE_ROWS_PER_TICK + 50; i++) insert.run(`a${i}`);
    await call('POST', '/api/workspace/deletion', 'alice', { confirm: 'org-a' });
    const later = Date.now() + 8 * 24 * 60 * 60 * 1000;
    expect((await purgeDueWorkspace(db.d1, later)).completed).toBe(false);
    expect((await purgeDueWorkspace(db.d1, later)).completed).toBe(true);
    expect(count("SELECT COUNT(*) AS n FROM audit_events WHERE organization_id='org-a'")).toBe(0);
    expect(
      count(
        "SELECT COUNT(*) AS n FROM audit_events WHERE action='workspace.purged' AND organization_id IS NULL AND subject_id='org-a'",
      ),
    ).toBe(1);
  });

  it('still protects the last admin outside a purge', () => {
    expect(() => db.raw.exec("DELETE FROM member WHERE user_id='alice'")).toThrow(/requires an admin/);
  });
});

describe('purge coverage', () => {
  it('covers every table that holds workspace data, now and in future migrations', () => {
    // A table with organization_id must either cascade from organization or be purged
    // explicitly; workspace_deletions is the ledger and is meant to survive.
    const tables = (
      db.raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    const uncovered = tables.filter((table) => {
      const columns = db.raw.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
      if (!columns.some((c) => c.name === 'organization_id')) return false;
      const fks = db.raw.prepare(`PRAGMA foreign_key_list("${table}")`).all() as {
        table: string;
        from: string;
        on_delete: string;
      }[];
      const cascades = fks.some(
        (f) => f.table === 'organization' && f.from === 'organization_id' && f.on_delete === 'CASCADE',
      );
      return (
        !cascades && !(TENANT_TABLES as readonly string[]).includes(table) && table !== 'workspace_deletions'
      );
    });
    expect(uncovered).toEqual([]);
  });
});

describe('workspace export', () => {
  it('exports workspace data with no credential material', async () => {
    await createIntegration('alice');
    const res = await call('GET', '/api/workspace/export', 'alice');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    const text = await res.text();
    expect(text).not.toMatch(/SecretTokenPath|envelope|dek_wrapped|key_salt|ciphertext/);
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body).toMatchObject({ format: 'lumi-noti-export/v1', credentialsIncluded: false });
    expect(body.integrations).toHaveLength(1);
    expect(body.members).toHaveLength(2);
  });

  it('flags truncated tables and exports the most recent rows', async () => {
    const insert = db.raw.prepare(
      "INSERT INTO deliveries(id,integration_id,organization_id,state,updated_at) VALUES(?,'x','org-a','sent',?)",
    );
    for (let i = 0; i < 2001; i++) insert.run(`d${i}`, `2026-01-01 00:${String(i % 60).padStart(2, '0')}:00`);
    const body = await (
      await call('GET', '/api/workspace/export', 'alice')
    ).json<{
      deliveries: unknown[];
      truncated: { deliveries: boolean; auditEvents: boolean };
    }>();
    expect(body.deliveries).toHaveLength(2000);
    expect(body.truncated).toEqual({ deliveries: true, auditEvents: false });
  });

  it('exports only the caller’s workspace', async () => {
    await createIntegration('mallory');
    const body = await (
      await call('GET', '/api/workspace/export', 'alice')
    ).json<{ integrations: unknown[] }>();
    expect(body.integrations).toHaveLength(0);
  });
});
