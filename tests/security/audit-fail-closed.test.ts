import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOT_ENV } from '../support/boot-env';
import type { Bindings } from '../../src/env';
import { destroyIntegrationKey } from '../../src/pipeline/credential-destroy';
import { purgeDueWorkspace } from '../../src/pipeline/purge';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

/**
 * An audit failure fails the action (F236 errors table, F222 "there is no unaudited write path"; ADR 0055).
 *
 * For every destructive or security-relevant change our own code makes, the audit row is a statement in
 * the SAME D1 batch as the change, so a failed audit insert rolls the change back. Each test below makes
 * the audit insert for one action fail (a trigger that aborts it, as a full or failing audit store would)
 * and asserts the change did not happen. The inventory at the end lists every audit write site in `src/`,
 * with how it fails, so a new site fails this file until it is classified.
 *
 * Out of scope, and said so: the rows Better Auth's own routes produce (member removal, role change,
 * invitation create/accept/reject, password reset session revocation) are written by an `after` hook,
 * after Better Auth has committed its change (REMAINING 2.3; `src/auth/audit-hooks.ts`).
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
                // Signed in just now, so the account erasure's step-up check passes.
                session: { id: `sess-${id}`, activeOrganizationId: null, createdAt: new Date() },
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
const SLACK = 'https://hooks.slack.com/services/T000/B000/FixtureTokenPath';
const SLACK_NEW = 'https://hooks.slack.com/services/T000/B000/OtherFixturePath';
let db: FakeD1;
let env: Bindings;

async function call(method: string, path: string, as: string, body?: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { 'x-test-user': as, origin: ORIGIN, 'content-type': 'application/json' },
      body: body === undefined ? null : JSON.stringify(body),
    }),
    env,
    { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
  );
}

const one = <T>(sql: string, ...params: string[]): T => db.raw.prepare(sql).get(...params) as T;
const count = (sql: string, ...params: string[]): number => one<{ n: number }>(sql, ...params).n;
const audits = (action: string): number =>
  count('SELECT COUNT(*) AS n FROM audit_events WHERE action=?', action);

/** Make every audit insert for `action` fail, the way a failing audit store would. */
function failAudit(action: string): void {
  db.raw.exec(
    `CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events WHEN NEW.action='${action}'
     BEGIN SELECT RAISE(ABORT,'audit store unavailable'); END`,
  );
}

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

function session(id: string, userId: string): void {
  db.raw
    .prepare('INSERT INTO "session"(id,user_id,token,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(id, userId, `t-${id}`, Date.now() + 86_400_000, Date.now(), Date.now());
}

async function createIntegration(): Promise<string> {
  const res = await call('POST', '/api/integrations', 'alice', {
    name: 'Alerts',
    repo: 'acme/web',
    eventTypes: ['issues.opened'],
    destination: 'slack',
    webhookUrl: SLACK,
  });
  expect(res.status).toBe(201);
  return (await res.json<{ integration: { id: string } }>()).integration.id;
}

async function createSource(): Promise<string> {
  const res = await call('POST', '/api/sources', 'alice', { name: 'CI pipeline' });
  expect(res.status).toBe(201);
  return (await res.json<{ source: { id: string } }>()).source.id;
}

interface IntegrationState {
  enabled: number;
  quarantined: string | null;
  fingerprint: string | null;
  dek: number;
}
const integrationState = (id: string): IntegrationState | undefined =>
  db.raw
    .prepare(
      `SELECT enabled, credentials_quarantine_reason AS quarantined, credential_fingerprint AS fingerprint,
         (dek_wrapped IS NOT NULL) AS dek
       FROM integrations WHERE id=?`,
    )
    .get(id) as IntegrationState | undefined;

beforeEach(() => {
  db = createFakeD1();
  seedOrganization(db.raw, 'org-a');
  for (const id of ['alice', 'bob']) user(id);
  member('alice', 'org-a', 'admin');
  member('bob', 'org-a', 'member');
  // An integration's repository must be covered by the workspace's GitHub installation.
  db.raw
    .prepare(
      `INSERT INTO github_installations(id,organization_id,installation_id,app_id,account_login,account_type,repository_selection)
       VALUES('gi-1','org-a','1','1','acme','Organization','all')`,
    )
    .run();
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
    FINGERPRINT_KEY: '22'.repeat(32),
    GITHUB_APP_ID: '1',
  } as unknown as Bindings;
});

afterEach(() => vi.restoreAllMocks());

describe('integrations', () => {
  it('delete: the integration and its routing rows stay', async () => {
    const id = await createIntegration();
    failAudit('integration.delete');
    expect((await call('DELETE', `/api/integrations/${id}`, 'alice')).status).toBeGreaterThanOrEqual(500);
    expect(integrationState(id)).toBeDefined();
    expect(audits('integration.delete')).toBe(0);
  });

  it('pause (PATCH enabled=false): it stays on', async () => {
    const id = await createIntegration();
    failAudit('integration.update');
    const res = await call('PATCH', `/api/integrations/${id}`, 'alice', { enabled: false });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(integrationState(id)?.enabled).toBe(1);
  });

  it('credential rotation: the stored credential is unchanged', async () => {
    const id = await createIntegration();
    const before = integrationState(id);
    failAudit('integration.credentials.rotate');
    const res = await call('PATCH', `/api/integrations/${id}`, 'alice', { webhookUrl: SLACK_NEW });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(integrationState(id)).toEqual(before);
  });

  it('credential revoke: not quarantined, key not destroyed', async () => {
    const id = await createIntegration();
    failAudit('integration.credentials.revoke');
    const res = await call('POST', `/api/integrations/${id}/revoke-credentials`, 'alice', {
      reason: 'compromised',
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(integrationState(id)).toMatchObject({ quarantined: null, dek: 1 });
  });

  it('key destruction after a revoke: the wrapped key is not wiped', async () => {
    const id = await createIntegration();
    // The revoke itself is audited and committed; the inline destroy then fails on its audit row.
    failAudit('integration.key_destroyed');
    const res = await call('POST', `/api/integrations/${id}/revoke-credentials`, 'alice', {});
    expect(res.status).toBe(200);
    expect(integrationState(id)).toMatchObject({ quarantined: 'revoked', dek: 1 });
    // The scheduled sweep's path, called directly: it throws and wipes nothing.
    await expect(
      destroyIntegrationKey(db.d1, 'org-a', id, Date.now(), { actorId: null, trigger: 'sweep' }),
    ).rejects.toThrow();
    expect(integrationState(id)).toMatchObject({ dek: 1 });
    expect(audits('integration.key_destroyed')).toBe(0);
  });
});

describe('sources', () => {
  const sourceState = (id: string) =>
    db.raw
      .prepare('SELECT enabled, credentials_revoked_at AS revoked, key_salt AS salt FROM sources WHERE id=?')
      .get(id) as { enabled: number; revoked: string | null; salt: Uint8Array } | undefined;

  it('delete: the source stays', async () => {
    const id = await createSource();
    failAudit('source.delete');
    expect((await call('DELETE', `/api/sources/${id}`, 'alice')).status).toBeGreaterThanOrEqual(500);
    expect(sourceState(id)).toBeDefined();
  });

  it('credential revoke: still enabled and not revoked', async () => {
    const id = await createSource();
    failAudit('source.credentials.revoke');
    const res = await call('POST', `/api/sources/${id}/revoke-credentials`, 'alice', {});
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(sourceState(id)).toMatchObject({ enabled: 1, revoked: null });
  });

  it('secret rotation: the stored secret is unchanged', async () => {
    const id = await createSource();
    const before = sourceState(id);
    failAudit('source.secret.rotate');
    const res = await call('POST', `/api/sources/${id}/rotate`, 'alice', {});
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(sourceState(id)).toEqual(before);
  });
});

describe('sessions', () => {
  const alive = (id: string) => count('SELECT COUNT(*) AS n FROM "session" WHERE id=?', id);

  it('revoking one session: it stays signed in', async () => {
    session('sess-alice', 'alice');
    session('phone', 'alice');
    failAudit('session.revoke');
    const res = await call('POST', '/api/workspace/me/sessions/phone/revoke', 'alice');
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(alive('phone')).toBe(1);
  });

  it('revoking the others: they all stay signed in', async () => {
    session('sess-alice', 'alice');
    session('phone', 'alice');
    session('tablet', 'alice');
    failAudit('session.revoke_others');
    const res = await call('POST', '/api/workspace/me/sessions/revoke-others', 'alice');
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(alive('phone') + alive('tablet')).toBe(2);
  });
});

describe('account and workspace', () => {
  it('account erasure: the person, their membership and sessions stay', async () => {
    session('sess-bob', 'bob');
    failAudit('account.delete');
    const res = await call('DELETE', '/api/workspace/me', 'bob', { confirm: 'bob@example.test' });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('Nothing was deleted') });
    expect(count('SELECT COUNT(*) AS n FROM "user" WHERE id=?', 'bob')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM member WHERE user_id=?', 'bob')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM "session" WHERE user_id=?', 'bob')).toBe(1);
  });

  it('workspace deletion request: nothing is scheduled and every integration stays on', async () => {
    const id = await createIntegration();
    failAudit('workspace.deletion.request');
    const res = await call('POST', '/api/workspace/deletion', 'alice', { confirm: 'org-a' });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(count('SELECT COUNT(*) AS n FROM workspace_deletions')).toBe(0);
    expect(integrationState(id)?.enabled).toBe(1);
    // Once the audit store is back the same request works, and the row records the exact count.
    db.raw.exec('DROP TRIGGER fail_audit');
    expect((await call('POST', '/api/workspace/deletion', 'alice', { confirm: 'org-a' })).status).toBe(202);
    expect(integrationState(id)?.enabled).toBe(0);
    const row = one<{ m: string }>(
      "SELECT metadata_json AS m FROM audit_events WHERE action='workspace.deletion.request'",
    );
    expect(JSON.parse(row.m)).toMatchObject({ disabledIntegrations: 1 });
  });

  it('cancelling a deletion: it stays scheduled and the integrations stay off', async () => {
    const id = await createIntegration();
    expect((await call('POST', '/api/workspace/deletion', 'alice', { confirm: 'org-a' })).status).toBe(202);
    failAudit('workspace.deletion.cancel');
    expect((await call('DELETE', '/api/workspace/deletion', 'alice')).status).toBeGreaterThanOrEqual(500);
    expect(
      count('SELECT COUNT(*) AS n FROM workspace_deletions WHERE cancelled_at IS NULL AND purged_at IS NULL'),
    ).toBe(1);
    expect(integrationState(id)?.enabled).toBe(0);
    db.raw.exec('DROP TRIGGER fail_audit');
    const cancelled = await call('DELETE', '/api/workspace/deletion', 'alice');
    expect(await cancelled.json()).toEqual({ scheduled: false, restoredIntegrations: 1 });
    expect(integrationState(id)?.enabled).toBe(1);
    const row = one<{ m: string }>(
      "SELECT metadata_json AS m FROM audit_events WHERE action='workspace.deletion.cancel'",
    );
    expect(JSON.parse(row.m)).toMatchObject({ restoredIntegrations: 1 });
  });

  it('the final purge step: the organization row stays until its row can be written', async () => {
    await call('POST', '/api/workspace/deletion', 'alice', { confirm: 'org-a' });
    failAudit('workspace.purged');
    await expect(purgeDueWorkspace(db.d1, Date.now() + 8 * 86_400_000)).rejects.toThrow();
    expect(count('SELECT COUNT(*) AS n FROM organization WHERE id=?', 'org-a')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM workspace_deletions WHERE purged_at IS NOT NULL')).toBe(0);
  });

  it('workspace export: no file is answered when the export cannot be recorded', async () => {
    await createIntegration();
    failAudit('workspace.export');
    const res = await call('GET', '/api/workspace/export', 'alice');
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await res.text()).not.toContain('lumi-noti-export');
  });

  it('account export: no file is answered when the export cannot be recorded', async () => {
    failAudit('account.export');
    const res = await call('GET', '/api/workspace/me/data-export', 'alice');
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await res.text()).not.toContain('lumi-noti-account-export');
  });
});

// ---------------------------------------------------------------------------
// Inventory: every audit write site in src/, and how an audit failure behaves there
// ---------------------------------------------------------------------------

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WRITE_CALL = /\b(?:recordAudit|auditStatement|recordDenial)\(|INSERT INTO audit_events\b/g;

/**
 * How each file's audit writes behave when the write fails. `batch`: in the same D1 batch as the change,
 * proven above or in the named test. `before`: written before anything is changed or returned, so a failure
 * stops the action. `denial` and `best-effort`: a record of a refusal or a follow-up count, which never
 * changes the answer (a denial that turned a 404 into a 500 would itself leak). `out-of-scope`: Better Auth.
 */
const SITES: Readonly<Record<string, { readonly count: number; readonly how: string }>> = {
  'src/api/integrations.ts': { count: 1, how: 'batch: create, update/pause, rotate, revoke, delete (above)' },
  'src/api/sources.ts': { count: 1, how: 'batch: create, update, rotate, revoke, delete (above)' },
  'src/api/sessions.ts': { count: 2, how: 'batch: revoke one, revoke the others (above)' },
  'src/api/account.ts': { count: 2, how: 'batch: erasure (above); before: export answered after its row' },
  'src/api/workspace-lifecycle.ts': {
    count: 3,
    how: 'batch: deletion request, cancel (above); before: export answered after its row',
  },
  'src/api/invitations.ts': {
    count: 2,
    how: 'batch: cancel (tests/api/invitations.test.ts); denial: refused cancel',
  },
  'src/api/deliveries.ts': {
    count: 2,
    how: 'before: bulk replay intent row before any replay (tests/api/delivery-depth.test.ts); best-effort: the counts row',
  },
  'src/delivery/redeliver.ts': { count: 1, how: 'batch: single replay (tests/api/deliveries.test.ts)' },
  'src/api/audit.ts': { count: 1, how: 'before: audit.read row before rows are read (ADR 0039)' },
  'src/api/test-send.ts': { count: 1, how: 'batch: test delivery and its row' },
  'src/api/github.ts': { count: 1, how: 'denial: bind refused' },
  'src/connectors/sources/github/install.ts': {
    count: 1,
    how: 'batch: installation bind (tests/github/install-flow.test.ts)',
  },
  'src/connectors/sources/github/lifecycle.ts': {
    count: 1,
    how: 'batch: lifecycle transitions (tests/github/install-flow.test.ts)',
  },
  'src/connectors/sources/github/route.ts': { count: 1, how: 'denial: repository out of scope' },
  'src/connectors/sources/github/probe.ts': { count: 2, how: 'denial: refused webhook probes' },
  'src/pipeline/consumer.ts': {
    count: 1,
    how: 'batch: Discord auto-pause (tests/pipeline/extended-destinations.test.ts)',
  },
  'src/pipeline/credential-destroy.ts': { count: 2, how: 'batch: key destruction (above)' },
  'src/pipeline/purge.ts': { count: 1, how: 'batch: final purge step (above)' },
  'src/auth/workspace.ts': { count: 3, how: 'denial: capability and membership refusals' },
  'src/auth/audit-hooks.ts': {
    count: 2,
    how: 'out-of-scope: Better Auth after-hook rows (REMAINING 2.3); denial',
  },
};

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? tsFiles(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('inventory of audit write sites', () => {
  it('lists every file that writes an audit row, with how a failed write behaves there', () => {
    const found: Record<string, number> = {};
    for (const file of tsFiles(join(root, 'src'))) {
      const path = relative(root, file).replaceAll('\\', '/');
      // The writer itself.
      if (path === 'src/audit/audit.ts') continue;
      const n = (readFileSync(file, 'utf8').match(WRITE_CALL) ?? []).length;
      if (n > 0) found[path] = n;
    }
    const listed = Object.fromEntries(Object.entries(SITES).map(([path, site]) => [path, site.count]));
    expect(found).toEqual(listed);
    for (const site of Object.values(SITES))
      expect(site.how).toMatch(/^(batch|before|denial|best-effort|out-of-scope)\b/);
  });
});
